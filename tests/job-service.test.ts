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
      available_at TEXT NOT NULL, lease_owner TEXT, lease_until TEXT, error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE TABLE job_dependencies(job_id TEXT NOT NULL, depends_on_job_id TEXT NOT NULL, PRIMARY KEY(job_id, depends_on_job_id));
    CREATE TABLE job_resource_leases(
      resource_key TEXT PRIMARY KEY, holder_job_id TEXT NOT NULL, lease_owner TEXT NOT NULL,
      lease_until TEXT NOT NULL, acquired_at TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    INSERT INTO projects(id, updated_at) VALUES('p1', datetime('now')), ('p2', datetime('now'));
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

    service.retry(second.id);
    expect(service.start(second.id, 'Rendering final', { resourceKey: 'render_final' })).toEqual({ state: 'started' });
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

  it('rejects circular dependencies', () => {
    const { raw, service } = fixture();
    const left = service.create('left', null, {});
    const right = service.create('right', null, {});
    service.addDependency(left.id, right.id);
    expect(() => service.addDependency(right.id, left.id)).toThrow(/Circular/);
    raw.close();
  });
});
