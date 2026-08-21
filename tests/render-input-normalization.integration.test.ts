import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { requireSuccess } from '@main/services/process-utils';
import { buildFootageVideoFilter } from '@shared/render-video-policy';

const root = mkdtempSync(join(tmpdir(), 'videofactory-input-normalization-'));
const inputs = [join(root, '24.mp4'), join(root, '2997.mp4'), join(root, '30.mp4')];
const alphaInput = join(root, 'alpha.mov');
const normalized = inputs.map((_, index) => join(root, `normalized-${index}.mp4`));
const normalizedAlpha = join(root, 'normalized-alpha.mp4');
const concatPath = join(root, 'concat.txt');
const combined = join(root, 'combined.mp4');
const filter = buildFootageVideoFilter({ scaleFilter: 'scale=320:180' });

async function probe(path: string): Promise<{ streams: Array<Record<string, unknown>>; format: Record<string, unknown> }> {
  const result = await requireSuccess(ffprobeStatic.path, [
    '-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', path
  ]);
  return JSON.parse(result.stdout) as { streams: Array<Record<string, unknown>>; format: Record<string, unknown> };
}

describe('production input normalization fixtures', () => {
  beforeAll(async () => {
    if (!ffmpegPath) throw new Error('ffmpeg-static binary is unavailable.');
    for (const [index, rate] of ['24', '30000/1001', '30'].entries()) {
      await requireSuccess(ffmpegPath, [
        '-y', '-hide_banner', '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=${rate}:duration=1`,
        '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', inputs[index]!
      ]);
      await requireSuccess(ffmpegPath, [
        '-y', '-hide_banner', '-i', inputs[index]!, '-vf', filter,
        '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', normalized[index]!
      ]);
    }
    await requireSuccess(ffmpegPath, [
      '-y', '-hide_banner', '-f', 'lavfi', '-i', 'color=c=red@0.25:size=320x180:rate=24:duration=1,format=rgba',
      '-an', '-c:v', 'qtrle', alphaInput
    ]);
    await requireSuccess(ffmpegPath, [
      '-y', '-hide_banner', '-i', alphaInput, '-vf', filter,
      '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', normalizedAlpha
    ]);
    writeFileSync(concatPath, normalized.map(path => `file '${path}'`).join('\n'), 'utf8');
    await requireSuccess(ffmpegPath, [
      '-y', '-hide_banner', '-f', 'concat', '-safe', '0', '-i', concatPath,
      '-c', 'copy', '-movflags', '+faststart', combined
    ]);
  }, 60_000);

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('[REN-009] converts 24/29.97/30 inputs to 30 fps with correct duration and no interpolation filter', async () => {
    expect(filter).toContain('fps=30');
    expect(filter).not.toContain('minterpolate');
    for (const path of normalized) {
      const video = (await probe(path)).streams.find(stream => stream.codec_type === 'video')!;
      expect(video.avg_frame_rate).toBe('30/1');
      expect(Number(video.nb_read_frames)).toBe(30);
    }
    const result = await probe(combined);
    expect(Number(result.format.duration)).toBeGreaterThanOrEqual(2.95);
    expect(Number(result.format.duration)).toBeLessThanOrEqual(3.05);
    expect(result.streams.find(stream => stream.codec_type === 'video')).toMatchObject({
      avg_frame_rate: '30/1', pix_fmt: 'yuv420p'
    });
  });

  it('[REN-010] flattens an alpha-bearing source to an opaque yuv420p final profile', async () => {
    const sourceVideo = (await probe(alphaInput)).streams.find(stream => stream.codec_type === 'video')!;
    expect(String(sourceVideo.pix_fmt)).toMatch(/argb|bgra|rgba|yuva/);
    const outputVideo = (await probe(normalizedAlpha)).streams.find(stream => stream.codec_type === 'video')!;
    expect(outputVideo.pix_fmt).toBe('yuv420p');
    expect(String(outputVideo.pix_fmt)).not.toContain('a');
    expect(Number(outputVideo.nb_read_frames)).toBe(30);
  });
});
