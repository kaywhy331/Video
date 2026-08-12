import { shell } from 'electron';
import { basename } from 'node:path';
import type { AppDatabase } from '../database/database';
import type { AcquisitionItem } from '@shared/types';
import type { MediaService } from './media-service';
import { ProjectStateService } from './project-state-service';
import { RepairService } from './repair-service';

function jsonArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? '[]'));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function mapRow(row: Record<string, unknown>): AcquisitionItem {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    assetId: String(row.asset_id),
    ordinal: Number(row.ordinal),
    role: row.role as AcquisitionItem['role'],
    state: row.state as AcquisitionItem['state'],
    licenseState: row.license_state as AcquisitionItem['licenseState'],
    sourceUrl: String(row.source_url),
    assetTitle: String(row.asset_title ?? ''),
    thumbnailUrl: row.thumbnail_url ? String(row.thumbnail_url) : null,
    requiredForScenes: jsonArray(row.required_scene_ordinals_json).map(Number),
    matchScore: Number(row.match_score),
    reasons: jsonArray(row.reasons_json),
    activeAt: row.active_at ? String(row.active_at) : null,
    detectedPath: row.detected_path ? String(row.detected_path) : null,
    mappedFileId: row.mapped_file_id ? String(row.mapped_file_id) : null,
    mappingConfidence: row.mapping_confidence === null || row.mapping_confidence === undefined
      ? null : Number(row.mapping_confidence),
    error: row.error ? String(row.error) : null
  };
}

export function validateEnvatoUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('Only HTTPS links may be opened.');
  const host = url.hostname.toLowerCase();
  const allowed = host === 'elements.envato.com'
    || host.endsWith('.elements.envato.com')
    || host === 'envato.com'
    || host.endsWith('.envato.com');
  if (!allowed) throw new Error('Only allowlisted Envato links may be opened.');
  return url;
}

export class AcquisitionService {
  private readonly projectStates: ProjectStateService;
  private readonly repairs: RepairService;

  constructor(
    private readonly db: AppDatabase,
    private readonly media: MediaService
  ) {
    this.projectStates = new ProjectStateService(db);
    this.repairs = new RepairService(db);
  }

  list(projectId?: string): AcquisitionItem[] {
    const rows = this.db.raw.prepare(`
      SELECT a.*, x.title AS asset_title, x.thumbnail_url
      FROM acquisition_items a
      JOIN assets x ON x.id = a.asset_id
      ${projectId ? 'WHERE a.project_id = ?' : ''}
      ORDER BY
        CASE a.state
          WHEN 'ACTIVE_IN_BROWSER' THEN 0
          WHEN 'WAITING_FOR_FILE' THEN 1
          WHEN 'READY_TO_OPEN' THEN 2
          WHEN 'LICENSE_ONLY_PENDING' THEN 3
          ELSE 4
        END,
        a.project_id,
        a.ordinal
    `).all(...(projectId ? [projectId] : [])) as Array<Record<string, unknown>>;
    return rows.map(mapRow);
  }

  activate(acquisitionId: string): AcquisitionItem {
    const now = new Date().toISOString();
    const transaction = this.db.raw.transaction(() => {
      this.db.raw.prepare(`
        UPDATE acquisition_items
        SET state = CASE
          WHEN state = 'ACTIVE_IN_BROWSER' THEN 'READY_TO_OPEN'
          ELSE state
        END,
        active_at = CASE WHEN state = 'ACTIVE_IN_BROWSER' THEN NULL ELSE active_at END,
        updated_at = ?
        WHERE state = 'ACTIVE_IN_BROWSER'
      `).run(now);
      this.db.raw.prepare(`
        UPDATE acquisition_items SET
          state = CASE
            WHEN state = 'LICENSE_ONLY_PENDING' THEN state
            ELSE 'ACTIVE_IN_BROWSER'
          END,
          active_at = ?,
          updated_at = ?
        WHERE id = ?
      `).run(now, now, acquisitionId);
    });
    transaction();
    const row = this.db.raw.prepare(`
      SELECT a.*, x.title AS asset_title, x.thumbnail_url
      FROM acquisition_items a JOIN assets x ON x.id = a.asset_id
      WHERE a.id = ?
    `).get(acquisitionId) as Record<string, unknown> | undefined;
    if (!row) throw new Error('Acquisition item not found.');
    return mapRow(row);
  }

  async open(acquisitionId: string): Promise<void> {
    const item = this.activate(acquisitionId);
    const url = validateEnvatoUrl(item.sourceUrl);
    await shell.openExternal(url.toString(), { activate: true });
    this.db.raw.prepare(`
      UPDATE acquisition_items
      SET state = 'WAITING_FOR_FILE', updated_at = ?
      WHERE id = ? AND state = 'ACTIVE_IN_BROWSER'
    `).run(new Date().toISOString(), acquisitionId);
  }

  attest(acquisitionId: string, certificatePath?: string): AcquisitionItem {
    const item = this.db.raw.prepare(`
      SELECT a.*, x.local_file_id
      FROM acquisition_items a
      JOIN assets x ON x.id = a.asset_id
      WHERE a.id = ?
    `).get(acquisitionId) as Record<string, unknown> | undefined;
    if (!item) throw new Error('Acquisition item not found.');
    const now = new Date().toISOString();
    const licenseState = certificatePath ? 'CERTIFICATE_ATTACHED' : 'OPERATOR_ATTESTED';
    const isLicenseOnly = item.state === 'LICENSE_ONLY_PENDING';
    const transaction = this.db.raw.transaction(() => {
      this.db.raw.prepare(`
        UPDATE acquisition_items
        SET license_state = ?, state = CASE WHEN ? THEN 'COMPLETE' ELSE state END,
            updated_at = ?
        WHERE id = ?
      `).run(licenseState, Number(isLicenseOnly), now, acquisitionId);
      this.db.raw.prepare(`
        UPDATE project_licenses
        SET license_state = ?, certificate_path = coalesce(?, certificate_path),
            operator_attested_at = ?, updated_at = ?
        WHERE project_id = ? AND asset_id = ?
      `).run(
        licenseState,
        certificatePath ?? null,
        now,
        now,
        item.project_id,
        item.asset_id
      );
    });
    transaction();
    this.repairs.reconcileFootageRepairs(String(item.project_id));

    if (isLicenseOnly && item.local_file_id) {
      const projectId = String(item.project_id);
      const segments = this.db.raw.prepare(`
        SELECT id, duration_ms FROM media_segments
        WHERE asset_file_id = ? AND eligible_1080p = 1
        ORDER BY quality_score DESC, start_ms ASC
      `).all(item.local_file_id) as Array<{ id: string; duration_ms: number }>;
      const scenes = this.db.raw.prepare(`
        SELECT id FROM project_scenes
        WHERE project_id = ? AND selected_asset_id = ?
          AND verification_state <> 'verified'
        ORDER BY ordinal
      `).all(projectId, item.asset_id) as Array<{ id: string }>;
      const attach = this.db.raw.transaction(() => {
        scenes.forEach((scene, index) => {
          const segment = segments[index % Math.max(1, segments.length)];
          if (!segment) return;
          this.db.raw.prepare(`
            UPDATE project_scenes SET selected_file_id = ?, selected_segment_id = ?,
              target_duration_ms = min(target_duration_ms, ?),
              verification_state = 'verified', updated_at = ?
            WHERE id = ?
          `).run(item.local_file_id, segment.id, Math.min(7000, segment.duration_ms), now, scene.id);
        });
        const pending = this.db.raw.prepare(`
          SELECT count(*) AS count FROM acquisition_items
          WHERE project_id = ? AND state NOT IN ('COMPLETE','SKIPPED')
        `).get(projectId) as { count: number };
        if (pending.count === 0) {
          const unverified = this.db.raw.prepare(`
            SELECT count(*) AS count FROM project_scenes
            WHERE project_id = ? AND verification_state NOT IN ('verified','graphic')
          `).get(projectId) as { count: number };
          const project = this.db.raw.prepare('SELECT state FROM projects WHERE id = ?').get(projectId) as { state: import('@shared/types').ProjectState };
          if (project.state === 'WAITING_FOR_DOWNLOADS') {
            this.projectStates.transition(projectId, 'INGESTING_MEDIA', {
              progress: 0.48,
              reason: 'All acquisition items have a local file or license-only completion'
            });
          }
          this.projectStates.transition(projectId, 'VERIFYING_FOOTAGE', {
            progress: 0.5,
            reason: 'Reused local media assigned to project scenes'
          });
          this.projectStates.transition(projectId, unverified.count ? 'BLOCKED_EXCEPTION' : 'FINALIZING_SCRIPT', {
            progress: unverified.count ? 0.5 : 0.53,
            reason: unverified.count ? 'One or more scenes lack verified footage' : 'All reused footage passed project verification',
            prerequisites: { unverifiedScenes: unverified.count }
          });
          if (!unverified.count) {
            this.projectStates.transition(projectId, 'GENERATING_VOICE', {
              progress: 0.54,
              reason: 'Final script locked after footage verification'
            });
            this.projectStates.transition(projectId, 'BUILDING_TIMELINE', {
              progress: 0.55,
              reason: 'Verified scenes are ready for narration and timeline assembly'
            });
          }
        }
      });
      attach();
    }

    const row = this.db.raw.prepare(`
      SELECT a.*, x.title AS asset_title, x.thumbnail_url
      FROM acquisition_items a JOIN assets x ON x.id = a.asset_id
      WHERE a.id = ?
    `).get(acquisitionId) as Record<string, unknown>;
    return mapRow(row);
  }

  async mapFile(acquisitionId: string, filePath: string): Promise<void> {
    if (!filePath.trim()) throw new Error('A file path is required.');
    this.db.raw.prepare(`
      UPDATE acquisition_items
      SET state = 'FILE_STABLE', detected_path = ?, mapping_confidence = 1,
          mapping_evidence_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      filePath,
      JSON.stringify({ method: 'operator', fileName: basename(filePath) }),
      new Date().toISOString(),
      acquisitionId
    );
    await this.media.ingestAcquisition(acquisitionId, filePath);
  }
}
