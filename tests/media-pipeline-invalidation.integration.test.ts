import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { AppDatabase } from '@main/database/database';
import { MediaService } from '@main/services/media-service';
import { requireSuccess } from '@main/services/process-utils';
import type { AppSettings } from '@shared/types';

const root = mkdtempSync(join(tmpdir(), 'videofactory-media-invalidation-'));
const mediaLibraryFolder = join(root, 'media');
const originalPath = join(root, 'original.mp4');
let db: AppDatabase;

describe('media pipeline invalidation (MED-011)', () => {
  beforeAll(async () => {
    if (!ffmpegPath) throw new Error('ffmpeg-static binary is unavailable.');
    await requireSuccess(ffmpegPath, [
      '-y', '-hide_banner',
      '-f', 'lavfi', '-i', 'testsrc2=size=3840x2160:rate=5:duration=2',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-color_range', 'tv', '-colorspace', 'bt709',
      '-color_primaries', 'bt709', '-color_trc', 'bt709',
      '-an', originalPath
    ]);
    const probe = await requireSuccess(ffprobeStatic.path, [
      '-v', 'error', '-show_format', '-show_streams', '-of', 'json', originalPath
    ]);
    const bytes = readFileSync(originalPath);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const now = new Date().toISOString();
    db = new AppDatabase(join(root, 'videofactory.sqlite'));
    db.raw.prepare(`
      INSERT INTO assets(
        id, stable_key, title, orientation, location_granularity,
        location_confidence, verification_status, availability_status,
        raw_row_json, imported_at, updated_at
      ) VALUES('asset-1', 'asset-1', 'Pipeline fixture', 'landscape', 'unknown',
        0, 'metadata', 'available', '{}', ?, ?)
    `).run(now, now);
    db.raw.prepare(`
      INSERT INTO asset_files(
        id, asset_id, sha256, original_path, original_file_name, file_size_bytes,
        duration_ms, width, height, frame_rate, codec, pixel_format, color_space,
        audio_present, raw_ffprobe_json, pipeline_version, created_at
      ) VALUES('file-1', 'asset-1', ?, ?, 'original.mp4', ?, 2000,
        640, 360, 30, 'h264', 'yuv420p', 'bt709', 0, ?, 'media-v1', ?)
    `).run(sha256, originalPath, statSync(originalPath).size, probe.stdout, now);
    db.raw.prepare(`
      INSERT INTO media_segments(
        id, asset_file_id, start_ms, end_ms, duration_ms, quality_score,
        black_frame_risk, freeze_risk, effective_width, effective_height,
        eligible_1080p, eligible_4k, pipeline_version, created_at
      ) VALUES('segment-stable', 'file-1', 0, 2000, 2000, 0.1,
        0.9, 0.9, 640, 360, 0, 0, 'media-v1', ?)
    `).run(now);
  }, 30_000);

  afterAll(() => {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('[MED-001][MED-002][MED-003][MED-010][MED-011] regenerates versioned derivatives, preserves the original, and reuses current analysis', async () => {
    const beforeHash = createHash('sha256').update(readFileSync(originalPath)).digest('hex');
    const progress = vi.fn();
    const service = new MediaService(
      db,
      () => ({
        ffmpegPath: ffmpegPath ?? '',
        ffprobePath: ffprobeStatic.path,
        mediaLibraryFolder
      } as AppSettings),
      {} as never,
      progress
    );

    expect(service.staleDerivativeCount()).toBe(1);
    await expect(service.refreshStaleDerivatives()).resolves.toBe(1);
    expect(service.staleDerivativeCount()).toBe(0);
    expect(createHash('sha256').update(readFileSync(originalPath)).digest('hex')).toBe(beforeHash);
    const refreshedFile = db.raw.prepare(`
      SELECT width, height, frame_rate, codec, pipeline_version, proxy_path,
        contact_sheet_path, perceptual_hash
      FROM asset_files WHERE id = 'file-1'
    `).get() as Record<string, unknown>;
    expect(refreshedFile).toEqual({
      width: 3840,
      height: 2160,
      frame_rate: 5,
      codec: 'h264',
      pipeline_version: MediaService.PIPELINE_VERSION,
      proxy_path: expect.stringMatching(/\.mp4$/),
      contact_sheet_path: expect.stringMatching(/\.jpg$/),
      perceptual_hash: expect.stringMatching(/^[0-9a-f]{16}$/)
    });
    const proxyProbe = JSON.parse((await requireSuccess(ffprobeStatic.path, [
      '-v', 'error', '-show_streams', '-of', 'json', String(refreshedFile.proxy_path)
    ])).stdout) as { streams: Array<Record<string, unknown>> };
    expect(proxyProbe.streams.find(stream => stream.codec_type === 'video'))
      .toMatchObject({ width: 1280, height: 720, codec_name: 'h264' });
    expect(db.raw.prepare(`
      SELECT id, pipeline_version, black_frame_risk, freeze_risk
      FROM media_segments WHERE asset_file_id = 'file-1'
      ORDER BY start_ms, end_ms LIMIT 1
    `).get()).toMatchObject({
      id: 'segment-stable',
      pipeline_version: MediaService.PIPELINE_VERSION,
      black_frame_risk: 0,
      freeze_risk: 0
    });
    expect(progress).toHaveBeenLastCalledWith(
      null, 'media-pipeline-refresh', 1, 'Regenerated 1 stale media derivative set(s)'
    );
    progress.mockClear();
    await expect(service.refreshStaleDerivatives()).resolves.toBe(0);
    expect(progress).not.toHaveBeenCalled();
    expect(db.integrityCheck()).toBe('ok');
  }, 30_000);
});
