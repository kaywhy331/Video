import { describe, expect, it } from 'vitest';
import {
  FFMPEG_BACKGROUND_RESOURCE_POLICY,
  backgroundFfmpegGlobalArguments,
  backgroundFfmpegThreadCount,
  backgroundFfmpegVideoArguments
} from '@shared/ffmpeg-resource-policy';

describe('background FFmpeg resource policy', () => {
  it('reserves interactive capacity on small and representative hosts', () => {
    expect(FFMPEG_BACKGROUND_RESOURCE_POLICY).toBe('interactive-reserve-v1');
    expect([1, 2, 3, 4, 8, 16, 64].map(backgroundFfmpegThreadCount)).toEqual([1, 1, 1, 2, 6, 8, 8]);
  });

  it('fails safe for invalid CPU counts and emits matching FFmpeg arguments', () => {
    expect(backgroundFfmpegThreadCount(Number.NaN)).toBe(1);
    expect(backgroundFfmpegThreadCount(Number.POSITIVE_INFINITY)).toBe(1);
    expect(backgroundFfmpegGlobalArguments(4)).toEqual([
      '-filter_threads', '2', '-filter_complex_threads', '2'
    ]);
    expect(backgroundFfmpegVideoArguments(4)).toEqual(['-threads', '2']);
  });
});
