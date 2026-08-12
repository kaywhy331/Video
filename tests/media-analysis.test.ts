import { describe, expect, it } from 'vitest';
import {
  intervalCoverage,
  normalizedRotation,
  parseBlackIntervals,
  parseFreezeIntervals
} from '@shared/media-analysis';

describe('FFmpeg media analysis parsing', () => {
  it('parses black and freeze intervals and scores overlap', () => {
    const black = parseBlackIntervals('[blackdetect] black_start:1.0 black_end:2.5 black_duration:1.5');
    const freeze = parseFreezeIntervals('[freezedetect] freeze_start: 3.0\n[freezedetect] freeze_end: 5.0', 8_000);
    expect(black).toEqual([{ startMs: 1000, endMs: 2500 }]);
    expect(freeze).toEqual([{ startMs: 3000, endMs: 5000 }]);
    expect(intervalCoverage(0, 4000, black)).toBeCloseTo(0.375);
    expect(intervalCoverage(2000, 6000, freeze)).toBeCloseTo(0.5);
  });

  it('closes a trailing freeze interval at media duration', () => {
    expect(parseFreezeIntervals('freeze_start: 6.25', 10_000))
      .toEqual([{ startMs: 6250, endMs: 10_000 }]);
  });

  it('normalizes side-data and tag rotation', () => {
    expect(normalizedRotation(undefined, [{ rotation: -90 }])).toBe(270);
    expect(normalizedRotation({ rotate: '90' })).toBe(90);
    expect(normalizedRotation()).toBe(0);
  });
});
