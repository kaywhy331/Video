import { describe, expect, it } from 'vitest';
import {
  captionViolations,
  cropRetentionFraction,
  duplicateShotPairs,
  insufficientResolutionOrdinals,
  severeCropOrdinals,
  silenceViolations,
  unsafePromiseIndexes,
  validateChapters
} from '@shared/qc';
import { parseSilenceIntervals } from '@shared/media-analysis';

describe('expanded render QC policy', () => {
  it('detects overlapping source reuse and severe crop while exempting generated graphics', () => {
    const shots = [
      { sceneId: 'a', ordinal: 1, sourceHash: 'same', sourceStartMs: 0, sourceEndMs: 5000, sourceWidth: 1920, sourceHeight: 1080, outputWidth: 1920, outputHeight: 1080, generatedGraphic: false },
      { sceneId: 'b', ordinal: 2, sourceHash: 'same', sourceStartMs: 1000, sourceEndMs: 5000, sourceWidth: 1080, sourceHeight: 1920, outputWidth: 1920, outputHeight: 1080, generatedGraphic: false },
      { sceneId: 'c', ordinal: 3, sourceHash: 'same', sourceStartMs: 0, sourceEndMs: 5000, sourceWidth: 100, sourceHeight: 100, outputWidth: 1920, outputHeight: 1080, generatedGraphic: true }
    ];
    expect(duplicateShotPairs(shots)).toEqual([
      expect.objectContaining({ leftOrdinal: 1, rightOrdinal: 2, overlapRatio: 1 })
    ]);
    expect(severeCropOrdinals(shots)).toEqual([2]);
    expect(insufficientResolutionOrdinals(shots)).toEqual([2]);
    expect(cropRetentionFraction(1920, 1080, 1920, 1080)).toBe(1);
  });

  it('detects excessive silence and caption overlap, bounds, and line length', () => {
    const intervals = parseSilenceIntervals('silence_start: 1.0\nsilence_end: 3.2', 10_000);
    expect(silenceViolations(intervals, 10_000)).toMatchObject({ excessive: true, longestMs: 2200 });
    expect(captionViolations([
      { text: 'A'.repeat(43), startMs: 0, endMs: 1000 },
      { text: 'Next', startMs: 900, endMs: 11_000 }
    ], 10_000)).toEqual({ overlapIndexes: [1], lineLimitIndexes: [0], outOfBoundsIndexes: [1] });
  });

  it('rejects unsupported packaging absolutes and invalid timeline chapters', () => {
    expect(unsafePromiseIndexes([
      { title: 'Oaxaca: A Visual Introduction', viewerPromise: 'A grounded visual journey through Oaxaca.' },
      { title: 'The Best of Oaxaca', viewerPromise: 'Every exact view in one video.' }
    ])).toEqual([1]);
    expect(validateChapters('0:00 Opening\n0:42 Arrival\n0:41 Backtrack\nbad', 45_000)).toEqual({
      invalidLineIndexes: [3],
      nonMonotonicIndexes: [2],
      outOfBoundsIndexes: [],
      startsAtZero: true
    });
  });
});
