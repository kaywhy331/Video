import { describe, expect, it } from 'vitest';
import {
  inferOrientation,
  normalizeNullable,
  parseDurationMs,
  parseFileSizeBytes,
  parseResolution,
  stableAssetKey
} from '@shared/normalization';

describe('catalog normalization', () => {
  it('converts spreadsheet null markers into actual null values', () => {
    expect(normalizeNullable('Not Found')).toBeNull();
    expect(normalizeNullable('  N/A  ')).toBeNull();
    expect(normalizeNullable('Da Nang')).toBe('Da Nang');
  });

  it('parses duration, file size, and resolution formats', () => {
    expect(parseDurationMs('00:00:07.5')).toBe(7500);
    expect(parseDurationMs('12 sec')).toBe(12000);
    expect(parseFileSizeBytes('1.5 GB')).toBe(Math.round(1.5 * 1024 ** 3));
    expect(parseResolution('3840 x 2160')).toEqual({ width: 3840, height: 2160 });
  });

  it('infers orientation deterministically', () => {
    expect(inferOrientation(null, 3840, 2160)).toBe('landscape');
    expect(inferOrientation(null, 1080, 1920)).toBe('portrait');
  });

  it('creates stable asset keys', () => {
    const left = stableAssetKey({ canonicalPageUrl: 'https://elements.envato.com/a-ABC123', title: 'A' });
    const right = stableAssetKey({ canonicalPageUrl: 'https://elements.envato.com/a-ABC123', title: 'A' });
    expect(left).toBe(right);
    expect(left).toHaveLength(64);
  });

  it('uses provider identity ahead of mutable source-row metadata', () => {
    const left = stableAssetKey({
      provider: 'envato',
      canonicalPageUrl: 'https://elements.envato.com/a-ABC123',
      sourceRowId: '1',
      title: 'Original title'
    });
    const right = stableAssetKey({
      provider: 'envato',
      canonicalPageUrl: 'https://elements.envato.com/a-ABC123',
      sourceRowId: '27',
      title: 'Corrected title'
    });
    expect(left).toBe(right);
  });
});
