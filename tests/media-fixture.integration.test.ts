import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { requireSuccess } from '@main/services/process-utils';
import { parseBlackIntervals, parseFreezeIntervals } from '@shared/media-analysis';

const root = mkdtempSync(join(tmpdir(), 'videofactory-media-fixture-'));
const output = join(root, 'fixture.mp4');

describe('real FFmpeg production fixture', () => {
  beforeAll(async () => {
    if (!ffmpegPath) throw new Error('ffmpeg-static binary is unavailable.');
    await requireSuccess(ffmpegPath, [
      '-y', '-hide_banner',
      '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
      '-c:a', 'aac', '-ar', '48000', '-ac', '2',
      '-movflags', '+faststart', '-shortest', output
    ]);
  }, 30_000);

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('probes as the required 1080p H.264/AAC profile', async () => {
    const result = await requireSuccess(ffprobeStatic.path, [
      '-v', 'error', '-show_format', '-show_streams', '-of', 'json', output
    ]);
    const probe = JSON.parse(result.stdout) as { streams: Array<Record<string, unknown>> };
    const video = probe.streams.find(stream => stream.codec_type === 'video');
    const audio = probe.streams.find(stream => stream.codec_type === 'audio');
    expect(video).toMatchObject({ codec_name: 'h264', width: 1920, height: 1080, pix_fmt: 'yuv420p' });
    expect(audio).toMatchObject({ codec_name: 'aac', sample_rate: '48000', channels: 2 });
  });

  it('contains fast-start metadata before the media payload', () => {
    const buffer = readFileSync(output);
    expect(buffer.indexOf(Buffer.from('moov'))).toBeGreaterThan(0);
    expect(buffer.indexOf(Buffer.from('moov'))).toBeLessThan(buffer.indexOf(Buffer.from('mdat')));
  });

  it('returns finite EBU R128 loudness measurements', async () => {
    if (!ffmpegPath) throw new Error('ffmpeg-static binary is unavailable.');
    const result = await requireSuccess(ffmpegPath, [
      '-hide_banner', '-nostats', '-i', output,
      '-map', '0:a:0', '-af', 'loudnorm=I=-14:TP=-1:LRA=11:print_format=json', '-f', 'null', '-'
    ]);
    const statsText = result.stderr.match(/\{\s*"input_i"[\s\S]*?\}/g)?.at(-1);
    expect(statsText).toBeTruthy();
    const stats = JSON.parse(statsText!) as Record<string, string>;
    expect(Number.isFinite(Number(stats.input_i))).toBe(true);
    expect(Number.isFinite(Number(stats.input_tp))).toBe(true);
  });

  it('executes black/freeze analysis with parseable output', async () => {
    if (!ffmpegPath) throw new Error('ffmpeg-static binary is unavailable.');
    const result = await requireSuccess(ffmpegPath, [
      '-hide_banner', '-nostats', '-i', output,
      '-vf', 'blackdetect=d=0.20:pix_th=0.10,freezedetect=n=-50dB:d=0.50', '-an', '-f', 'null', '-'
    ]);
    expect(parseBlackIntervals(result.stderr)).toEqual([]);
    expect(parseFreezeIntervals(result.stderr, 2_000)).toEqual([]);
  });
}, 30_000);
