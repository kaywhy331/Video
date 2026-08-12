import { describe, expect, it } from 'vitest';
import {
  assertShotDuration,
  calculateEffectiveResolution,
  fileLooksTemporary,
  generateSlidingWindows,
  missingSelectedLicenseCount
} from '@shared/media-policy';

describe('media policy', () => {
  it('never silently authorizes upscaling', () => {
    const low = calculateEffectiveResolution({ sourceWidth: 1280, sourceHeight: 720 });
    expect(low.eligible1080p).toBe(false);
    expect(low.requiresUpscale1080p).toBe(true);

    const fullHd = calculateEffectiveResolution({ sourceWidth: 1920, sourceHeight: 1080 });
    expect(fullHd.eligible1080p).toBe(true);
    expect(fullHd.eligible4k).toBe(false);

    const cropped4k = calculateEffectiveResolution({
      sourceWidth: 3840,
      sourceHeight: 2160,
      cropWidthFraction: 0.7,
      cropHeightFraction: 0.7
    });
    expect(cropped4k.eligible4k).toBe(false);
  });

  it('enforces the seven-second hard gate', () => {
    expect(() => assertShotDuration(7000)).not.toThrow();
    expect(() => assertShotDuration(7001)).toThrow(/exceeds/);
  });

  it('generates only valid candidate windows', () => {
    const windows = generateSlidingWindows(28_000);
    expect(windows.length).toBeGreaterThan(0);
    expect(windows.every(window => window.durationMs <= 7000)).toBe(true);
    expect(windows.every(window => window.durationMs >= 1500)).toBe(true);
  });

  it('ignores incomplete browser downloads', () => {
    expect(fileLooksTemporary('clip.mov.crdownload')).toBe(true);
    expect(fileLooksTemporary('clip.part')).toBe(true);
    expect(fileLooksTemporary('clip.mov')).toBe(false);
  });

  it('blocks a selected asset when its project license row is missing or pending', () => {
    expect(missingSelectedLicenseCount(['asset-a', 'asset-b', 'asset-a'], [
      { assetId: 'asset-a', state: 'OPERATOR_ATTESTED' }
    ])).toBe(1);
    expect(missingSelectedLicenseCount(['asset-a'], [
      { assetId: 'asset-a', state: 'PENDING' }
    ])).toBe(1);
    expect(missingSelectedLicenseCount(['asset-a'], [
      { assetId: 'asset-a', state: 'VERIFIED' }
    ])).toBe(0);
  });
});
