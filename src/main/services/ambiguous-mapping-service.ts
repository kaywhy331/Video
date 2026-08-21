import { existsSync } from 'node:fs';
import type { AppDatabase } from '../database/database';
import type {
  AcquisitionState,
  AmbiguousFileMappingCandidate,
  AmbiguousFileMappingRecovery,
  AmbiguousFileMappingResolution
} from '@shared/types';
import type { AcquisitionService } from './acquisition-service';

function stringArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? '[]'));
    return Array.isArray(parsed)
      ? [...new Set(parsed
          .filter(item => (typeof item === 'string' && item.trim()) || typeof item === 'number')
          .map(String))]
      : [];
  } catch {
    return [];
  }
}

function evidence(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value ?? '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function candidateFromRow(row: Record<string, unknown>): AmbiguousFileMappingCandidate {
  return {
    acquisitionId: String(row.id),
    projectId: String(row.project_id),
    projectTitle: String(row.project_title),
    assetId: String(row.asset_id),
    assetTitle: String(row.asset_title),
    thumbnailUrl: row.thumbnail_url ? String(row.thumbnail_url) : null,
    requiredForScenes: stringArray(row.required_scene_ordinals_json).map(Number).filter(Number.isFinite),
    state: row.state as AcquisitionState
  };
}

const CANDIDATE_STATES = [
  'ACTIVE_IN_BROWSER',
  'WAITING_FOR_FILE',
  'READY_TO_OPEN',
  'FILE_STABLE',
  'FAILED'
] as const;

export class AmbiguousMappingService {
  constructor(
    private readonly db: AppDatabase,
    private readonly acquisitions: AcquisitionService
  ) {}

  get(exceptionId: string): AmbiguousFileMappingRecovery {
    const exception = this.db.raw.prepare(`
      SELECT id, project_id, code, status, evidence_json
      FROM exceptions WHERE id = ?
    `).get(exceptionId) as Record<string, unknown> | undefined;
    if (!exception || exception.code !== 'AMBIGUOUS_FILE_MAPPING') {
      throw new Error('Ambiguous file-mapping exception not found.');
    }
    if (exception.status !== 'OPEN') throw new Error('This file-mapping exception is already closed.');
    const persisted = evidence(exception.evidence_json);
    const filePath = typeof persisted.filePath === 'string' ? persisted.filePath : '';
    const fileName = typeof persisted.fileName === 'string' ? persisted.fileName : '';
    if (!filePath || !fileName) throw new Error('The mapping exception is missing its persisted file evidence.');

    const activeIds = Array.isArray(persisted.activeIds)
      ? [...new Set(persisted.activeIds.filter(item => typeof item === 'string' && item.trim()).map(String))]
      : [];
    let rows: Array<Record<string, unknown>> = [];
    if (activeIds.length) {
      const placeholders = activeIds.map(() => '?').join(',');
      rows = this.candidateQuery(`a.id IN (${placeholders})`, activeIds);
    }
    if (!rows.length) {
      const projectId = exception.project_id ? String(exception.project_id) : null;
      rows = this.candidateQuery(projectId ? 'a.project_id = ?' : '1 = 1', projectId ? [projectId] : []);
    }
    return {
      exceptionId: String(exception.id),
      filePath,
      fileName,
      candidates: rows.map(candidateFromRow)
    };
  }

  async resolve(exceptionId: string, acquisitionId: string): Promise<AmbiguousFileMappingResolution> {
    const recovery = this.get(exceptionId);
    const candidate = recovery.candidates.find(item => item.acquisitionId === acquisitionId);
    if (!candidate) throw new Error('The selected acquisition is not a valid candidate for this file.');
    if (!existsSync(recovery.filePath)) throw new Error('The downloaded file no longer exists at the detected path.');

    try {
      await this.acquisitions.mapFile(acquisitionId, recovery.filePath);
    } catch (error) {
      this.recordFailure(exceptionId, acquisitionId, error);
      throw error;
    }
    const completed = this.db.raw.prepare(`
      SELECT project_id, state, mapped_file_id FROM acquisition_items WHERE id = ?
    `).get(acquisitionId) as {
      project_id: string;
      state: AcquisitionState;
      mapped_file_id: string | null;
    } | undefined;
    if (!completed || completed.state !== 'COMPLETE' || !completed.mapped_file_id) {
      const error = new Error('The file was not ingested successfully; the mapping exception remains open.');
      this.recordFailure(exceptionId, acquisitionId, error);
      throw error;
    }

    const now = new Date().toISOString();
    this.db.raw.transaction(() => {
      const result = this.db.raw.prepare(`
        UPDATE exceptions SET project_id = COALESCE(project_id, ?), status = 'RESOLVED',
          resolved_at = ?, resolution_json = ?
        WHERE id = ? AND code = 'AMBIGUOUS_FILE_MAPPING' AND status = 'OPEN'
      `).run(
        completed.project_id,
        now,
        JSON.stringify({ method: 'mapped_and_ingested', acquisitionId, mappedFileId: completed.mapped_file_id }),
        exceptionId
      );
      if (!Number(result.changes)) throw new Error('The mapping exception changed before resolution could be recorded.');
      this.db.raw.prepare(`
        INSERT INTO audit_log(
          project_id, action, actor, entity_type, entity_id, after_json, metadata_json, created_at
        ) VALUES(?, 'exception.ambiguous_mapping_resolved', 'operator', 'exception', ?, ?, ?, ?)
      `).run(
        completed.project_id,
        exceptionId,
        JSON.stringify({ status: 'RESOLVED' }),
        JSON.stringify({ acquisitionId, mappedFileId: completed.mapped_file_id }),
        now
      );
    })();
    return {
      exceptionId,
      acquisitionId,
      projectId: completed.project_id,
      mappedFileId: completed.mapped_file_id,
      acquisitionState: 'COMPLETE'
    };
  }

  private candidateQuery(predicate: string, parameters: string[]): Array<Record<string, unknown>> {
    const statePlaceholders = CANDIDATE_STATES.map(() => '?').join(',');
    return this.db.raw.prepare(`
      SELECT a.id, a.project_id, a.asset_id, a.state, a.required_scene_ordinals_json,
        p.title AS project_title, x.title AS asset_title, x.thumbnail_url
      FROM acquisition_items a
      JOIN projects p ON p.id = a.project_id
      JOIN assets x ON x.id = a.asset_id
      WHERE ${predicate}
        AND a.state IN (${statePlaceholders})
        AND a.role <> 'license_only'
      ORDER BY
        CASE a.state
          WHEN 'ACTIVE_IN_BROWSER' THEN 0
          WHEN 'WAITING_FOR_FILE' THEN 1
          WHEN 'FILE_STABLE' THEN 2
          WHEN 'READY_TO_OPEN' THEN 3
          ELSE 4
        END,
        a.updated_at DESC,
        a.ordinal
      LIMIT 30
    `).all(...parameters, ...CANDIDATE_STATES) as Array<Record<string, unknown>>;
  }

  private recordFailure(exceptionId: string, acquisitionId: string, error: unknown): void {
    const row = this.db.raw.prepare(`SELECT evidence_json FROM exceptions WHERE id = ?`).get(exceptionId) as
      | { evidence_json: string }
      | undefined;
    if (!row) return;
    this.db.raw.prepare(`UPDATE exceptions SET evidence_json = ? WHERE id = ? AND status = 'OPEN'`).run(
      JSON.stringify({
        ...evidence(row.evidence_json),
        attemptedAcquisitionId: acquisitionId,
        attemptedAt: new Date().toISOString(),
        lastError: error instanceof Error ? error.message : String(error)
      }),
      exceptionId
    );
  }
}
