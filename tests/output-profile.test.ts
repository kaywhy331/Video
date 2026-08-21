import { describe, expect, it } from 'vitest';
import { cropRetainedPixels, outputDimensions, qualifiesOutputPixels } from '@shared/output-profile';

describe('output profile crop qualification', () => {
  it('qualifies native portrait media for vertical output and rejects it for landscape', () => {
    const vertical = outputDimensions('vertical_1080p');
    expect(qualifiesOutputPixels(1080, 1920, vertical.width, vertical.height)).toBe(true);
    expect(qualifiesOutputPixels(1080, 1920, 1920, 1080)).toBe(false);
  });

  it('requires enough retained pixels after aspect crop, not just raw dimensions', () => {
    expect(qualifiesOutputPixels(1920, 1080, 1080, 1920)).toBe(false);
    expect(qualifiesOutputPixels(3840, 2160, 1080, 1920)).toBe(true);
    expect(cropRetainedPixels(3840, 2160, 1080, 1920)).toEqual({ width: 1215, height: 2160 });
    expect(qualifiesOutputPixels(2160, 3840, 1080, 1920)).toBe(true);
  });

  it('returns exact registry dimensions', () => {
    expect(outputDimensions('landscape_1080p')).toMatchObject({ width: 1920, height: 1080, orientation: 'landscape' });
    expect(outputDimensions('landscape_4k')).toMatchObject({ width: 3840, height: 2160, orientation: 'landscape' });
    expect(outputDimensions('vertical_1080p')).toMatchObject({ width: 1080, height: 1920, orientation: 'portrait' });
  });
});
