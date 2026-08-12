import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { assembleAndNormalizeTimeline } from '@main/services/render-pipeline';
import { requireSuccess } from '@main/services/process-utils';

const root = mkdtempSync(join(tmpdir(), 'videofactory-render-pipeline-'));
const segment = join(root, 'segment.mp4');
const concat = join(root, 'concat.txt');
const assembled = join(root, 'assembled.mp4');
const output = join(root, 'output.mp4');

describe('render assembly and normalization pipeline', () => {
  beforeAll(async () => {
    if (!ffmpegPath) throw new Error('ffmpeg-static binary is unavailable.');
    await requireSuccess(ffmpegPath, [
      '-y', '-hide_banner',
      '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=1.8',
      '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=1.8',
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
      '-c:a', 'aac', '-profile:a', 'aac_low', '-ar', '48000', '-ac', '2',
      '-movflags', '+faststart', '-shortest', segment
    ]);
    writeFileSync(concat, `file '${segment.replace(/'/g, "'\\''")}'\n`, 'utf8');
  }, 30_000);

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('assembles before measuring and produces a two-pass normalized fast-start file', async () => {
    if (!ffmpegPath) throw new Error('ffmpeg-static binary is unavailable.');
    const measured = await assembleAndNormalizeTimeline({
      ffmpeg: ffmpegPath,
      concatPath: concat,
      assembledPath: assembled,
      outputPath: output,
      audioBitrate: '192k'
    });
    expect(existsSync(assembled)).toBe(true);
    expect(Number.isFinite(Number(measured.inputI))).toBe(true);

    const probeResult = await requireSuccess(ffprobeStatic.path, [
      '-v', 'error', '-show_format', '-show_streams', '-of', 'json', output
    ]);
    const probe = JSON.parse(probeResult.stdout) as { streams: Array<Record<string, unknown>> };
    const audio = probe.streams.find(stream => stream.codec_type === 'audio');
    expect(audio).toMatchObject({ codec_name: 'aac', profile: 'LC', sample_rate: '48000', channels: 2 });
    const bytes = readFileSync(output);
    expect(bytes.indexOf(Buffer.from('moov'))).toBeLessThan(bytes.indexOf(Buffer.from('mdat')));
  }, 30_000);
});
