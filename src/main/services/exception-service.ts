import type { AppDatabase } from '../database/database';
import type { ExceptionRecord } from '@shared/types';

function rowToException(row: Record<string, unknown>): ExceptionRecord {
  return {
    id: String(row.id),
    projectId: row.project_id ? String(row.project_id) : null,
    severity: row.severity as ExceptionRecord['severity'],
    stage: String(row.stage),
    code: String(row.code),
    title: String(row.title),
    message: String(row.message),
    evidence: JSON.parse(String(row.evidence_json ?? '{}')) as Record<string, unknown>,
    recommendedAction: row.recommended_action ? String(row.recommended_action) : null,
    status: row.status as ExceptionRecord['status'],
    createdAt: String(row.created_at),
    resolvedAt: row.resolved_at ? String(row.resolved_at) : null
  };
}

export class ExceptionService {
  constructor(private readonly db: AppDatabase) {}

  list(projectId?: string, openOnly = true): ExceptionRecord[] {
    const where = [
      ...(projectId ? ['project_id = ?'] : []),
      ...(openOnly ? [`status = 'OPEN'`] : [])
    ];
    const rows = this.db.raw.prepare(`
      SELECT * FROM exceptions
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY
        CASE severity
          WHEN 'BLOCKER' THEN 0
          WHEN 'HIGH' THEN 1
          WHEN 'MEDIUM' THEN 2
          ELSE 3
        END,
        created_at DESC
    `).all(...(projectId ? [projectId] : [])) as Array<Record<string, unknown>>;
    return rows.map(rowToException);
  }

  resolve(id: string, resolution: Record<string, unknown> = {}): ExceptionRecord {
    const now = new Date().toISOString();
    this.db.raw.prepare(`
      UPDATE exceptions SET status = 'RESOLVED', resolved_at = ?, resolution_json = ?
      WHERE id = ?
    `).run(now, JSON.stringify(resolution), id);
    const row = this.db.raw.prepare('SELECT * FROM exceptions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error('Exception not found.');
    return rowToException(row);
  }
}
