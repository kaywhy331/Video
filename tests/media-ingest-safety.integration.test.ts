import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { AppDatabase } from '@main/database/database';
import { DownloadWatcher } from '@main/services/download-watcher';
import { MediaService } from '@main/services/media-service';
import { requireSuccess } from '@main/services/process-utils';
import type { AppSettings } from '@shared/types';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(assetCount: number) {
  const root = mkdtempSync(join(tmpdir(), 'videofactory-ingest-safety-'));
  roots.push(root);
  const ingestFolder = join(root, 'ingest');
  mkdirSync(ingestFolder, { recursive: true });
  const mediaLibraryFolder = join(root, 'media');
  const db = new AppDatabase(join(root, 'db.sqlite'));
  const now = new Date().toISOString();
  db.raw.prepare(`
    INSERT INTO projects(
      id, sequence, slug, title, topic, state, progress, envato_project_name,
      target_duration_ms, created_at, updated_at
    ) VALUES('project-1', 1, 'project-1', 'Project', 'Topic',
      'WAITING_FOR_DOWNLOADS', 0.3, 'YT-SAFETY-1', 300000, ?, ?)
  `).run(now, now);
  for (let index = 1; index <= assetCount; index += 1) {
    db.raw.prepare(`
      INSERT INTO assets(
        id, stable_key, title, orientation, location_granularity,
        location_confidence, verification_status, availability_status,
        raw_row_json, imported_at, updated_at
      ) VALUES(?, ?, ?, 'landscape', 'unknown', 0.5, 'metadata', 'available', '{}', ?, ?)
    `).run(`asset-${index}`, `asset-${index}`, `Asset ${index}`, now, now);
  }
  const targetAssetId = `asset-${assetCount}`;
  db.raw.prepare(`
    INSERT INTO acquisition_items(
      id, project_id, asset_id, ordinal, role, state, source_url,
      required_scene_ordinals_json, match_score, reasons_json, active_at,
      created_at, updated_at
    ) VALUES('acquisition-1', 'project-1', ?, 1, 'primary', 'WAITING_FOR_FILE',
      'https://elements.envato.com/safety-fixture', '[1]', 99, '[]', ?, ?, ?)
  `).run(targetAssetId, now, now, now);
  const settings = () => ({
    ingestFolder,
    mediaLibraryFolder,
    ffmpegPath: ffmpegPath ?? '',
    ffprobePath: ffprobeStatic.path
  } as AppSettings);
  const media = new MediaService(db, settings, {} as never, () => undefined);
  const notify = vi.fn();
  const watcher = new DownloadWatcher(db, media, settings, notify, async () => true);
  return { root, ingestFolder, mediaLibraryFolder, db, media, watcher, notify, targetAssetId };
}

describe('media ingest failure isolation', () => {
  it('[ACQ-010] quarantines a known physical file assigned to the wrong expected asset', async () => {
    const value = fixture(2);
    const bytes = Buffer.from('known physical file owned by asset one');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const libraryOriginal = join(value.root, 'owned-original.mp4');
    const detectedPath = join(value.root, 'wrong-for-asset-two.mp4');
    writeFileSync(libraryOriginal, bytes);
    writeFileSync(detectedPath, bytes);
    value.db.raw.prepare(`
      INSERT INTO asset_files(
        id, asset_id, sha256, original_path, original_file_name, file_size_bytes,
        duration_ms, width, height, frame_rate, codec, audio_present,
        raw_ffprobe_json, pipeline_version, created_at
      ) VALUES('file-owned', 'asset-1', ?, ?, 'owned-original.mp4', ?, 5000,
        1920, 1080, 30, 'h264', 0, '{}', ?, ?)
    `).run(
      sha256,
      libraryOriginal,
      bytes.length,
      MediaService.PIPELINE_VERSION,
      new Date().toISOString()
    );

    value.watcher.processAddedFile(detectedPath);
    await value.watcher.stop();

    const quarantinePath = join(
      value.mediaLibraryFolder,
      'quarantine',
      `${sha256.slice(0, 12)}-wrong-for-asset-two.mp4`
    );
    expect(existsSync(detectedPath)).toBe(false);
    expect(existsSync(quarantinePath)).toBe(true);
    expect(value.db.raw.prepare(`
      SELECT state, mapped_file_id FROM acquisition_items WHERE id = 'acquisition-1'
    `).get()).toEqual({ state: 'FAILED', mapped_file_id: null });
    expect(value.db.raw.prepare(`
      SELECT code, stage, status, message FROM exceptions WHERE project_id = 'project-1'
    `).get()).toMatchObject({
      code: 'INGEST_FAILED',
      stage: 'media',
      status: 'OPEN',
      message: expect.stringContaining('different catalog asset')
    });
    expect(value.db.raw.prepare(`SELECT local_file_id FROM assets WHERE id = ?`).get(value.targetAssetId))
      .toEqual({ local_file_id: null });
    expect(value.db.integrityCheck()).toBe('ok');
    value.db.close();
  });

  it('[MED-006] turns a corrupt fixture into one media exception without escaping the watcher task', async () => {
    const value = fixture(1);
    const bytes = Buffer.from('this is deliberately not a media container');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const detectedPath = join(value.root, 'corrupt.mp4');
    writeFileSync(detectedPath, bytes);

    value.watcher.processAddedFile(detectedPath);
    await expect(value.watcher.stop()).resolves.toBeUndefined();

    const quarantinePath = join(
      value.mediaLibraryFolder,
      'quarantine',
      `${sha256.slice(0, 12)}-corrupt.mp4`
    );
    expect(existsSync(detectedPath)).toBe(false);
    expect(existsSync(quarantinePath)).toBe(true);
    expect(value.db.raw.prepare(`SELECT count(*) AS count FROM asset_files`).get())
      .toEqual({ count: 0 });
    expect(value.db.raw.prepare(`
      SELECT code, stage, status, message FROM exceptions WHERE project_id = 'project-1'
    `).get()).toMatchObject({
      code: 'INGEST_FAILED',
      stage: 'media',
      status: 'OPEN',
      message: expect.stringContaining('corrupt or unsupported')
    });
    expect(value.notify).toHaveBeenCalledWith('VideoFactory could not ingest corrupt.mp4.');
    expect(value.db.integrityCheck()).toBe('ok');
    value.db.close();
  }, 30_000);

  it('[E2E-004] resumes a real media ingest after the service host is killed at the derivative boundary', async () => {
    if (!ffmpegPath) throw new Error('ffmpeg-static binary is unavailable.');
    const value = fixture(1);
    const detectedPath = join(value.ingestFolder, 'crash-source.mp4');
    await requireSuccess(ffmpegPath, [
      '-y', '-hide_banner',
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=15:duration=4',
      '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', detectedPath
    ]);
    value.db.raw.prepare(`
      UPDATE acquisition_items SET state = 'FILE_STABLE', detected_path = ?,
        mapping_confidence = 1, mapping_evidence_json = ?, updated_at = ?
      WHERE id = 'acquisition-1'
    `).run(
      detectedPath,
      JSON.stringify({ method: 'forced_termination_fixture', fileName: 'crash-source.mp4' }),
      new Date().toISOString()
    );
    value.db.close();

    const child = spawnSync(process.execPath, [
      resolve('node_modules/vite-node/vite-node.mjs'),
      `--config=${resolve('vitest.config.ts')}`,
      resolve('tests/fixtures/media-ingest-crash-host.ts')
    ], {
      cwd: process.cwd(),
      env: { ...process.env, VIDEOFACTORY_INGEST_CRASH_ROOT: value.root },
      encoding: 'utf8',
      timeout: 60_000
    });
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.stdout, child.stderr).toContain('VIDEOFACTORY_INGEST_CHECKPOINT_READY');
    expect(child.status, child.stderr).not.toBe(0);

    const restartedDb = new AppDatabase(join(value.root, 'db.sqlite'));
    const interrupted = restartedDb.raw.prepare(`
      SELECT state, detected_path, mapping_evidence_json
      FROM acquisition_items WHERE id = 'acquisition-1'
    `).get() as Record<string, unknown>;
    const checkpoint = JSON.parse(String(interrupted.mapping_evidence_json)).ingestCheckpoint as {
      sha256: string;
      originalPath: string;
      sourceFileName: string;
      phase: string;
    };
    expect(interrupted).toMatchObject({ state: 'FILE_STABLE', detected_path: detectedPath });
    expect(checkpoint, child.stderr).toMatchObject({ sourceFileName: 'crash-source.mp4', phase: 'original_preserved' });
    expect(existsSync(detectedPath)).toBe(false);
    expect(existsSync(checkpoint.originalPath)).toBe(true);

    const settings = () => ({
      ingestFolder: value.ingestFolder,
      mediaLibraryFolder: value.mediaLibraryFolder,
      ffmpegPath,
      ffprobePath: ffprobeStatic.path
    } as AppSettings);
    const restartedMedia = new MediaService(restartedDb, settings, {} as never, () => undefined);
    await expect(restartedMedia.recoverInterruptedIngests()).resolves.toEqual({
      recovered: 1,
      failed: 0,
      reconciledProjects: 0
    });
    const completed = restartedDb.raw.prepare(`
      SELECT state, mapped_file_id, mapping_evidence_json
      FROM acquisition_items WHERE id = 'acquisition-1'
    `).get() as Record<string, unknown>;
    expect(completed).toMatchObject({ state: 'COMPLETE', mapped_file_id: expect.any(String) });
    expect(JSON.parse(String(completed.mapping_evidence_json)).ingestCheckpoint)
      .toMatchObject({ sha256: checkpoint.sha256, originalPath: checkpoint.originalPath, phase: 'complete' });
    expect(restartedDb.raw.prepare(`SELECT count(*) AS count FROM asset_files`).get()).toEqual({ count: 1 });
    const segmentCount = restartedDb.raw.prepare(`SELECT count(*) AS count FROM media_segments`).get() as { count: number };
    expect(segmentCount.count).toBeGreaterThan(0);
    expect(restartedDb.raw.prepare(`
      SELECT action, actor, entity_type, entity_id, after_json, metadata_json
      FROM audit_log WHERE action = 'media.ingest_recovered'
    `).get()).toMatchObject({
      action: 'media.ingest_recovered',
      actor: 'system',
      entity_type: 'acquisition_item',
      entity_id: 'acquisition-1',
      after_json: expect.stringContaining('"checkpointPhase":"complete"'),
      metadata_json: '{"trigger":"startup_recovery"}'
    });
    expect(restartedDb.integrityCheck()).toBe('ok');
    restartedDb.close();
  }, 120_000);

  it('fails closed when an interrupted ingest checkpoint points outside managed storage', async () => {
    const value = fixture(1);
    const outsidePath = join(value.root, 'outside-managed-storage.mp4');
    writeFileSync(outsidePath, 'must remain untouched');
    value.db.raw.prepare(`
      UPDATE acquisition_items SET state = 'PROCESSING', detected_path = ?,
        mapping_evidence_json = ?, updated_at = ? WHERE id = 'acquisition-1'
    `).run(
      join(value.root, 'missing-detected.mp4'),
      JSON.stringify({
        method: 'recovery_fixture',
        ingestCheckpoint: {
          sha256: 'a'.repeat(64),
          originalPath: outsidePath,
          sourceFileName: 'outside-managed-storage.mp4',
          phase: 'original_preserved',
          updatedAt: new Date().toISOString()
        }
      }),
      new Date().toISOString()
    );

    await expect(value.media.recoverInterruptedIngests()).resolves.toEqual({
      recovered: 0,
      failed: 1,
      reconciledProjects: 0
    });
    expect(existsSync(outsidePath)).toBe(true);
    expect(value.db.raw.prepare(`SELECT state, error FROM acquisition_items WHERE id = 'acquisition-1'`).get())
      .toMatchObject({ state: 'FAILED', error: expect.stringContaining('missing') });
    expect(value.db.raw.prepare(`SELECT code, status FROM exceptions WHERE project_id = 'project-1'`).get())
      .toEqual({ code: 'INGEST_RECOVERY_FAILED', status: 'OPEN' });
    expect(value.db.integrityCheck()).toBe('ok');
    value.db.close();
  });
});
