import { createHash, randomUUID } from 'node:crypto';
import type { AppDatabase } from '../database/database';
import { redactSecrets } from '../logger';
import { formatSecurityError, recordSecurityRejection } from '../security-events';
import type {
  JobExpediteRequest,
  JobExpediteResult,
  JobRecord,
  JobRetryCapability,
  JobRetryOutcome,
  JobRetryRequest,
  JobRetryResultCode,
  JobRetryResult,
  JobState
} from '@shared/types';

export interface JobStartOptions {
  resourceKey?: string;
  resourceTtlMs?: number;
  resourceRetryMs?: number;
}

export type JobStartResult =
  | { state: 'started' }
  | { state: 'deferred'; reason: 'resource_busy'; resourceKey: string; retryAt: string };

export class JobResourceBusyError extends Error {
  constructor(
    readonly resourceKey: string,
    readonly retryAt: string,
    message = 'Final render capacity is busy; this render remains queued and can be retried safely.'
  ) {
    super(message);
    this.name = 'JobResourceBusyError';
  }
}

type JobRow = Record<string, unknown> & {
  id: string;
  project_id: string | null;
  type: string;
  state: JobState;
  input_json: string;
  input_hash: string;
  attempt: number;
  max_attempts: number;
  manual_attempt_grants: number;
  transition_version: number;
  error: string | null;
};

type RetryReconciliation = {
  id: string;
  outcome: 'no_remote_effect' | 'remote_session_reused' | 'remote_effect_reused' | 'identity_mismatch';
  publicationId: string | null;
  videoId: string | null;
  safeToRun: boolean;
  message: string;
};

const SIDE_EFFECT_JOB_TYPES = new Set(['workflow_upload_private']);

type RetryDecisionOutcome = JobRetryOutcome | 'expedited';

interface RetryDecisionContract {
  code: JobRetryResultCode;
  recovery: string;
}

function retryDecisionContract(outcome: RetryDecisionOutcome): RetryDecisionContract {
  const contracts: Record<RetryDecisionOutcome, RetryDecisionContract> = {
    retry_started: {
      code: 'JOB_RETRY_STARTED',
      recovery: 'No recovery is required; monitor the newly queued attempt.'
    },
    expedited: {
      code: 'JOB_RETRY_EXPEDITED',
      recovery: 'No recovery is required; monitor the expedited attempt.'
    },
    already_scheduled: {
      code: 'JOB_RETRY_ALREADY_SCHEDULED',
      recovery: 'Wait for the scheduled retry or explicitly expedite it from the refreshed job view.'
    },
    invalid_state: {
      code: 'JOB_RETRY_INVALID_STATE',
      recovery: 'Refresh the job and use the action allowed for its current state.'
    },
    reconciliation_required: {
      code: 'JOB_RETRY_RECONCILIATION_REQUIRED',
      recovery: 'Resolve the persisted side-effect identity before attempting this job again.'
    },
    concurrent_change: {
      code: 'JOB_RETRY_CONCURRENT_CHANGE',
      recovery: 'Refresh the job, review its latest transition, and submit a new action.'
    }
  };
  return contracts[outcome];
}

function retryResultFields(outcome: RetryDecisionOutcome, message: string): RetryDecisionContract & { message: string } {
  const contract = retryDecisionContract(outcome);
  return {
    ...contract,
    message: outcome === 'retry_started' || outcome === 'expedited'
      ? message
      : formatSecurityError(contract.code, message, contract.recovery)
  };
}

function toJob(row: JobRow, retryCapability: JobRetryCapability): JobRecord {
  return {
    id: String(row.id),
    projectId: row.project_id ? String(row.project_id) : null,
    type: String(row.type),
    state: row.state as JobRecord['state'],
    progress: Number(row.progress),
    phase: row.phase ? String(row.phase) : null,
    attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts),
    manualAttemptGrants: Number(row.manual_attempt_grants),
    transitionVersion: Number(row.transition_version),
    availableAt: String(row.available_at),
    leaseUntil: row.lease_until ? String(row.lease_until) : null,
    error: row.error ? String(row.error) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    retryCapability
  };
}

export class JobService {
  private checkpointHandler: ((projectId: string) => void) | null = null;

  constructor(private readonly db: AppDatabase) {}

  setCheckpointHandler(handler: (projectId: string) => void): void {
    this.checkpointHandler = handler;
  }

  recoverInterrupted(): void {
    const now = new Date().toISOString();
    const currentOwner = `desktop-${process.pid}`;
    this.db.raw.transaction(() => {
      const interrupted = this.db.raw.prepare(`
        SELECT * FROM jobs
        WHERE state = 'RUNNING'
          AND (lease_owner IS NULL OR lease_owner <> ? OR lease_until IS NULL OR lease_until <= ?)
      `).all(currentOwner, now) as JobRow[];
      for (const job of interrupted) {
        let nextState: JobState = 'QUEUED';
        let phase = 'Recovered after restart';
        if (SIDE_EFFECT_JOB_TYPES.has(job.type)) {
          const reconciliation = this.reconcileSideEffect(job, 'startup_recovery', now);
          if (!reconciliation.safeToRun) {
            nextState = Number(job.attempt) < Number(job.max_attempts) ? 'FAILED_RETRYABLE' : 'FAILED_PERMANENT';
            phase = 'Remote side effect requires operator reconciliation';
          } else {
            phase = `Recovered after ${reconciliation.outcome.replaceAll('_', ' ')}`;
          }
        }
        const changed = this.db.raw.prepare(`
          UPDATE jobs SET state = ?, lease_owner = NULL, lease_until = NULL,
            phase = ?, transition_version = transition_version + 1, updated_at = ?
          WHERE id = ? AND state = 'RUNNING' AND transition_version = ?
        `).run(nextState, phase, now, job.id, job.transition_version);
        if (Number(changed.changes) === 1) this.releaseLocks(job.id, now);
      }
      this.db.raw.prepare(`
        UPDATE projects SET locked_by_job_id = NULL, updated_at = ?
        WHERE locked_by_job_id IN (SELECT id FROM jobs WHERE state <> 'RUNNING')
      `).run(now);
      this.db.raw.prepare(`
        DELETE FROM job_resource_leases
        WHERE lease_owner <> ? OR lease_until <= ?
          OR holder_job_id IN (SELECT id FROM jobs WHERE state <> 'RUNNING')
      `).run(currentOwner, now);
    })();
  }

  create(type: string, projectId: string | null, input: unknown, maxAttempts = 3): JobRecord {
    const now = new Date().toISOString();
    return this.createAvailable(type, projectId, input, maxAttempts, now, now);
  }

  schedule(
    type: string,
    projectId: string | null,
    input: unknown,
    availableAt: string,
    maxAttempts = 3
  ): JobRecord {
    const parsed = new Date(availableAt);
    if (!Number.isFinite(parsed.getTime())) throw new Error('A valid job availability time is required.');
    const now = new Date().toISOString();
    return this.createAvailable(type, projectId, input, maxAttempts, parsed.toISOString(), now);
  }

  reschedule(id: string, availableAt: string, phase: string): JobRecord {
    const parsed = new Date(availableAt);
    if (!Number.isFinite(parsed.getTime())) throw new Error('A valid job availability time is required.');
    const row = this.db.raw.prepare(`SELECT state, transition_version FROM jobs WHERE id = ?`).get(id) as
      | { state: JobRecord['state']; transition_version: number }
      | undefined;
    if (!row) throw new Error('Job not found.');
    if (!['QUEUED', 'READY', 'RETRY_SCHEDULED', 'WAITING_EXTERNAL'].includes(row.state)) {
      throw new Error(`Job ${id} cannot be rescheduled from ${row.state}.`);
    }
    const now = new Date().toISOString();
    return this.db.raw.transaction(() => {
      const changed = this.db.raw.prepare(`
        UPDATE jobs SET state = 'QUEUED', available_at = ?, phase = ?, error = NULL,
          lease_owner = NULL, lease_until = NULL, transition_version = transition_version + 1,
          updated_at = ? WHERE id = ? AND state = ? AND transition_version = ?
      `).run(parsed.toISOString(), phase, now, id, row.state, row.transition_version);
      if (Number(changed.changes) !== 1) throw new Error(`Job ${id} changed while it was being rescheduled.`);
      this.releaseLocks(id, now);
      return this.jobById(id);
    })();
  }

  private createAvailable(
    type: string,
    projectId: string | null,
    input: unknown,
    maxAttempts: number,
    availableAt: string,
    now: string
  ): JobRecord {
    const inputJson = JSON.stringify(input);
    const inputHash = createHash('sha256').update(`${type}|${projectId ?? ''}|${inputJson}`).digest('hex');
    const existing = this.db.raw.prepare(`
      SELECT * FROM jobs
      WHERE type = ? AND input_hash = ? AND state <> 'CANCELLED'
      ORDER BY created_at DESC LIMIT 1
    `).get(type, inputHash) as Record<string, unknown> | undefined;
    if (existing) return this.mapJob(existing as JobRow);

    const id = randomUUID();
    this.db.raw.prepare(`
      INSERT INTO jobs(
        id, project_id, type, state, progress, input_json, input_hash,
        attempt, max_attempts, available_at, created_at, updated_at
      ) VALUES(?, ?, ?, 'QUEUED', 0, ?, ?, 0, ?, ?, ?, ?)
    `).run(id, projectId, type, inputJson, inputHash, maxAttempts, availableAt, now, now);
    return this.jobById(id);
  }

  start(id: string, phase: string, options: JobStartOptions = {}): JobStartResult {
    const now = new Date();
    const nowIso = now.toISOString();
    const leaseOwner = `desktop-${process.pid}`;
    const lease = new Date(now.getTime() + (options.resourceTtlMs ?? 30 * 60_000)).toISOString();
    return this.db.raw.transaction((): JobStartResult => {
      const job = this.db.raw.prepare('SELECT project_id, type, state, available_at FROM jobs WHERE id = ?').get(id) as
        | { project_id: string | null; type: string; state: JobRecord['state']; available_at: string }
        | undefined;
      if (!job) throw new Error('Job not found.');
      if (!['QUEUED', 'READY', 'RETRY_SCHEDULED'].includes(job.state)) throw new Error(`Job ${id} cannot start from ${job.state}.`);
      if (job.available_at > nowIso) throw new Error('Job retry backoff has not elapsed.');
      const dependency = this.db.raw.prepare(`
        SELECT count(*) AS count FROM job_dependencies d
        JOIN jobs upstream ON upstream.id = d.depends_on_job_id
        WHERE d.job_id = ? AND upstream.state <> 'SUCCEEDED'
      `).get(id) as { count: number };
      if (dependency.count) throw new Error('Job dependencies have not succeeded.');
      if (options.resourceKey) {
        this.db.raw.prepare(`
          DELETE FROM job_resource_leases
          WHERE resource_key = ? AND (
            lease_until <= ?
            OR holder_job_id IN (SELECT id FROM jobs WHERE state <> 'RUNNING')
          )
        `).run(options.resourceKey, nowIso);
        const active = this.db.raw.prepare(`
          SELECT holder_job_id, lease_until FROM job_resource_leases WHERE resource_key = ?
        `).get(options.resourceKey) as { holder_job_id: string; lease_until: string } | undefined;
        if (active && active.holder_job_id !== id) {
          const retryAt = new Date(now.getTime() + (options.resourceRetryMs ?? 5_000)).toISOString();
          this.db.raw.prepare(`
            UPDATE jobs SET state = 'RETRY_SCHEDULED', available_at = ?,
              phase = ?, error = NULL, lease_owner = NULL, lease_until = NULL,
              transition_version = transition_version + 1, updated_at = ?
            WHERE id = ?
          `).run(retryAt, `Waiting for ${options.resourceKey} capacity`, nowIso, id);
          return { state: 'deferred', reason: 'resource_busy', resourceKey: options.resourceKey, retryAt };
        }
        this.db.raw.prepare(`
          INSERT INTO job_resource_leases(
            resource_key, holder_job_id, lease_owner, lease_until, acquired_at, metadata_json
          ) VALUES(?, ?, ?, ?, ?, ?)
        `).run(options.resourceKey, id, leaseOwner, lease, nowIso, JSON.stringify({ jobType: job.type }));
      }
      if (job.project_id) {
        const lock = this.db.raw.prepare(`
          UPDATE projects SET locked_by_job_id = ?, updated_at = ?
          WHERE id = ? AND (locked_by_job_id IS NULL OR locked_by_job_id = ?)
        `).run(id, nowIso, job.project_id, id);
        if (Number(lock.changes) !== 1) throw new Error('Project is locked by another state-mutating workflow.');
      }
      this.db.raw.prepare(`
        UPDATE jobs SET state = 'RUNNING', phase = ?, attempt = attempt + 1,
          lease_owner = ?, lease_until = ?, transition_version = transition_version + 1,
          updated_at = ? WHERE id = ?
      `).run(phase, leaseOwner, lease, nowIso, id);
      return { state: 'started' };
    })();
  }

  progress(id: string, value: number, phase: string): void {
    const now = new Date().toISOString();
    const leaseUntil = new Date(Date.now() + 30 * 60_000).toISOString();
    this.db.raw.transaction(() => {
      this.db.raw.prepare(`
        UPDATE jobs SET progress = ?, phase = ?, lease_until = ?, updated_at = ?
        WHERE id = ?
      `).run(Math.max(0, Math.min(1, value)), phase, leaseUntil, now, id);
      this.db.raw.prepare(`
        UPDATE job_resource_leases SET lease_until = ? WHERE holder_job_id = ?
      `).run(leaseUntil, id);
    })();
  }

  heartbeat(id: string): void {
    const now = new Date().toISOString();
    const leaseUntil = new Date(Date.now() + 30 * 60_000).toISOString();
    this.db.raw.transaction(() => {
      this.db.raw.prepare(`
        UPDATE jobs SET lease_until = ?, updated_at = ? WHERE id = ? AND state = 'RUNNING'
      `).run(leaseUntil, now, id);
      this.db.raw.prepare(`
        UPDATE job_resource_leases SET lease_until = ? WHERE holder_job_id = ?
      `).run(leaseUntil, id);
    })();
  }

  succeed(id: string, output: unknown): void {
    const projectId = this.projectId(id);
    const now = new Date().toISOString();
    this.db.raw.transaction(() => {
      this.db.raw.prepare(`
        UPDATE jobs SET state = 'SUCCEEDED', progress = 1, output_json = ?,
          lease_owner = NULL, lease_until = NULL, completed_at = ?,
          transition_version = transition_version + 1, updated_at = ?
        WHERE id = ?
      `).run(JSON.stringify(output), now, now, id);
      this.releaseLocks(id, now);
    })();
    if (projectId) this.checkpointHandler?.(projectId);
  }

  fail(id: string, error: unknown): void {
    const projectId = this.projectId(id);
    const message = error instanceof Error ? error.message : String(error);
    const row = this.db.raw.prepare('SELECT attempt, max_attempts FROM jobs WHERE id = ?').get(id) as
      | { attempt: number; max_attempts: number }
      | undefined;
    const retry = row ? row.attempt < row.max_attempts : false;
    const now = new Date().toISOString();
    this.db.raw.transaction(() => {
      this.db.raw.prepare(`
        UPDATE jobs SET state = ?, error = ?, available_at = ?, lease_owner = NULL,
          lease_until = NULL, transition_version = transition_version + 1, updated_at = ?
        WHERE id = ?
      `).run(
        retry ? 'RETRY_SCHEDULED' : 'FAILED_PERMANENT',
        message,
        retry ? new Date(Date.now() + Math.min(60_000, 2000 * 2 ** (row?.attempt ?? 1))).toISOString() : now,
        now,
        id
      );
      this.releaseLocks(id, now);
    })();
    if (projectId) this.checkpointHandler?.(projectId);
  }

  list(projectId?: string): JobRecord[] {
    const rows = this.db.raw.prepare(`
      SELECT * FROM jobs
      ${projectId ? 'WHERE project_id = ?' : ''}
      ORDER BY created_at DESC LIMIT 250
    `).all(...(projectId ? [projectId] : [])) as Array<Record<string, unknown>>;
    return rows.map(row => this.mapJob(row as JobRow));
  }

  retryCapability(id: string): JobRetryCapability {
    const row = this.rowById(id);
    if (!row) throw new Error('Job not found.');
    return this.capabilityForRow(row);
  }

  retry(request: JobRetryRequest): JobRetryResult {
    const now = new Date().toISOString();
    return this.db.raw.transaction((): JobRetryResult => {
      const row = this.rowById(request.jobId);
      if (!row) {
        const message = 'Job not found.';
        this.auditRetry(null, request, 'invalid_state', message, null, 0, null, now);
        return { outcome: 'invalid_state', job: null, capability: null, ...retryResultFields('invalid_state', message) };
      }

      if (row.state !== request.expectedState || Number(row.transition_version) !== request.expectedVersion) {
        const message = 'The job changed after this retry action was presented. Refresh and review its current state.';
        this.auditRetry(row, request, 'concurrent_change', message, row, 0, null, now);
        const job = this.mapJob(row);
        return { outcome: 'concurrent_change', job, capability: job.retryCapability, ...retryResultFields('concurrent_change', message) };
      }

      const capability = this.capabilityForRow(row);
      if (row.state === 'RETRY_SCHEDULED') {
        const message = 'This job already has a scheduled retry. Expedite it only when immediate execution is intentional.';
        this.auditRetry(row, request, 'already_scheduled', message, row, 0, null, now);
        const job = this.mapJob(row);
        return { outcome: 'already_scheduled', job, capability: job.retryCapability, ...retryResultFields('already_scheduled', message) };
      }

      if (!capability.canRetry) {
        const outcome: JobRetryOutcome = capability.reconciliationRequired
          ? 'reconciliation_required'
          : 'invalid_state';
        this.auditRetry(row, request, outcome, capability.message, row, 0, null, now);
        const job = this.mapJob(row);
        return { outcome, job, capability: job.retryCapability, ...retryResultFields(outcome, capability.message) };
      }

      const permanent = row.state === 'FAILED_PERMANENT';
      const operatorReason = request.operatorReason?.trim() ?? '';
      if (permanent && (operatorReason.length < 8 || request.grantAttempt !== true)) {
        const message = 'A permanent failure requires an operator reason and one explicitly granted attempt.';
        this.auditRetry(row, request, 'invalid_state', message, row, 0, null, now);
        const job = this.mapJob(row);
        return { outcome: 'invalid_state', job, capability: job.retryCapability, ...retryResultFields('invalid_state', message) };
      }

      let reconciliation: RetryReconciliation | null = null;
      if (SIDE_EFFECT_JOB_TYPES.has(row.type)) {
        reconciliation = this.reconcileSideEffect(row, 'manual_retry', now);
        if (!reconciliation.safeToRun) {
          const message = reconciliation.message;
          this.auditRetry(row, request, 'reconciliation_required', message, row, 0, reconciliation, now);
          const job = this.mapJob(row);
          return { outcome: 'reconciliation_required', job, capability: job.retryCapability, ...retryResultFields('reconciliation_required', message) };
        }
      }

      const grantedAttempts = permanent ? 1 : 0;
      const changed = this.db.raw.prepare(`
        UPDATE jobs SET state = 'QUEUED', progress = 0, phase = 'Manual retry queued',
          error = NULL, available_at = ?, lease_owner = NULL, lease_until = NULL,
          completed_at = NULL, max_attempts = max_attempts + ?,
          manual_attempt_grants = manual_attempt_grants + ?,
          transition_version = transition_version + 1, updated_at = ?
        WHERE id = ? AND state = ? AND transition_version = ?
      `).run(
        now,
        grantedAttempts,
        grantedAttempts,
        now,
        row.id,
        request.expectedState,
        request.expectedVersion
      );
      if (Number(changed.changes) !== 1) {
        const current = this.rowById(row.id);
        const message = 'The job changed while the retry was being committed. Refresh and review its current state.';
        this.auditRetry(row, request, 'concurrent_change', message, current ?? null, 0, reconciliation, now);
        const job = current ? this.mapJob(current) : null;
        return { outcome: 'concurrent_change', job, capability: job?.retryCapability ?? null, ...retryResultFields('concurrent_change', message) };
      }

      this.releaseLocks(row.id, now);
      const resulting = this.rowById(row.id);
      if (!resulting) throw new Error('Retried job disappeared during its transaction.');
      const message = reconciliation
        ? `Retry queued after ${reconciliation.outcome.replaceAll('_', ' ')} reconciliation.`
        : 'Retry queued.';
      this.auditRetry(row, request, 'retry_started', message, resulting, grantedAttempts, reconciliation, now);
      const job = this.mapJob(resulting);
      return { outcome: 'retry_started', job, capability: job.retryCapability, ...retryResultFields('retry_started', message) };
    })();
  }

  expedite(request: JobExpediteRequest): JobExpediteResult {
    const now = new Date().toISOString();
    return this.db.raw.transaction((): JobExpediteResult => {
      const auditRequest: JobRetryRequest = {
        jobId: request.jobId,
        expectedState: 'RETRY_SCHEDULED',
        expectedVersion: request.expectedVersion
      };
      const row = this.rowById(request.jobId);
      if (!row) {
        const message = 'Job not found.';
        this.auditRetry(null, auditRequest, 'invalid_state', message, null, 0, null, now, 'job.retry_expedited');
        return { outcome: 'invalid_state', job: null, capability: null, ...retryResultFields('invalid_state', message) };
      }
      if (Number(row.transition_version) !== request.expectedVersion) {
        const message = 'The job changed after this expedite action was presented.';
        this.auditRetry(row, auditRequest, 'concurrent_change', message, row, 0, null, now, 'job.retry_expedited');
        const job = this.mapJob(row);
        return { outcome: 'concurrent_change', job, capability: job.retryCapability, ...retryResultFields('concurrent_change', message) };
      }
      if (row.state !== 'RETRY_SCHEDULED') {
        const message = `A job in ${row.state} cannot be expedited.`;
        this.auditRetry(row, auditRequest, 'invalid_state', message, row, 0, null, now, 'job.retry_expedited');
        const job = this.mapJob(row);
        return { outcome: 'invalid_state', job, capability: job.retryCapability, ...retryResultFields('invalid_state', message) };
      }
      const changed = this.db.raw.prepare(`
        UPDATE jobs SET state = 'QUEUED', available_at = ?, phase = 'Scheduled retry expedited',
          transition_version = transition_version + 1, updated_at = ?
        WHERE id = ? AND state = 'RETRY_SCHEDULED' AND transition_version = ?
      `).run(now, now, row.id, request.expectedVersion);
      if (Number(changed.changes) !== 1) {
        const current = this.rowById(row.id);
        const message = 'The job changed while the expedite action was being committed.';
        this.auditRetry(row, auditRequest, 'concurrent_change', message, current ?? null, 0, null, now, 'job.retry_expedited');
        const job = current ? this.mapJob(current) : null;
        return { outcome: 'concurrent_change', job, capability: job?.retryCapability ?? null, ...retryResultFields('concurrent_change', message) };
      }
      this.releaseLocks(row.id, now);
      const resulting = this.rowById(row.id);
      if (!resulting) throw new Error('Expedited job disappeared during its transaction.');
      const message = 'Scheduled retry expedited without consuming an attempt.';
      this.auditRetry(row, auditRequest, 'retry_started', message, resulting, 0, null, now, 'job.retry_expedited');
      const job = this.mapJob(resulting);
      return { outcome: 'expedited', job, capability: job.retryCapability, ...retryResultFields('expedited', message) };
    })();
  }

  waitForHuman(id: string, phase: string): void {
    const projectId = this.projectId(id);
    const now = new Date().toISOString();
    this.db.raw.transaction(() => {
      this.db.raw.prepare(`
        UPDATE jobs SET state = 'WAITING_HUMAN', phase = ?, lease_owner = NULL,
          lease_until = NULL, transition_version = transition_version + 1,
          updated_at = ? WHERE id = ?
      `).run(phase, now, id);
      this.releaseLocks(id, now);
    })();
    if (projectId) this.checkpointHandler?.(projectId);
  }

  addDependency(jobId: string, dependsOnJobId: string): void {
    if (jobId === dependsOnJobId) throw new Error('A job cannot depend on itself.');
    const circular = this.db.raw.prepare(`
      WITH RECURSIVE ancestors(id) AS (
        SELECT depends_on_job_id FROM job_dependencies WHERE job_id = ?
        UNION
        SELECT d.depends_on_job_id FROM job_dependencies d JOIN ancestors a ON d.job_id = a.id
      ) SELECT 1 AS found FROM ancestors WHERE id = ? LIMIT 1
    `).get(dependsOnJobId, jobId);
    if (circular) throw new Error('Circular job dependency detected.');
    this.db.raw.prepare(`
      INSERT OR IGNORE INTO job_dependencies(job_id, depends_on_job_id) VALUES(?, ?)
    `).run(jobId, dependsOnJobId);
  }

  private rowById(id: string): JobRow | undefined {
    return this.db.raw.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
  }

  private jobById(id: string): JobRecord {
    const row = this.rowById(id);
    if (!row) throw new Error('Job not found.');
    return this.mapJob(row);
  }

  private mapJob(row: JobRow): JobRecord {
    return toJob(row, this.capabilityForRow(row));
  }

  private capabilityForRow(row: JobRow): JobRetryCapability {
    const state = row.state;
    const base = {
      jobId: String(row.id),
      currentState: state,
      transitionVersion: Number(row.transition_version),
      requiresReason: false,
      requiresAttemptGrant: false,
      reconciliationRequired: false
    };
    if (state === 'RETRY_SCHEDULED') {
      return {
        ...base,
        action: 'expedite',
        canRetry: true,
        message: 'A retry is already scheduled; it may be expedited without consuming an attempt.'
      };
    }
    if (state === 'WAITING_EXTERNAL' || state === 'WAITING_HUMAN') {
      return {
        ...base,
        action: 'none',
        canRetry: false,
        reconciliationRequired: true,
        message: state === 'WAITING_EXTERNAL'
          ? 'Resolve or reconcile the external wait before retrying.'
          : 'Record the required operator decision before continuing.'
      };
    }
    if (state !== 'FAILED_RETRYABLE' && state !== 'FAILED_PERMANENT') {
      return {
        ...base,
        action: 'none',
        canRetry: false,
        message: `A job in ${state} is not eligible for manual retry.`
      };
    }
    const unsatisfied = this.db.raw.prepare(`
      SELECT count(*) AS count FROM job_dependencies d
      JOIN jobs upstream ON upstream.id = d.depends_on_job_id
      WHERE d.job_id = ? AND upstream.state <> 'SUCCEEDED'
    `).get(row.id) as { count: number };
    if (Number(unsatisfied.count) > 0) {
      return {
        ...base,
        action: 'none',
        canRetry: false,
        message: 'Upstream job dependencies must succeed before this job can be retried.'
      };
    }
    if (state === 'FAILED_RETRYABLE' && Number(row.attempt) >= Number(row.max_attempts)) {
      return {
        ...base,
        action: 'none',
        canRetry: false,
        message: 'This retryable failure has no remaining configured attempt budget.'
      };
    }
    const sideEffect = SIDE_EFFECT_JOB_TYPES.has(row.type);
    const permanent = state === 'FAILED_PERMANENT';
    return {
      ...base,
      action: sideEffect ? 'reconcile_and_retry' : permanent ? 'retry_with_reason' : 'retry',
      canRetry: true,
      requiresReason: permanent,
      requiresAttemptGrant: permanent,
      reconciliationRequired: sideEffect,
      message: sideEffect
        ? 'The existing upload receipt and idempotency identity will be reconciled before this job can run.'
        : permanent
          ? 'Retry requires an operator reason and one explicitly granted attempt.'
          : 'This failure is eligible for a manual retry within its configured attempt budget.'
    };
  }

  private reconcileSideEffect(job: JobRow, trigger: 'manual_retry' | 'startup_recovery', now: string): RetryReconciliation {
    let input: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(String(job.input_json)) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
    } catch {
      // An invalid persisted identity is treated as a mismatch below.
    }
    const expectedPublication = input.publication && typeof input.publication === 'object'
      ? input.publication as Record<string, unknown>
      : null;
    const expectedRender = input.render && typeof input.render === 'object'
      ? input.render as Record<string, unknown>
      : null;
    const expectedPublicationId = typeof expectedPublication?.id === 'string' ? expectedPublication.id : null;
    const expectedProjectId = typeof input.projectId === 'string' ? input.projectId : null;
    const expectedFinalRenderId = typeof input.finalRenderId === 'string'
      ? input.finalRenderId
      : typeof expectedRender?.id === 'string'
        ? expectedRender.id
        : null;
    const expectedFinalSha = typeof input.finalSha256 === 'string'
      ? input.finalSha256
      : typeof expectedPublication?.final_sha256 === 'string'
      ? expectedPublication.final_sha256
      : typeof expectedRender?.sha256 === 'string'
        ? expectedRender.sha256
        : null;
    const expectedChannelId = typeof input.confirmedChannelId === 'string' ? input.confirmedChannelId : null;
    const expectedPackageId = typeof input.selectedPackageId === 'string' ? input.selectedPackageId : null;
    const expectedApprovalHash = typeof input.approvalHash === 'string' ? input.approvalHash : null;
    const expectedSnapshotVersion = typeof input.snapshotVersion === 'number' ? input.snapshotVersion : null;
    const snapshotIdentity = Boolean(expectedFinalRenderId && expectedChannelId);
    const publication = job.project_id ? (snapshotIdentity
      ? this.db.raw.prepare(`
          SELECT id, video_id, upload_session_uri, final_render_id, final_sha256,
            channel_id, selected_package_id, approval_hash, snapshot_version, snapshot_status
          FROM publication_records
          WHERE project_id = ? AND channel_id = ? AND final_render_id = ? AND final_sha256 = ?
          ORDER BY created_at DESC LIMIT 1
        `).get(job.project_id, expectedChannelId, expectedFinalRenderId, expectedFinalSha)
      : expectedPublicationId
        ? this.db.raw.prepare(`
            SELECT id, video_id, upload_session_uri, final_render_id, final_sha256,
              channel_id, selected_package_id, approval_hash, snapshot_version, snapshot_status
            FROM publication_records WHERE project_id = ? AND id = ? LIMIT 1
          `).get(job.project_id, expectedPublicationId)
        : this.db.raw.prepare(`
            SELECT id, video_id, upload_session_uri, final_render_id, final_sha256,
              channel_id, selected_package_id, approval_hash, snapshot_version, snapshot_status
            FROM publication_records WHERE project_id = ? ORDER BY created_at DESC LIMIT 1
          `).get(job.project_id)) as {
      id: string;
      video_id: string | null;
      upload_session_uri: string | null;
      final_render_id: string | null;
      final_sha256: string;
      channel_id: string | null;
      selected_package_id: string | null;
      approval_hash: string | null;
      snapshot_version: number;
      snapshot_status: string;
    } | undefined : undefined;

    const identityMismatch = Boolean(
      !job.project_id
      || expectedProjectId !== job.project_id
      || !expectedFinalSha
      || (expectedPublicationId && publication?.id !== expectedPublicationId)
      || (expectedFinalSha && publication && publication.final_sha256 !== expectedFinalSha)
      || (snapshotIdentity && publication && (
        publication.final_render_id !== expectedFinalRenderId
        || publication.channel_id !== expectedChannelId
        || publication.selected_package_id !== expectedPackageId
        || publication.approval_hash !== expectedApprovalHash
        || publication.snapshot_version !== expectedSnapshotVersion
        || publication.snapshot_status !== 'current'
      ))
    );
    const outcome: RetryReconciliation['outcome'] = identityMismatch
      ? 'identity_mismatch'
      : publication?.video_id
        ? 'remote_effect_reused'
        : publication?.upload_session_uri
          ? 'remote_session_reused'
          : 'no_remote_effect';
    const safeToRun = outcome !== 'identity_mismatch';
    const id = randomUUID();
    this.db.raw.prepare(`
      INSERT INTO job_retry_reconciliations(
        id, job_id, job_transition_version, job_type, outcome, publication_id,
        video_id, input_hash, metadata_json, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      job.id,
      Number(job.transition_version),
      job.type,
      outcome,
      publication?.id ?? null,
      publication?.video_id ?? null,
      job.input_hash,
      JSON.stringify({
        trigger,
        expectedProjectId,
        expectedPublicationId,
        expectedFinalRenderId,
        expectedFinalSha,
        expectedChannelId,
        expectedPackageId,
        expectedApprovalHash,
        expectedSnapshotVersion,
        hasStoredUploadSession: Boolean(publication?.upload_session_uri)
      }),
      now
    );
    return {
      id,
      outcome,
      publicationId: publication?.id ?? null,
      videoId: publication?.video_id ?? null,
      safeToRun,
      message: safeToRun
        ? `Side effect reconciled as ${outcome.replaceAll('_', ' ')}.`
        : 'The persisted upload identity no longer matches the current publication; dedicated reconciliation is required.'
    };
  }

  private auditRetry(
    before: JobRow | null,
    request: JobRetryRequest,
    outcome: JobRetryOutcome,
    message: string,
    after: JobRow | null,
    grantedAttempts: number,
    reconciliation: RetryReconciliation | null,
    now: string,
    action = 'job.manual_retry'
  ): void {
    const safeText = (value: unknown): string | null => value === null || value === undefined
      ? null
      : redactSecrets(value).slice(0, 4_000);
    this.db.raw.prepare(`
      INSERT INTO audit_log(
        project_id, action, actor, entity_type, entity_id,
        before_json, after_json, metadata_json, created_at
      ) VALUES(?, ?, 'operator', 'job', ?, ?, ?, ?, ?)
    `).run(
      before?.project_id ?? after?.project_id ?? null,
      action,
      request.jobId,
      before ? JSON.stringify({
        state: before.state,
        transitionVersion: Number(before.transition_version),
        attempt: Number(before.attempt),
        maxAttempts: Number(before.max_attempts),
        priorError: safeText(before.error)
      }) : null,
      after ? JSON.stringify({
        state: after.state,
        transitionVersion: Number(after.transition_version),
        attempt: Number(after.attempt),
        maxAttempts: Number(after.max_attempts)
      }) : null,
      JSON.stringify({
        expectedState: request.expectedState,
        expectedVersion: request.expectedVersion,
        actualState: before?.state ?? null,
        actualVersion: before ? Number(before.transition_version) : null,
        outcome,
        message,
        operatorReason: safeText(request.operatorReason),
        grantedAttempts,
        reconciliationId: reconciliation?.id ?? null,
        reconciliationOutcome: reconciliation?.outcome ?? null
      }),
      now
    );
    if (outcome !== 'retry_started') {
      const contract = retryDecisionContract(outcome);
      recordSecurityRejection(this.db, {
        flow: 'retry',
        operation: action === 'job.retry_expedited'
          ? 'manual_expedite.state_check'
          : 'manual_retry.state_check',
        code: contract.code,
        recovery: contract.recovery,
        entityType: 'job',
        entityId: request.jobId,
        actor: 'human',
        context: {
          expectedState: request.expectedState,
          expectedVersion: request.expectedVersion,
          actualState: before?.state ?? null,
          actualVersion: before ? Number(before.transition_version) : null,
          outcome,
          reconciliationOutcome: reconciliation?.outcome ?? null
        }
      });
    }
  }

  private releaseLocks(jobId: string, now: string): void {
    this.db.raw.prepare(`
      UPDATE projects SET locked_by_job_id = NULL, updated_at = ? WHERE locked_by_job_id = ?
    `).run(now, jobId);
    this.db.raw.prepare(`DELETE FROM job_resource_leases WHERE holder_job_id = ?`).run(jobId);
  }

  private projectId(jobId: string): string | null {
    const row = this.db.raw.prepare(`SELECT project_id FROM jobs WHERE id = ?`).get(jobId) as {
      project_id: string | null;
    } | undefined;
    return row?.project_id ?? null;
  }
}
