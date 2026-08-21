import { shell } from 'electron';
import { existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import type { AppDatabase } from '../database/database';
import type { AcquisitionItem } from '@shared/types';
import type { MediaService } from './media-service';

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
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Only credential-free HTTPS links may be opened.');
  }
  const host = url.hostname.toLowerCase();
  const allowed = host === 'elements.envato.com'
    || host.endsWith('.elements.envato.com')
    || host === 'envato.com'
    || host.endsWith('.envato.com');
  if (!allowed) throw new Error('Only allowlisted Envato links may be opened.');
  return url;
}

export class AcquisitionService {
  constructor(
    private readonly db: AppDatabase,
    private readonly media: MediaService
  ) {}

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

  async attest(acquisitionId: string, certificatePath?: string): Promise<AcquisitionItem> {
    const item = this.db.raw.prepare('SELECT project_id FROM acquisition_items WHERE id = ?')
      .get(acquisitionId) as { project_id: string } | undefined;
    if (!item) throw new Error('Acquisition item not found.');
    await this.attestItems(String(item.project_id), [acquisitionId], certificatePath);
    const row = this.db.raw.prepare(`
      SELECT a.*, x.title AS asset_title, x.thumbnail_url
      FROM acquisition_items a JOIN assets x ON x.id = a.asset_id
      WHERE a.id = ?
    `).get(acquisitionId) as Record<string, unknown>;
    return mapRow(row);
  }

  async attestProject(projectId: string, certificatePath?: string): Promise<AcquisitionItem[]> {
    const states = certificatePath
      ? ['PENDING', 'OPERATOR_ATTESTED']
      : ['PENDING'];
    const targets = (this.db.raw.prepare(`
      SELECT id FROM acquisition_items
      WHERE project_id = ? AND state <> 'SKIPPED'
        AND license_state IN (${states.map(() => '?').join(',')})
      ORDER BY ordinal, id
    `).all(projectId, ...states) as Array<{ id: string }>).map(row => row.id);
    if (targets.length) await this.attestItems(projectId, targets, certificatePath);
    return this.list(projectId);
  }

  private async attestItems(projectId: string, acquisitionIds: string[], certificatePath?: string): Promise<void> {
    if (certificatePath && (!existsSync(certificatePath) || !statSync(certificatePath).isFile())) {
      throw new Error('The selected license certificate does not exist or is not a file.');
    }
    const uniqueIds = [...new Set(acquisitionIds)];
    if (!uniqueIds.length) return;
    const placeholders = uniqueIds.map(() => '?').join(',');
    const items = this.db.raw.prepare(`
      SELECT a.*, x.local_file_id
      FROM acquisition_items a
      JOIN assets x ON x.id = a.asset_id
      WHERE a.project_id = ? AND a.id IN (${placeholders}) AND a.state <> 'SKIPPED'
      ORDER BY a.ordinal, a.id
    `).all(projectId, ...uniqueIds) as Array<Record<string, unknown>>;
    if (items.length !== uniqueIds.length) {
      throw new Error('Every license attestation target must belong to the selected project and remain active.');
    }
    const allowedStates = certificatePath
      ? new Set(['PENDING', 'OPERATOR_ATTESTED'])
      : new Set(['PENDING']);
    if (items.some(item => !allowedStates.has(String(item.license_state)))) {
      throw new Error(certificatePath
        ? 'A certificate can only be attached to pending or operator-attested licenses.'
        : 'Only pending licenses can be operator-attested.');
    }
    const now = new Date().toISOString();
    const licenseState = certificatePath ? 'CERTIFICATE_ATTACHED' : 'OPERATOR_ATTESTED';
    const transaction = this.db.raw.transaction(() => {
      for (const item of items) {
        const acquisition = this.db.raw.prepare(`
          UPDATE acquisition_items
          SET license_state = ?, updated_at = ?
          WHERE id = ? AND license_state IN (${[...allowedStates].map(() => '?').join(',')})
        `).run(licenseState, now, item.id, ...allowedStates);
        if (Number(acquisition.changes) !== 1) {
          throw new Error('An acquisition license changed before attestation could finish.');
        }
        const license = this.db.raw.prepare(`
          UPDATE project_licenses
          SET license_state = ?, certificate_path = coalesce(?, certificate_path),
              operator_attested_at = coalesce(operator_attested_at, ?), updated_at = ?
          WHERE project_id = ? AND asset_id = ?
            AND license_state IN (${[...allowedStates].map(() => '?').join(',')})
        `).run(licenseState, certificatePath ?? null, now, now, projectId, item.asset_id, ...allowedStates);
        if (Number(license.changes) !== 1) {
          throw new Error('The matching project license is missing or no longer eligible for attestation.');
        }
      }
      this.db.raw.prepare(`
        INSERT INTO audit_log(
          project_id, action, actor, entity_type, entity_id,
          before_json, after_json, metadata_json, created_at
        ) VALUES(?, 'license.batch_attested', 'operator', 'project', ?, ?, ?, ?, ?)
      `).run(
        projectId,
        projectId,
        JSON.stringify({ acquisitionIds: uniqueIds, states: items.map(item => item.license_state) }),
        JSON.stringify({ acquisitionIds: uniqueIds, licenseState }),
        JSON.stringify({ count: items.length, certificateAttached: Boolean(certificatePath), certificateName: certificatePath ? basename(certificatePath) : null }),
        now
      );
    });
    transaction();

    for (const item of items) {
      if (item.state === 'LICENSE_ONLY_PENDING' && item.local_file_id) {
        await this.media.verifyLocalAsset(projectId, String(item.asset_id), String(item.local_file_id));
        this.db.raw.prepare(`
          UPDATE acquisition_items
          SET state = 'COMPLETE', updated_at = ?
          WHERE id = ? AND state = 'LICENSE_ONLY_PENDING'
        `).run(new Date().toISOString(), item.id);
      }
    }
    await this.media.reconcileAcquisition(projectId);
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
