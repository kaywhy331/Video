import { randomUUID } from 'node:crypto';
import { existsSync, statfsSync, statSync, unlinkSync } from 'node:fs';
import type { AppDatabase } from '../database/database';
import type { AppSettings, StorageCleanupReport } from '@shared/types';
import { pathIsInside } from '../security-policy';

interface Candidate {
  category: 'proxy' | 'contact_sheet' | 'segment_preview' | 'render_fragment';
  entityId: string;
  path: string;
  sizeBytes: number;
}

function jsonArray(value: unknown): string[] {
  try {
    const decoded = JSON.parse(String(value ?? '[]'));
    return Array.isArray(decoded) ? decoded.map(String) : [];
  } catch {
    return [];
  }
}

export class StorageService {
  constructor(
    private readonly db: AppDatabase,
    private readonly settings: () => AppSettings
  ) {}

  latest(): StorageCleanupReport | null {
    const row = this.db.raw.prepare('SELECT * FROM storage_cleanup_runs ORDER BY created_at DESC LIMIT 1').get() as Record<string, unknown> | undefined;
    return row ? this.fromRow(row) : null;
  }

  cleanup(options: {
    dryRun?: boolean;
    trigger?: 'manual' | 'disk_pressure' | 'startup';
  } = {}): StorageCleanupReport {
    const settings = this.settings();
    const dryRun = options.dryRun ?? false;
    const trigger = options.trigger ?? 'manual';
    const root = settings.mediaLibraryFolder;
    const runId = randomUUID();
    const createdAt = new Date().toISOString();
    const targetFreeBytes = Math.round((settings.minFreeDiskGb + settings.derivativeCleanupTargetGb) * 1024 ** 3);
    let freeBytesBefore: number | null = null;
    let freeBytesAfter: number | null = null;
    let removedBytes = 0;
    let removedCount = 0;
    const skipped: string[] = [];
    let candidates: Candidate[] = [];
    let status: StorageCleanupReport['status'] = 'planned';
    let error: string | null = null;
    try {
      const stats = statfsSync(root);
      freeBytesBefore = stats.bavail * stats.bsize;
      candidates = this.candidates();
      this.db.raw.prepare(`
        INSERT INTO storage_cleanup_runs(
          id, trigger, status, free_bytes_before, target_free_bytes,
          candidate_bytes, created_at
        ) VALUES(?, ?, 'planned', ?, ?, ?, ?)
      `).run(
        runId, trigger, freeBytesBefore, targetFreeBytes,
        candidates.reduce((total, item) => total + item.sizeBytes, 0), createdAt
      );
      for (const candidate of candidates) {
        const reason = pathIsInside(candidate.path, [root])
          ? 'Regenerable derivative outside the immutable original/music vaults.'
          : 'Skipped because the path is outside managed media storage.';
        this.db.raw.prepare(`
          INSERT INTO storage_cleanup_items(
            id, cleanup_run_id, category, entity_id, path, size_bytes,
            removed, reason, created_at
          ) VALUES(?, ?, ?, ?, ?, ?, 0, ?, ?)
        `).run(randomUUID(), runId, candidate.category, candidate.entityId, candidate.path, candidate.sizeBytes, reason, createdAt);
      }
      if (dryRun) {
        status = 'planned';
      } else if (freeBytesBefore >= targetFreeBytes) {
        status = 'not_needed';
      } else {
        for (const candidate of candidates) {
          if (freeBytesBefore + removedBytes >= targetFreeBytes) break;
          if (!pathIsInside(candidate.path, [root])) {
            skipped.push(`${candidate.category}:${candidate.path}:outside managed storage`);
            continue;
          }
          if (!existsSync(candidate.path)) {
            this.clearReference(candidate);
            skipped.push(`${candidate.category}:${candidate.path}:already missing`);
            continue;
          }
          try {
            unlinkSync(candidate.path);
            this.clearReference(candidate);
            removedBytes += candidate.sizeBytes;
            removedCount += 1;
            this.db.raw.prepare(`
              UPDATE storage_cleanup_items SET removed = 1 WHERE cleanup_run_id = ? AND category = ? AND entity_id = ?
            `).run(runId, candidate.category, candidate.entityId);
          } catch (caught) {
            skipped.push(`${candidate.category}:${candidate.path}:${caught instanceof Error ? caught.message : String(caught)}`);
          }
        }
        const after = statfsSync(root);
        freeBytesAfter = after.bavail * after.bsize;
        status = skipped.some(item => !item.endsWith(':already missing')) ? 'partial' : 'complete';
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message.slice(0, 1_000) : String(caught).slice(0, 1_000);
      status = 'failed';
      if (!this.db.raw.prepare('SELECT 1 FROM storage_cleanup_runs WHERE id = ?').get(runId)) {
        this.db.raw.prepare(`
          INSERT INTO storage_cleanup_runs(
            id, trigger, status, target_free_bytes, error, created_at, completed_at
          ) VALUES(?, ?, 'failed', ?, ?, ?, ?)
        `).run(runId, trigger, targetFreeBytes, error, createdAt, new Date().toISOString());
      }
    }
    const completedAt = new Date().toISOString();
    this.db.raw.prepare(`
      UPDATE storage_cleanup_runs SET status = ?, free_bytes_after = ?, removed_bytes = ?,
        removed_count = ?, skipped_json = ?, error = ?, completed_at = ? WHERE id = ?
    `).run(status, freeBytesAfter, removedBytes, removedCount, JSON.stringify(skipped), error, completedAt, runId);
    return this.fromRow(this.db.raw.prepare('SELECT * FROM storage_cleanup_runs WHERE id = ?').get(runId) as Record<string, unknown>);
  }

  private candidates(): Candidate[] {
    const values: Candidate[] = [];
    const add = (category: Candidate['category'], entityId: unknown, path: unknown): void => {
      const filePath = path ? String(path) : '';
      if (!filePath) return;
      const sizeBytes = existsSync(filePath) ? statSync(filePath).size : 0;
      values.push({ category, entityId: String(entityId), path: filePath, sizeBytes });
    };
    for (const row of this.db.raw.prepare(`SELECT id, proxy_path, contact_sheet_path, created_at FROM asset_files ORDER BY created_at`).all() as Array<Record<string, unknown>>) {
      add('proxy', row.id, row.proxy_path);
      add('contact_sheet', row.id, row.contact_sheet_path);
    }
    for (const row of this.db.raw.prepare(`SELECT id, preview_path, created_at FROM media_segments WHERE preview_path IS NOT NULL ORDER BY created_at`).all() as Array<Record<string, unknown>>) {
      add('segment_preview', row.id, row.preview_path);
    }
    for (const row of this.db.raw.prepare(`
      SELECT id, output_path, updated_at FROM render_fragments
      WHERE status IN ('stale','failed') ORDER BY updated_at
    `).all() as Array<Record<string, unknown>>) {
      add('render_fragment', row.id, row.output_path);
    }
    return values.sort((left, right) => right.sizeBytes - left.sizeBytes || left.path.localeCompare(right.path));
  }

  private clearReference(candidate: Candidate): void {
    if (candidate.category === 'proxy') this.db.raw.prepare('UPDATE asset_files SET proxy_path = NULL WHERE id = ?').run(candidate.entityId);
    else if (candidate.category === 'contact_sheet') this.db.raw.prepare('UPDATE asset_files SET contact_sheet_path = NULL WHERE id = ?').run(candidate.entityId);
    else if (candidate.category === 'segment_preview') this.db.raw.prepare('UPDATE media_segments SET preview_path = NULL WHERE id = ?').run(candidate.entityId);
    else this.db.raw.prepare(`UPDATE render_fragments SET status = 'stale', updated_at = ? WHERE id = ?`).run(new Date().toISOString(), candidate.entityId);
  }

  private fromRow(row: Record<string, unknown>): StorageCleanupReport {
    return {
      id: String(row.id), trigger: row.trigger as StorageCleanupReport['trigger'],
      status: row.status as StorageCleanupReport['status'],
      freeBytesBefore: row.free_bytes_before === null ? null : Number(row.free_bytes_before),
      freeBytesAfter: row.free_bytes_after === null ? null : Number(row.free_bytes_after),
      targetFreeBytes: Number(row.target_free_bytes), candidateBytes: Number(row.candidate_bytes),
      removedBytes: Number(row.removed_bytes), removedCount: Number(row.removed_count),
      skipped: jsonArray(row.skipped_json), error: row.error ? String(row.error) : null,
      createdAt: String(row.created_at), completedAt: row.completed_at ? String(row.completed_at) : null
    };
  }
}
