import { createHash, randomUUID } from 'node:crypto';
import type { AppDatabase } from '../database/database';
import type { JobRecord } from '@shared/types';

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
  constructor(private readonly db: AppDatabase) {}

  recoverInterrupted(): void {
    const now = new Date().toISOString();
    const currentOwner = `desktop-${process.pid}`;
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
  }

  create(type: string, projectId: string | null, input: unknown, maxAttempts = 3): JobRecord {
    const now = new Date().toISOString();
    const inputJson = JSON.stringify(input);
    const inputHash = createHash('sha256').update(`${type}|${projectId ?? ''}|${inputJson}`).digest('hex');
    const existing = this.db.raw.prepare(`
      SELECT * FROM jobs
      WHERE type = ? AND input_hash = ? AND state IN ('QUEUED','READY','RUNNING','SUCCEEDED')
      ORDER BY created_at DESC LIMIT 1
    `).get(type, inputHash) as Record<string, unknown> | undefined;
    if (existing) return toJob(existing);

    const id = randomUUID();
    this.db.raw.prepare(`
      INSERT INTO jobs(
        id, project_id, type, state, progress, input_json, input_hash,
        attempt, max_attempts, available_at, created_at, updated_at
      ) VALUES(?, ?, ?, 'QUEUED', 0, ?, ?, 0, ?, ?, ?, ?)
    `).run(id, projectId, type, inputJson, inputHash, maxAttempts, now, now, now);
    return toJob(this.db.raw.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Record<string, unknown>);
  }

  start(id: string, phase: string): void {
    const now = new Date();
    const lease = new Date(now.getTime() + 30 * 60_000).toISOString();
    this.db.raw.transaction(() => {
      const job = this.db.raw.prepare('SELECT project_id, state, available_at FROM jobs WHERE id = ?').get(id) as
        | { project_id: string | null; state: JobRecord['state']; available_at: string }
        | undefined;
      if (!job) throw new Error('Job not found.');
      if (!['QUEUED', 'READY', 'RETRY_SCHEDULED'].includes(job.state)) throw new Error(`Job ${id} cannot start from ${job.state}.`);
      if (job.available_at > now.toISOString()) throw new Error('Job retry backoff has not elapsed.');
      const dependency = this.db.raw.prepare(`
        SELECT count(*) AS count FROM job_dependencies d
        JOIN jobs upstream ON upstream.id = d.depends_on_job_id
        WHERE d.job_id = ? AND upstream.state <> 'SUCCEEDED'
      `).get(id) as { count: number };
      if (dependency.count) throw new Error('Job dependencies have not succeeded.');
      if (job.project_id) {
        const lock = this.db.raw.prepare(`
          UPDATE projects SET locked_by_job_id = ?, updated_at = ?
          WHERE id = ? AND (locked_by_job_id IS NULL OR locked_by_job_id = ?)
        `).run(id, now.toISOString(), job.project_id, id);
        if (Number(lock.changes) !== 1) throw new Error('Project is locked by another state-mutating workflow.');
      }
      this.db.raw.prepare(`
        UPDATE jobs SET state = 'RUNNING', phase = ?, attempt = attempt + 1,
          lease_owner = ?, lease_until = ?, updated_at = ? WHERE id = ?
      `).run(phase, `desktop-${process.pid}`, lease, now.toISOString(), id);
    })();
  }

  progress(id: string, value: number, phase: string): void {
    this.db.raw.prepare(`
      UPDATE jobs SET progress = ?, phase = ?, lease_until = ?, updated_at = ?
      WHERE id = ?
    `).run(
      Math.max(0, Math.min(1, value)),
      phase,
      new Date(Date.now() + 30 * 60_000).toISOString(),
      new Date().toISOString(),
      id
    );
  }

  succeed(id: string, output: unknown): void {
    const now = new Date().toISOString();
    this.db.raw.prepare(`
      UPDATE jobs SET state = 'SUCCEEDED', progress = 1, output_json = ?,
        lease_owner = NULL, lease_until = NULL, completed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(JSON.stringify(output), now, now, id);
    this.releaseProject(id, now);
  }

  fail(id: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const row = this.db.raw.prepare('SELECT attempt, max_attempts FROM jobs WHERE id = ?').get(id) as
      | { attempt: number; max_attempts: number }
      | undefined;
    const retry = row ? row.attempt < row.max_attempts : false;
    const now = new Date().toISOString();
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
    this.releaseProject(id, now);
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
    this.db.raw.prepare(`
      UPDATE jobs SET state = 'QUEUED', error = NULL, available_at = ?, updated_at = ?
      WHERE id = ?
    `).run(new Date().toISOString(), new Date().toISOString(), id);
    return toJob(this.db.raw.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Record<string, unknown>);
  }

  waitForHuman(id: string, phase: string): void {
    this.db.raw.prepare(`
      UPDATE jobs SET state = 'WAITING_HUMAN', phase = ?, lease_owner = NULL,
        lease_until = NULL, updated_at = ? WHERE id = ?
    `).run(phase, new Date().toISOString(), id);
    this.releaseProject(id, new Date().toISOString());
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

  private releaseProject(jobId: string, now: string): void {
    this.db.raw.prepare(`
      UPDATE projects SET locked_by_job_id = NULL, updated_at = ? WHERE locked_by_job_id = ?
    `).run(now, jobId);
  }
}
