import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase } from '@main/database/database';
import { StorageService } from '@main/services/storage-service';
import type { AppSettings } from '@shared/types';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('regenerable derivative cleanup', () => {
  it('removes managed derivatives and preserves immutable originals and licensed music', () => {
    const root = mkdtempSync(join(tmpdir(), 'videofactory-storage-'));
    roots.push(root);
    const media = join(root, 'media');
    const proxy = join(media, 'proxies', 'proxy.mp4');
    const contact = join(media, 'keyframes', 'contact.jpg');
    const preview = join(media, 'segments', 'preview.mp4');
    const original = join(media, 'originals', 'original.mp4');
    const music = join(media, 'music', 'licensed.wav');
    for (const path of [proxy, contact, preview, original, music]) {
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, Buffer.alloc(1024, path.includes('original') ? 1 : 2));
    }
    const db = new AppDatabase(join(root, 'db.sqlite'));
    const now = new Date().toISOString();
    db.raw.prepare(`INSERT INTO assets(id, stable_key, title, raw_row_json, imported_at, updated_at) VALUES('asset-1','asset-1','Asset','{}',?,?)`).run(now, now);
    db.raw.prepare(`
      INSERT INTO asset_files(id, asset_id, sha256, original_path, proxy_path, contact_sheet_path, original_file_name, file_size_bytes, duration_ms, width, height, frame_rate, codec, raw_ffprobe_json, pipeline_version, created_at)
      VALUES('file-1','asset-1','source-hash',?,?,?,'original.mp4',1024,1000,1920,1080,30,'h264','{}','fixture',?)
    `).run(original, proxy, contact, now);
    db.raw.prepare(`
      INSERT INTO media_segments(id, asset_file_id, start_ms, end_ms, duration_ms, quality_score, effective_width, effective_height, eligible_1080p, eligible_4k, preview_path, pipeline_version, created_at)
      VALUES('segment-1','file-1',0,1000,1000,1,1920,1080,1,0,?,'fixture',?)
    `).run(preview, now);
    db.raw.prepare(`
      INSERT INTO music_tracks(id, sha256, original_path, original_file_name, title, provider, license_type, license_reference, license_verified_at, duration_ms, raw_probe_json, imported_at, updated_at)
      VALUES('music-1','music-hash',?,'licensed.wav','Licensed','Fixture','project','receipt',?,1000,'{}',?,?)
    `).run(music, now, now, now);
    const settings = {
      mediaLibraryFolder: media,
      minFreeDiskGb: 1_000_000,
      derivativeCleanupTargetGb: 1
    } as AppSettings;
    const service = new StorageService(db, () => settings);
    const plan = service.cleanup({ dryRun: true });
    expect(plan.candidateBytes).toBe(3 * 1024);
    expect(existsSync(proxy)).toBe(true);
    const report = service.cleanup({ trigger: 'manual' });
    expect(report).toMatchObject({ status: 'complete', removedCount: 3, removedBytes: 3 * 1024 });
    for (const path of [proxy, contact, preview]) expect(existsSync(path)).toBe(false);
    for (const path of [original, music]) expect(existsSync(path)).toBe(true);
    expect(db.raw.prepare('SELECT proxy_path, contact_sheet_path FROM asset_files WHERE id = ?').get('file-1'))
      .toEqual({ proxy_path: null, contact_sheet_path: null });
    expect(db.raw.prepare('SELECT preview_path FROM media_segments WHERE id = ?').get('segment-1'))
      .toEqual({ preview_path: null });
    db.close();
  });
});
