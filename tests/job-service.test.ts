import { afterEach, describe, expect, it } from 'vitest';
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
    INSERT INTO projects(id, updated_at) VALUES('p1', datetime('now'));
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

  it('recovers only expired running leases and clears stale project locks', () => {
    const { raw, service } = fixture();
    const expired = service.create('expired', 'p1', {});
    service.start(expired.id, 'run');
    raw.prepare('UPDATE jobs SET lease_until = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', expired.id);
    service.recoverInterrupted();
    expect(service.list('p1').find(job => job.id === expired.id)?.state).toBe('QUEUED');
    expect(raw.prepare('SELECT locked_by_job_id FROM projects WHERE id = ?').get('p1')?.locked_by_job_id).toBeNull();
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
