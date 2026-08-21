import type { AppDatabase } from '../database/database';
import type { AuditLogEntry, ExceptionRecord, ExceptionRetryAction } from '@shared/types';

const MANUAL_ACKNOWLEDGEMENT = 'operator_acknowledged';
const NON_OVERRIDABLE_CODES = new Set([
  'DATABASE_INTEGRITY_FAILURE',
  'DUPLICATE_UPLOAD_DETECTED',
  'AMBIGUOUS_FILE_MAPPING',
  'EXACT_LOCATION_MISMATCH',
  'SEMANTIC_PROVIDER_REQUIRED',
  'LICENSE_STATE',
  'LICENSE_STATUS_MISSING',
  'OUTPUT_EXISTS',
  'FINAL_MEDIA_PROFILE',
  'FINAL_DURATION',
  'QC_LICENSE_STATE',
  'QC_OUTPUT_EXISTS',
  'QC_FINAL_MEDIA_PROFILE',
  'QC_FINAL_DURATION'
]);

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function canAcknowledge(row: Record<string, unknown>): boolean {
  return row.status === 'OPEN'
    && !['BLOCKER', 'HIGH'].includes(String(row.severity))
    && !NON_OVERRIDABLE_CODES.has(String(row.code));
}

function canOverride(row: Record<string, unknown>): boolean {
  return canAcknowledge(row);
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function jsonArray(value: unknown): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function retryAction(row: Record<string, unknown>): ExceptionRetryAction | null {
  if (row.status !== 'OPEN') return null;
  const code = String(row.code);
  if (code === 'SEMANTIC_PROVIDER_REQUIRED') return 'semantic_verification';
  if (code === 'INGEST_FAILED') {
    const evidence = jsonRecord(row.evidence_json);
    return typeof evidence.acquisitionId === 'string' && typeof evidence.filePath === 'string'
      ? 'media_ingest'
      : null;
  }
  if (['RENDER_FAILED', 'AUTOMATION_STAGE_FAILED', 'YOUTUBE_UPLOAD_FAILED'].includes(code)) {
    return 'workflow';
  }
  return null;
}

function rowToException(row: Record<string, unknown>, auditTrail: AuditLogEntry[] = []): ExceptionRecord {
  return {
    id: String(row.id),
    projectId: row.project_id ? String(row.project_id) : null,
    projectTitle: row.project_title ? String(row.project_title) : null,
    severity: row.severity as ExceptionRecord['severity'],
    stage: String(row.stage),
    code: String(row.code),
    title: String(row.title),
    message: String(row.message),
    evidence: jsonRecord(row.evidence_json),
    recommendedAction: row.recommended_action ? String(row.recommended_action) : null,
    safeAlternatives: jsonArray(row.safe_alternatives_json),
    canAcknowledge: canAcknowledge(row),
    canOverride: canOverride(row),
    retryAction: retryAction(row),
    status: row.status as ExceptionRecord['status'],
    resolution: row.resolution_json ? jsonRecord(row.resolution_json) : null,
    auditTrail,
    createdAt: String(row.created_at),
    resolvedAt: row.resolved_at ? String(row.resolved_at) : null
  };
}

export class ExceptionService {
  constructor(private readonly db: AppDatabase) {}

  list(projectId?: string, openOnly = true): ExceptionRecord[] {
    const where = [
      ...(projectId ? ['exception.project_id = ?'] : []),
      ...(openOnly ? [`exception.status = 'OPEN'`] : [])
    ];
    const rows = this.db.raw.prepare(`
      SELECT exception.*, project.title AS project_title
      FROM exceptions exception
      LEFT JOIN projects project ON project.id = exception.project_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY
        CASE exception.severity
          WHEN 'BLOCKER' THEN 0
          WHEN 'HIGH' THEN 1
          WHEN 'MEDIUM' THEN 2
          ELSE 3
        END,
        exception.created_at DESC
    `).all(...(projectId ? [projectId] : [])) as Array<Record<string, unknown>>;
    return rows.map(row => rowToException(row, this.auditTrail(String(row.id))));
  }

  get(id: string): ExceptionRecord {
    const row = this.db.raw.prepare(`
      SELECT exception.*, project.title AS project_title
      FROM exceptions exception
      LEFT JOIN projects project ON project.id = exception.project_id
      WHERE exception.id = ?
    `).get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error('Exception not found.');
    return rowToException(row, this.auditTrail(id));
  }

  resolve(id: string, resolution: Record<string, unknown> = {}): ExceptionRecord {
    return this.db.raw.transaction(() => {
      const before = this.db.raw.prepare('SELECT * FROM exceptions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      if (!before) throw new Error('Exception not found.');
      if (before.status !== 'OPEN') return rowToException(before);
      const method = stringValue(resolution.method);
      if (!canAcknowledge(before) && method === MANUAL_ACKNOWLEDGEMENT) {
        throw new Error('This safety exception cannot be cleared by acknowledgement. Complete the recommended repair and retry verification.');
      }
      const projectId = before.project_id ? String(before.project_id) : null;
      const project = projectId
        ? this.db.raw.prepare('SELECT state FROM projects WHERE id = ?').get(projectId) as
          | { state: import('@shared/types').ProjectState }
          | undefined
        : undefined;
      if (
        project?.state === 'BLOCKED_EXCEPTION'
        && ['BLOCKER', 'HIGH'].includes(String(before.severity))
      ) {
        throw new Error('This project is still blocked. Complete the recommended repair or retry so the pipeline can verify the condition before closing the exception.');
      }
      const now = new Date().toISOString();
      this.db.raw.prepare(`
        UPDATE exceptions SET status = 'RESOLVED', resolved_at = ?, resolution_json = ?
        WHERE id = ?
      `).run(now, JSON.stringify(resolution), id);
      if (projectId) {
        this.db.raw.prepare(`
          INSERT INTO audit_log(project_id, action, actor, entity_type, entity_id, before_json, after_json, metadata_json, created_at)
          VALUES(?, 'exception.resolved', 'operator', 'exception', ?, ?, ?, ?, ?)
        `).run(
          projectId, id, JSON.stringify({ status: before.status }), JSON.stringify({ status: 'RESOLVED' }),
          JSON.stringify(resolution), now
        );
      }
      return this.get(id);
    })();
  }

  override(id: string, reason: string): ExceptionRecord {
    const trimmed = reason.trim();
    if (trimmed.length < 10) throw new Error('An override requires a specific reason of at least 10 characters.');
    return this.db.raw.transaction(() => {
      const before = this.db.raw.prepare('SELECT * FROM exceptions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      if (!before) throw new Error('Exception not found.');
      if (before.status !== 'OPEN') return this.get(id);
      if (!canOverride(before)) {
        throw new Error('This safety exception cannot be overridden. Complete its recommended repair instead.');
      }
      const now = new Date().toISOString();
      const resolution = { method: 'operator_override', reason: trimmed };
      this.db.raw.prepare(`
        UPDATE exceptions SET status = 'OVERRIDDEN', resolved_at = ?, resolution_json = ? WHERE id = ?
      `).run(now, JSON.stringify(resolution), id);
      this.recordAudit(before.project_id, id, 'exception.overridden', 'human', before.status, 'OVERRIDDEN', resolution, now);
      return this.get(id);
    })();
  }

  beginRetry(id: string): ExceptionRecord {
    return this.db.raw.transaction(() => {
      const before = this.db.raw.prepare('SELECT * FROM exceptions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      if (!before) throw new Error('Exception not found.');
      const action = retryAction(before);
      if (!action || action === 'semantic_verification') {
        throw new Error('This exception does not support a generic workflow retry.');
      }
      if (before.project_id) {
        const otherBlockers = this.db.raw.prepare(`
          SELECT count(*) AS count FROM exceptions
          WHERE project_id = ? AND id <> ? AND status = 'OPEN' AND severity IN ('BLOCKER','HIGH')
        `).get(before.project_id, id) as { count: number };
        if (Number(otherBlockers.count)) {
          throw new Error('Resolve the project’s other blocker/high exceptions before retrying this stage.');
        }
      }
      const now = new Date().toISOString();
      const resolution = { method: 'retry_started', action };
      this.db.raw.prepare(`
        UPDATE exceptions SET status = 'RESOLVED', resolved_at = ?, resolution_json = ? WHERE id = ?
      `).run(now, JSON.stringify(resolution), id);
      this.recordAudit(before.project_id, id, 'exception.retry_started', 'human', before.status, 'RESOLVED', resolution, now);
      return this.get(id);
    })();
  }

  retryFailed(id: string, error: unknown): ExceptionRecord {
    return this.db.raw.transaction(() => {
      const before = this.db.raw.prepare('SELECT * FROM exceptions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      if (!before) throw new Error('Exception not found.');
      const now = new Date().toISOString();
      const message = error instanceof Error ? error.message : String(error);
      this.db.raw.prepare(`
        UPDATE exceptions SET status = 'OPEN', resolved_at = NULL,
          resolution_json = ?, message = ? WHERE id = ?
      `).run(JSON.stringify({ method: 'retry_failed', error: message }), message, id);
      this.recordAudit(before.project_id, id, 'exception.retry_failed', 'system', before.status, 'OPEN', { error: message }, now);
      return this.get(id);
    })();
  }

  private auditTrail(exceptionId: string): AuditLogEntry[] {
    return (this.db.raw.prepare(`
      SELECT * FROM audit_log
      WHERE entity_type = 'exception' AND entity_id = ?
      ORDER BY id DESC LIMIT 100
    `).all(exceptionId) as Array<Record<string, unknown>>).map(row => ({
      id: Number(row.id),
      projectId: row.project_id ? String(row.project_id) : null,
      action: String(row.action),
      actor: String(row.actor),
      entityType: row.entity_type ? String(row.entity_type) : null,
      entityId: row.entity_id ? String(row.entity_id) : null,
      before: row.before_json ? jsonRecord(row.before_json) : null,
      after: row.after_json ? jsonRecord(row.after_json) : null,
      metadata: row.metadata_json ? jsonRecord(row.metadata_json) : null,
      createdAt: String(row.created_at)
    }));
  }

  private recordAudit(
    projectId: unknown,
    exceptionId: string,
    action: string,
    actor: string,
    beforeStatus: unknown,
    afterStatus: string,
    metadata: Record<string, unknown>,
    now: string
  ): void {
    this.db.raw.prepare(`
      INSERT INTO audit_log(project_id, action, actor, entity_type, entity_id, before_json, after_json, metadata_json, created_at)
      VALUES(?, ?, ?, 'exception', ?, ?, ?, ?, ?)
    `).run(
      projectId ?? null,
      action,
      actor,
      exceptionId,
      JSON.stringify({ status: beforeStatus }),
      JSON.stringify({ status: afterStatus }),
      JSON.stringify(metadata),
      now
    );
  }
}
