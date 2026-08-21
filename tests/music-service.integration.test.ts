import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { AppDatabase } from '@main/database/database';
import { MusicService } from '@main/services/music-service';
import { assembleAndNormalizeTimeline } from '@main/services/render-pipeline';
import { requireSuccess } from '@main/services/process-utils';
import type { AppSettings } from '@shared/types';

const root = mkdtempSync(join(tmpdir(), 'videofactory-music-'));
const musicPath = join(root, 'licensed.wav');
const segmentPath = join(root, 'segment.mp4');
const concatPath = join(root, 'concat.txt');
const assembledPath = join(root, 'assembled.mp4');
const outputPath = join(root, 'output.mp4');
let db: AppDatabase;
let service: MusicService;

describe('licensed music import, selection, ducking, and fade QC', () => {
  beforeAll(async () => {
    if (!ffmpegPath) throw new Error('ffmpeg-static is unavailable.');
    await requireSuccess(ffmpegPath, [
      '-y', '-hide_banner', '-f', 'lavfi', '-i', 'sine=frequency=160:sample_rate=48000:duration=3',
      '-c:a', 'pcm_s16le', musicPath
    ]);
    await requireSuccess(ffmpegPath, [
      '-y', '-hide_banner', '-f', 'lavfi', '-i', 'color=c=blue:s=1280x720:r=30:d=2.4',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2.4',
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-shortest', segmentPath
    ]);
    writeFileSync(concatPath, `file '${segmentPath}'\n`, 'utf8');
    db = new AppDatabase(join(root, 'db.sqlite'));
    const settings = {
      mediaLibraryFolder: join(root, 'media'),
      ffprobePath: ffprobeStatic.path,
      musicTargetGainDb: -24,
      musicDuckingDb: -12
    } as AppSettings;
    service = new MusicService(db, () => settings);
    const now = new Date().toISOString();
    db.raw.prepare(`
      INSERT INTO projects(id, sequence, slug, title, topic, state, progress, envato_project_name, target_duration_ms, created_at, updated_at)
      VALUES('project-1', 1, 'music', 'Music', 'Music', 'CREATED', 0, 'YT-MUSIC', 2400, ?, ?)
    `).run(now, now);
  }, 30_000);

  afterAll(() => {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('preserves a licensed hash, snapshots project use, and produces a ducked/faded final mix', async () => {
    const sourceHash = await import('node:crypto').then(({ createHash }) => createHash('sha256').update(readFileSync(musicPath)).digest('hex'));
    const track = await service.import({
      filePath: musicPath,
      title: 'Fixture bed',
      provider: 'Fixture library',
      licenseType: 'project license',
      licenseReference: 'fixture-receipt-001',
      moods: ['warm', 'documentary'],
      tempoBpm: 80,
      loopable: true,
      licenseAttested: true
    });
    expect(track.sha256).toBe(sourceHash);
    expect(existsSync(track.originalPath)).toBe(true);
    expect(readFileSync(track.originalPath)).toEqual(readFileSync(musicPath));
    const selection = service.select('project-1', track.id);
    expect(selection).toMatchObject({ targetGainDb: -24, duckingDb: -12, fadeOutMs: 1000 });
    expect(selection.licenseSnapshot).toMatchObject({ sha256: sourceHash, licenseReference: 'fixture-receipt-001' });

    await assembleAndNormalizeTimeline({
      ffmpeg: ffmpegPath!, concatPath, assembledPath, outputPath, audioBitrate: '192k',
      music: {
        path: track.originalPath,
        durationMs: 2400,
        policy: { targetGainDb: -24, duckingDb: -12, fadeInMs: 750, fadeOutMs: 1000 }
      }
    });
    expect(existsSync(outputPath)).toBe(true);
    const probe = await requireSuccess(ffprobeStatic.path, ['-v', 'error', '-show_streams', '-of', 'json', outputPath]);
    const audio = (JSON.parse(probe.stdout) as { streams: Array<Record<string, unknown>> }).streams.find(stream => stream.codec_type === 'audio');
    expect(audio).toMatchObject({ codec_name: 'aac', sample_rate: '48000', channels: 2 });
  }, 30_000);
});
