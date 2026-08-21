import { createHash, randomUUID } from 'node:crypto';
import type { AppDatabase } from '../database/database';
import type { JobRecord } from '@shared/types';

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

function toJob(row: Record<string, unknown>): JobRecord {
  return {
    id: String(row.id),
    projectId: row.project_id ? String(row.project_id) : null,
    type: String(row.type),
    state: row.state as JobRecord['state'],
    progress: Number(row.progress),
    phase: row.phase ? String(row.phase) : null,
    attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts),
    availableAt: String(row.available_at),
    leaseUntil: row.lease_until ? String(row.lease_until) : null,
    error: row.error ? String(row.error) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
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
      this.db.raw.prepare(`
        UPDATE jobs SET state = 'QUEUED', lease_owner = NULL, lease_until = NULL,
          phase = 'Recovered after restart', updated_at = ?
        WHERE state = 'RUNNING'
          AND (lease_owner IS NULL OR lease_owner <> ? OR lease_until IS NULL OR lease_until <= ?)
      `).run(now, currentOwner, now);
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
    const row = this.db.raw.prepare(`SELECT state FROM jobs WHERE id = ?`).get(id) as
      | { state: JobRecord['state'] }
      | undefined;
    if (!row) throw new Error('Job not found.');
    if (!['QUEUED', 'READY', 'RETRY_SCHEDULED', 'WAITING_EXTERNAL'].includes(row.state)) {
      throw new Error(`Job ${id} cannot be rescheduled from ${row.state}.`);
    }
    this.db.raw.prepare(`
      UPDATE jobs SET state = 'QUEUED', available_at = ?, phase = ?, error = NULL,
        lease_owner = NULL, lease_until = NULL, updated_at = ? WHERE id = ?
    `).run(parsed.toISOString(), phase, new Date().toISOString(), id);
    this.releaseLocks(id, new Date().toISOString());
    return toJob(this.db.raw.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Record<string, unknown>);
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
    if (existing) return toJob(existing);

    const id = randomUUID();
    this.db.raw.prepare(`
      INSERT INTO jobs(
        id, project_id, type, state, progress, input_json, input_hash,
        attempt, max_attempts, available_at, created_at, updated_at
      ) VALUES(?, ?, ?, 'QUEUED', 0, ?, ?, 0, ?, ?, ?, ?)
    `).run(id, projectId, type, inputJson, inputHash, maxAttempts, availableAt, now, now);
    return toJob(this.db.raw.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Record<string, unknown>);
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
              phase = ?, error = NULL, lease_owner = NULL, lease_until = NULL, updated_at = ?
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
          lease_owner = ?, lease_until = ?, updated_at = ? WHERE id = ?
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
          lease_owner = NULL, lease_until = NULL, completed_at = ?, updated_at = ?
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
          lease_until = NULL, updated_at = ?
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
    return rows.map(toJob);
  }

  retry(id: string): JobRecord {
    const now = new Date().toISOString();
    this.db.raw.transaction(() => {
      this.db.raw.prepare(`
        UPDATE jobs SET state = 'QUEUED', error = NULL, available_at = ?,
          lease_owner = NULL, lease_until = NULL, updated_at = ? WHERE id = ?
      `).run(now, now, id);
      this.releaseLocks(id, now);
    })();
    return toJob(this.db.raw.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Record<string, unknown>);
  }

  waitForHuman(id: string, phase: string): void {
    const projectId = this.projectId(id);
    const now = new Date().toISOString();
    this.db.raw.transaction(() => {
      this.db.raw.prepare(`
        UPDATE jobs SET state = 'WAITING_HUMAN', phase = ?, lease_owner = NULL,
          lease_until = NULL, updated_at = ? WHERE id = ?
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
