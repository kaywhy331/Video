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
    this.db.raw.prepare(`
      UPDATE jobs SET state = 'QUEUED', lease_owner = NULL, lease_until = NULL,
        phase = 'Recovered after restart', updated_at = ?
      WHERE state = 'RUNNING'
    `).run(now);
  }

  create(type: string, projectId: string | null, input: unknown, maxAttempts = 3): JobRecord {
    const now = new Date().toISOString();
    const inputJson = JSON.stringify(input);
    const inputHash = createHash('sha256').update(`${type}|${inputJson}`).digest('hex');
    const existing = this.db.raw.prepare(`
      SELECT * FROM jobs
      WHERE type = ? AND input_hash = ? AND state IN ('QUEUED','RUNNING','SUCCEEDED')
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
    this.db.raw.prepare(`
      UPDATE jobs SET state = 'RUNNING', phase = ?, attempt = attempt + 1,
        lease_owner = ?, lease_until = ?, updated_at = ?
      WHERE id = ?
    `).run(phase, `desktop-${process.pid}`, lease, now.toISOString(), id);
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
      retry ? 'RETRY_WAIT' : 'FAILED',
      message,
      retry ? new Date(Date.now() + Math.min(60_000, 2000 * 2 ** (row?.attempt ?? 1))).toISOString() : now,
      now,
      id
    );
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
}
