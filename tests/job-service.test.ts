import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteConnection, type AppDatabase } from '@main/database/database';
import { JobService } from '@main/services/job-service';

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'videofactory-jobs-'));
  roots.push(root);
  const raw = new SqliteConnection(join(root, 'jobs.sqlite'));
  raw.exec(`
    CREATE TABLE projects(id TEXT PRIMARY KEY, locked_by_job_id TEXT, updated_at TEXT);
    CREATE TABLE jobs(
      id TEXT PRIMARY KEY, project_id TEXT, type TEXT NOT NULL, state TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 100, progress REAL NOT NULL DEFAULT 0,
      phase TEXT, input_json TEXT NOT NULL, input_hash TEXT NOT NULL, output_json TEXT,
      attempt INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
      manual_attempt_grants INTEGER NOT NULL DEFAULT 0,
      transition_version INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL, lease_owner TEXT, lease_until TEXT, error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE TABLE job_dependencies(job_id TEXT NOT NULL, depends_on_job_id TEXT NOT NULL, PRIMARY KEY(job_id, depends_on_job_id));
    CREATE TABLE job_resource_leases(
      resource_key TEXT PRIMARY KEY, holder_job_id TEXT NOT NULL, lease_owner TEXT NOT NULL,
      lease_until TEXT NOT NULL, acquired_at TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE publication_records(
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, video_id TEXT, upload_session_uri TEXT,
      channel_id TEXT, final_render_id TEXT, final_sha256 TEXT NOT NULL,
      snapshot_version INTEGER NOT NULL DEFAULT 0,
      snapshot_status TEXT NOT NULL DEFAULT 'legacy_unbound', selected_package_id TEXT,
      approval_hash TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE job_retry_reconciliations(
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL, job_transition_version INTEGER NOT NULL,
      job_type TEXT NOT NULL, outcome TEXT NOT NULL, publication_id TEXT, video_id TEXT,
      input_hash TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
    );
    CREATE TABLE audit_log(
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, action TEXT NOT NULL,
      actor TEXT NOT NULL, entity_type TEXT, entity_id TEXT, before_json TEXT,
      after_json TEXT, metadata_json TEXT, created_at TEXT NOT NULL
    );
    INSERT INTO projects(id, updated_at) VALUES
      ('p1', datetime('now')), ('p2', datetime('now')),
      ('p3', datetime('now')), ('p4', datetime('now'));
  `);
  const service = new JobService({ raw } as AppDatabase);
  return { raw, service };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('durable job engine', () => {
  it('deduplicates the same project/input but not different projects', () => {
    const { raw, service } = fixture();
    const first = service.create('render', 'p1', { manifest: 'a' });
    expect(service.create('render', 'p1', { manifest: 'a' }).id).toBe(first.id);
    expect(service.create('render', null, { manifest: 'a' }).id).not.toBe(first.id);
    raw.close();
  });

  it('persists future availability and defers without consuming an attempt', () => {
    const { raw, service } = fixture();
    const future = '2030-01-03T00:00:00.000Z';
    const job = service.schedule('analytics_checkpoint', 'p1', { snapshotDay: 1 }, future);
    expect(job.availableAt).toBe(future);
    expect(() => service.start(job.id, 'too early')).toThrow(/backoff has not elapsed/i);
    expect(service.reschedule(job.id, '2030-01-03T01:00:00.000Z', 'Still private')).toMatchObject({
      attempt: 0,
      availableAt: '2030-01-03T01:00:00.000Z',
      phase: 'Still private'
    });
    expect(service.schedule('analytics_checkpoint', 'p1', { snapshotDay: 1 }, future).id).toBe(job.id);
    raw.close();
  });

  it('[JOB-004] backs transient failures off and enforces the configured maximum attempt count', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T12:00:00.000Z'));
    try {
      const { raw, service } = fixture();
      const job = service.create('retry-fixture', 'p1', { input: 'stable' }, 2);
      service.start(job.id, 'attempt one');
      service.fail(job.id, new Error('transient one'));
      expect(service.list('p1').find(item => item.id === job.id)).toMatchObject({
        state: 'RETRY_SCHEDULED',
        attempt: 1,
        maxAttempts: 2,
        availableAt: '2026-08-20T12:00:04.000Z'
      });
      expect(() => service.start(job.id, 'too soon')).toThrow('backoff has not elapsed');

      vi.advanceTimersByTime(4_000);
      service.start(job.id, 'attempt two');
      service.fail(job.id, new Error('transient two'));
      expect(service.list('p1').find(item => item.id === job.id)).toMatchObject({
        state: 'FAILED_PERMANENT',
        attempt: 2,
        maxAttempts: 2,
        error: 'transient two'
      });
      expect(() => service.start(job.id, 'attempt three')).toThrow('cannot start');
      raw.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('[JOB-006] preserves a human wait across recovery without consuming another attempt', () => {
    const { raw, service } = fixture();
    const job = service.create('authorization', 'p1', { provider: 'youtube' });
    service.start(job.id, 'request authorization');
    service.waitForHuman(job.id, 'Waiting for operator authorization');
    service.recoverInterrupted();
    expect(service.list('p1').find(item => item.id === job.id)).toMatchObject({
      state: 'WAITING_HUMAN',
      attempt: 1,
      phase: 'Waiting for operator authorization',
      leaseUntil: null
    });
    expect(raw.prepare(`SELECT locked_by_job_id FROM projects WHERE id = 'p1'`).get())
      .toEqual({ locked_by_job_id: null });
    raw.close();
  });

  it('blocks dependencies and concurrent project mutation, then releases the lock', () => {
    const { raw, service } = fixture();
    const upstream = service.create('probe', null, {});
    const downstream = service.create('render', 'p1', {});
    service.addDependency(downstream.id, upstream.id);
    expect(() => service.start(downstream.id, 'blocked')).toThrow(/dependencies/);
    service.start(upstream.id, 'probe');
    service.succeed(upstream.id, {});
    service.start(downstream.id, 'render');
    expect(raw.prepare('SELECT locked_by_job_id FROM projects WHERE id = ?').get('p1')?.locked_by_job_id).toBe(downstream.id);
    const competing = service.create('other', 'p1', {});
    expect(() => service.start(competing.id, 'compete')).toThrow(/locked/);
    service.succeed(downstream.id, {});
    service.start(competing.id, 'now-safe');
    raw.close();
  });

  it('leases one global final-render slot and defers another project without consuming an attempt', () => {
    const { raw, service } = fixture();
    const first = service.create('render_final', 'p1', { version: 1 });
    const second = service.create('render_final', 'p2', { version: 1 });
    expect(service.start(first.id, 'Rendering final', { resourceKey: 'render_final' })).toEqual({ state: 'started' });

    const deferred = service.start(second.id, 'Rendering final', { resourceKey: 'render_final' });
    expect(deferred).toMatchObject({ state: 'deferred', reason: 'resource_busy', resourceKey: 'render_final' });
    expect(service.list('p2').find(job => job.id === second.id)).toMatchObject({
      state: 'RETRY_SCHEDULED',
      attempt: 0,
      phase: 'Waiting for render_final capacity'
    });
    expect(raw.prepare('SELECT locked_by_job_id FROM projects WHERE id = ?').get('p2')?.locked_by_job_id).toBeNull();
    expect(raw.prepare('SELECT resource_key, holder_job_id FROM job_resource_leases').all())
      .toEqual([{ resource_key: 'render_final', holder_job_id: first.id }]);

    const lightweight = service.create('analytics_checkpoint', 'p2', { day: 1 });
    service.start(lightweight.id, 'Collecting analytics');
    service.succeed(lightweight.id, {});
    service.succeed(first.id, {});
    expect(raw.prepare('SELECT count(*) AS count FROM job_resource_leases').get()).toEqual({ count: 0 });

    const scheduled = service.list('p2').find(job => job.id === second.id)!;
    expect(service.expedite({ jobId: second.id, expectedVersion: scheduled.transitionVersion }).outcome)
      .toBe('expedited');
    expect(service.start(second.id, 'Rendering final', { resourceKey: 'render_final' })).toEqual({ state: 'started' });
    raw.close();
  });

  it('[JOB-011] allows only failed jobs and commits at most one retry for an expected state/version', () => {
    const { raw, service } = fixture();
    const invalid = service.create('queued-work', 'p1', {});
    raw.prepare(`UPDATE projects SET locked_by_job_id = ? WHERE id = 'p1'`).run(invalid.id);
    raw.prepare(`
      INSERT INTO job_resource_leases(resource_key, holder_job_id, lease_owner, lease_until, acquired_at)
      VALUES('fixture', ?, 'fixture-owner', '2999-01-01T00:00:00.000Z', datetime('now'))
    `).run(invalid.id);
    const rejected = service.retry({
      jobId: invalid.id,
      expectedState: invalid.state,
      expectedVersion: invalid.transitionVersion
    });
    expect(rejected.outcome).toBe('invalid_state');
    expect(raw.prepare(`SELECT state FROM jobs WHERE id = ?`).get(invalid.id)).toEqual({ state: 'QUEUED' });
    expect(raw.prepare(`SELECT locked_by_job_id FROM projects WHERE id = 'p1'`).get())
      .toEqual({ locked_by_job_id: invalid.id });
    expect(raw.prepare(`SELECT holder_job_id FROM job_resource_leases WHERE resource_key = 'fixture'`).get())
      .toEqual({ holder_job_id: invalid.id });

    raw.prepare(`UPDATE projects SET locked_by_job_id = NULL WHERE id = 'p1'`).run();
    raw.prepare(`DELETE FROM job_resource_leases WHERE resource_key = 'fixture'`).run();
    const failed = service.create('retryable-work', 'p1', {});
    raw.prepare(`
      UPDATE jobs SET state = 'FAILED_RETRYABLE', error = 'temporary', transition_version = transition_version + 1
      WHERE id = ?
    `).run(failed.id);
    raw.prepare(`UPDATE projects SET locked_by_job_id = ? WHERE id = 'p1'`).run(failed.id);
    const current = service.list('p1').find(job => job.id === failed.id)!;
    const request = {
      jobId: failed.id,
      expectedState: current.state,
      expectedVersion: current.transitionVersion
    } as const;
    expect(service.retry(request).outcome).toBe('retry_started');
    expect(service.retry(request).outcome).toBe('concurrent_change');
    expect(service.list('p1').find(job => job.id === failed.id)).toMatchObject({
      state: 'QUEUED',
      attempt: 0,
      maxAttempts: 3,
      transitionVersion: current.transitionVersion + 1
    });
    expect(raw.prepare(`SELECT locked_by_job_id FROM projects WHERE id = 'p1'`).get())
      .toEqual({ locked_by_job_id: null });
    raw.close();
  });

  it('[JOB-011] preserves every invalid state and its job, lock, and lease fields', () => {
    const { raw, service } = fixture();
    const cases = [
      ['QUEUED', 'invalid_state', 'JOB_RETRY_INVALID_STATE'],
      ['READY', 'invalid_state', 'JOB_RETRY_INVALID_STATE'],
      ['RUNNING', 'invalid_state', 'JOB_RETRY_INVALID_STATE'],
      ['WAITING_EXTERNAL', 'reconciliation_required', 'JOB_RETRY_RECONCILIATION_REQUIRED'],
      ['WAITING_HUMAN', 'reconciliation_required', 'JOB_RETRY_RECONCILIATION_REQUIRED'],
      ['RETRY_SCHEDULED', 'already_scheduled', 'JOB_RETRY_ALREADY_SCHEDULED'],
      ['SUCCEEDED', 'invalid_state', 'JOB_RETRY_INVALID_STATE'],
      ['CANCELLED', 'invalid_state', 'JOB_RETRY_INVALID_STATE']
    ] as const;
    for (const [state, expectedOutcome, expectedCode] of cases) {
      const job = service.create(`invalid-${state}`, 'p1', { state });
      const availableAt = '2031-01-02T03:04:05.000Z';
      const completedAt = '2026-01-02T03:04:05.000Z';
      raw.prepare(`
        UPDATE jobs SET state = ?, error = 'preserve-error', output_json = '{"receipt":true}',
          attempt = 2, max_attempts = 5, manual_attempt_grants = 1,
          available_at = ?, lease_owner = 'owned-worker', lease_until = ?,
          completed_at = ?, transition_version = 9 WHERE id = ?
      `).run(state, availableAt, availableAt, completedAt, job.id);
      raw.prepare(`UPDATE projects SET locked_by_job_id = ? WHERE id = 'p1'`).run(job.id);
      raw.prepare(`
        INSERT INTO job_resource_leases(resource_key, holder_job_id, lease_owner, lease_until, acquired_at)
        VALUES(?, ?, 'owned-worker', ?, ?)
      `).run(`lease-${state}`, job.id, availableAt, completedAt);
      const before = raw.prepare(`
        SELECT state, error, output_json, attempt, max_attempts, manual_attempt_grants,
          available_at, lease_owner, lease_until, completed_at, transition_version
        FROM jobs WHERE id = ?
      `).get(job.id);
      const rejection = service.retry({ jobId: job.id, expectedState: state, expectedVersion: 9 });
      expect(rejection).toMatchObject({
        outcome: expectedOutcome,
        code: expectedCode,
        recovery: expect.any(String)
      });
      expect(rejection.message).toContain(`[${expectedCode}]`);
      expect(rejection.message).toContain('Recovery:');
      expect(raw.prepare(`
        SELECT state, error, output_json, attempt, max_attempts, manual_attempt_grants,
          available_at, lease_owner, lease_until, completed_at, transition_version
        FROM jobs WHERE id = ?
      `).get(job.id)).toEqual(before);
      expect(raw.prepare(`SELECT locked_by_job_id FROM projects WHERE id = 'p1'`).get())
        .toEqual({ locked_by_job_id: job.id });
      expect(raw.prepare(`SELECT holder_job_id FROM job_resource_leases WHERE resource_key = ?`).get(`lease-${state}`))
        .toEqual({ holder_job_id: job.id });
      raw.prepare(`UPDATE projects SET locked_by_job_id = NULL WHERE id = 'p1'`).run();
      raw.prepare(`DELETE FROM job_resource_leases WHERE resource_key = ?`).run(`lease-${state}`);
    }
    const securityEvents = raw.prepare(`
      SELECT actor, metadata_json FROM audit_log
      WHERE action = 'security.privileged_rejected' AND entity_type = 'job'
      ORDER BY id
    `).all() as Array<{ actor: string; metadata_json: string }>;
    expect(securityEvents).toHaveLength(cases.length);
    expect(securityEvents.every(event => event.actor === 'human')).toBe(true);
    expect(securityEvents.map(event => JSON.parse(event.metadata_json))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          schemaVersion: 1,
          flow: 'retry',
          operation: 'manual_retry.state_check',
          code: 'JOB_RETRY_RECONCILIATION_REQUIRED',
          outcome: 'rejected'
        })
      ])
    );
    expect(securityEvents.map(event => event.metadata_json).join(' ')).not.toContain('preserve-error');
    raw.close();
  });

  it('[JOB-012] grants exactly one audited attempt for a permanent failure with an operator reason', () => {
    const { raw, service } = fixture();
    const created = service.create('permanent-work', 'p1', {}, 1);
    service.start(created.id, 'attempt one');
    service.fail(created.id, new Error('credential denied'));
    const failed = service.list('p1').find(job => job.id === created.id)!;
    expect(failed.state).toBe('FAILED_PERMANENT');

    expect(service.retry({
      jobId: failed.id,
      expectedState: failed.state,
      expectedVersion: failed.transitionVersion
    }).outcome).toBe('invalid_state');
    const result = service.retry({
      jobId: failed.id,
      expectedState: failed.state,
      expectedVersion: failed.transitionVersion,
      operatorReason: 'Credential was rotated and verified by the operator.',
      grantAttempt: true
    });
    expect(result).toMatchObject({
      outcome: 'retry_started',
      job: { state: 'QUEUED', attempt: 1, maxAttempts: 2, manualAttemptGrants: 1 }
    });
    const audit = raw.prepare(`
      SELECT before_json, metadata_json FROM audit_log
      WHERE action = 'job.manual_retry' ORDER BY id DESC LIMIT 1
    `).get() as { before_json: string; metadata_json: string };
    expect(JSON.parse(audit.before_json)).toMatchObject({ priorError: 'credential denied', maxAttempts: 1 });
    expect(JSON.parse(audit.metadata_json)).toMatchObject({
      outcome: 'retry_started',
      grantedAttempts: 1,
      operatorReason: 'Credential was rotated and verified by the operator.'
    });
    raw.close();
  });

  it('[JOB-013] reconciles remote video, upload session, no-effect, and identity-mismatch receipts before queueing', () => {
    const { raw, service } = fixture();
    const now = new Date().toISOString();
    raw.prepare(`
      INSERT INTO publication_records(id, project_id, video_id, upload_session_uri, final_sha256, created_at)
      VALUES('publication-1', 'p1', 'youtube-video-1', NULL, 'final-sha-1', ?)
    `).run(now);
    const created = service.create('workflow_upload_private', 'p1', {
      projectId: 'p1',
      render: { sha256: 'final-sha-1' },
      publication: { id: 'publication-1', final_sha256: 'final-sha-1' }
    });
    raw.prepare(`
      UPDATE jobs SET state = 'FAILED_RETRYABLE', error = 'attachment timeout',
        transition_version = transition_version + 1 WHERE id = ?
    `).run(created.id);
    const failed = service.list('p1').find(job => job.id === created.id)!;
    expect(failed.retryCapability.action).toBe('reconcile_and_retry');
    expect(service.retry({
      jobId: failed.id,
      expectedState: failed.state,
      expectedVersion: failed.transitionVersion
    }).outcome).toBe('retry_started');
    expect(raw.prepare(`SELECT count(*) AS count FROM publication_records WHERE project_id = 'p1'`).get())
      .toEqual({ count: 1 });
    expect(raw.prepare(`
      SELECT outcome, publication_id, video_id FROM job_retry_reconciliations WHERE job_id = ?
    `).get(created.id)).toEqual({
      outcome: 'remote_effect_reused',
      publication_id: 'publication-1',
      video_id: 'youtube-video-1'
    });

    raw.prepare(`
      INSERT INTO publication_records(id, project_id, video_id, upload_session_uri, final_sha256, created_at)
      VALUES('publication-session', 'p2', NULL, 'https://upload.youtube.com/session-safe', 'session-sha', ?)
    `).run(now);
    const sessionJob = service.create('workflow_upload_private', 'p2', {
      projectId: 'p2',
      render: { sha256: 'session-sha' },
      publication: { id: 'publication-session', final_sha256: 'session-sha' }
    });
    raw.prepare(`
      UPDATE jobs SET state = 'FAILED_RETRYABLE', transition_version = transition_version + 1 WHERE id = ?
    `).run(sessionJob.id);
    const sessionFailure = service.list('p2').find(job => job.id === sessionJob.id)!;
    expect(service.retry({
      jobId: sessionJob.id,
      expectedState: sessionFailure.state,
      expectedVersion: sessionFailure.transitionVersion
    }).outcome).toBe('retry_started');
    expect(raw.prepare(`SELECT outcome FROM job_retry_reconciliations WHERE job_id = ?`).get(sessionJob.id))
      .toEqual({ outcome: 'remote_session_reused' });

    const noEffectJob = service.create('workflow_upload_private', 'p3', {
      projectId: 'p3',
      render: { sha256: 'not-uploaded-sha' }, publication: null
    });
    raw.prepare(`
      UPDATE jobs SET state = 'FAILED_RETRYABLE', transition_version = transition_version + 1 WHERE id = ?
    `).run(noEffectJob.id);
    const noEffectFailure = service.list('p3').find(job => job.id === noEffectJob.id)!;
    expect(service.retry({
      jobId: noEffectJob.id,
      expectedState: noEffectFailure.state,
      expectedVersion: noEffectFailure.transitionVersion
    }).outcome).toBe('retry_started');
    expect(raw.prepare(`SELECT outcome FROM job_retry_reconciliations WHERE job_id = ?`).get(noEffectJob.id))
      .toEqual({ outcome: 'no_remote_effect' });

    raw.prepare(`
      INSERT INTO publication_records(id, project_id, video_id, upload_session_uri, final_sha256, created_at)
      VALUES('publication-current', 'p4', NULL, NULL, 'current-sha', ?)
    `).run(now);
    const stale = service.create('workflow_upload_private', 'p4', {
      projectId: 'p4',
      render: { sha256: 'stale-sha' },
      publication: { id: 'publication-stale', final_sha256: 'stale-sha' }
    });
    raw.prepare(`
      UPDATE jobs SET state = 'FAILED_RETRYABLE', transition_version = transition_version + 1 WHERE id = ?
    `).run(stale.id);
    const staleFailure = service.list('p4').find(job => job.id === stale.id)!;
    const blocked = service.retry({
      jobId: stale.id,
      expectedState: staleFailure.state,
      expectedVersion: staleFailure.transitionVersion
    });
    expect(blocked.outcome).toBe('reconciliation_required');
    expect(raw.prepare(`SELECT state, transition_version FROM jobs WHERE id = ?`).get(stale.id))
      .toEqual({ state: 'FAILED_RETRYABLE', transition_version: staleFailure.transitionVersion });
    raw.close();
  });

  it('[YT-011][JOB-013] reconciles a resumable upload only by its full active-final snapshot', () => {
    const { raw, service } = fixture();
    raw.prepare(`
      INSERT INTO publication_records(
        id, project_id, video_id, upload_session_uri, channel_id, final_render_id,
        final_sha256, snapshot_version, snapshot_status, selected_package_id,
        approval_hash, created_at
      ) VALUES('snapshot-target', 'p1', NULL, 'https://upload.youtube.com/target',
        'UC-target', 'render-target', 'same-sha', 1, 'current', 'package-target',
        'approval-target', '2026-08-24T00:00:00.000Z')
    `).run();
    raw.prepare(`
      INSERT INTO publication_records(
        id, project_id, video_id, upload_session_uri, channel_id, final_render_id,
        final_sha256, snapshot_version, snapshot_status, selected_package_id,
        approval_hash, created_at
      ) VALUES('newer-wrong-snapshot', 'p1', 'wrong-video', NULL,
        'UC-other', 'render-other', 'same-sha', 1, 'current', 'package-other',
        'approval-other', '2026-08-25T00:00:00.000Z')
    `).run();
    const job = service.create('workflow_upload_private', 'p1', {
      snapshotVersion: 1,
      projectId: 'p1',
      finalRenderId: 'render-target',
      finalSha256: 'same-sha',
      selectedPackageId: 'package-target',
      approvalHash: 'approval-target',
      confirmedChannelId: 'UC-target'
    });
    raw.prepare(`
      UPDATE jobs SET state = 'FAILED_RETRYABLE', transition_version = transition_version + 1
      WHERE id = ?
    `).run(job.id);
    const failed = service.list('p1').find(candidate => candidate.id === job.id)!;

    expect(service.retry({
      jobId: job.id,
      expectedState: failed.state,
      expectedVersion: failed.transitionVersion
    }).outcome).toBe('retry_started');
    expect(raw.prepare(`
      SELECT outcome, publication_id, video_id FROM job_retry_reconciliations WHERE job_id = ?
    `).get(job.id)).toEqual({
      outcome: 'remote_session_reused',
      publication_id: 'snapshot-target',
      video_id: null
    });
    raw.close();
  });

  it('recovers only expired running leases and clears stale project locks', () => {
    const { raw, service } = fixture();
    const expired = service.create('expired', 'p1', {});
    service.start(expired.id, 'run');
    raw.prepare('UPDATE jobs SET lease_until = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', expired.id);
    service.recoverInterrupted();
    expect(service.list('p1').find(job => job.id === expired.id)?.state).toBe('QUEUED');
    expect(raw.prepare('SELECT locked_by_job_id FROM projects WHERE id = ?').get('p1')?.locked_by_job_id).toBeNull();
    expect(raw.prepare('SELECT count(*) AS count FROM job_resource_leases').get()).toEqual({ count: 0 });
    raw.close();
  });

  it('recovers a lease owned by a previous desktop process immediately', () => {
    const { raw, service } = fixture();
    const stale = service.create('stale-process', 'p1', {});
    service.start(stale.id, 'run');
    raw.prepare('UPDATE jobs SET lease_owner = ?, lease_until = ? WHERE id = ?')
      .run('desktop-previous-process', '2999-01-01T00:00:00.000Z', stale.id);
    service.recoverInterrupted();
    expect(service.list('p1').find(job => job.id === stale.id)?.state).toBe('QUEUED');
    raw.close();
  });

  it('[JOB-013] reconciles interrupted upload jobs before startup makes them runnable', () => {
    const { raw, service } = fixture();
    const now = new Date().toISOString();
    raw.prepare(`
      INSERT INTO publication_records(id, project_id, video_id, upload_session_uri, final_sha256, created_at)
      VALUES('startup-current', 'p1', NULL, NULL, 'current-sha', ?)
    `).run(now);
    const blocked = service.create('workflow_upload_private', 'p1', {
      projectId: 'p1',
      render: { sha256: 'stale-sha' },
      publication: { id: 'startup-stale', final_sha256: 'stale-sha' }
    });
    service.start(blocked.id, 'Uploading private video');
    raw.prepare(`UPDATE jobs SET lease_owner = 'desktop-previous-process' WHERE id = ?`).run(blocked.id);

    raw.prepare(`
      INSERT INTO publication_records(id, project_id, video_id, upload_session_uri, final_sha256, created_at)
      VALUES('startup-complete', 'p2', 'youtube-startup-video', NULL, 'complete-sha', ?)
    `).run(now);
    const recoverable = service.create('workflow_upload_private', 'p2', {
      projectId: 'p2',
      render: { sha256: 'complete-sha' },
      publication: { id: 'startup-complete', final_sha256: 'complete-sha' }
    });
    service.start(recoverable.id, 'Uploading private video');
    raw.prepare(`UPDATE jobs SET lease_owner = 'desktop-previous-process' WHERE id = ?`).run(recoverable.id);

    service.recoverInterrupted();
    expect(service.list('p1').find(job => job.id === blocked.id)).toMatchObject({
      state: 'FAILED_RETRYABLE',
      phase: 'Remote side effect requires operator reconciliation'
    });
    expect(service.list('p2').find(job => job.id === recoverable.id)).toMatchObject({
      state: 'QUEUED',
      phase: 'Recovered after remote effect reused'
    });
    expect(raw.prepare(`
      SELECT job_id, outcome FROM job_retry_reconciliations ORDER BY job_id
    `).all()).toEqual([
      { job_id: blocked.id, outcome: 'identity_mismatch' },
      { job_id: recoverable.id, outcome: 'remote_effect_reused' }
    ].sort((left, right) => left.job_id.localeCompare(right.job_id)));
    expect(raw.prepare(`SELECT locked_by_job_id FROM projects WHERE id IN ('p1','p2') ORDER BY id`).all())
      .toEqual([{ locked_by_job_id: null }, { locked_by_job_id: null }]);
    raw.close();
  });

  it('rejects circular dependencies', () => {
    const { raw, service } = fixture();
    const left = service.create('left', null, {});
    const right = service.create('right', null, {});
    service.addDependency(left.id, right.id);
    expect(() => service.addDependency(right.id, left.id)).toThrow(/Circular/);
    raw.close();
  });
});
