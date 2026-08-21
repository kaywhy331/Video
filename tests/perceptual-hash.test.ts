import { describe, expect, it } from 'vitest';
import { differenceHash, perceptualHashDistance, perceptuallySimilar } from '@shared/perceptual-hash';

describe('perceptual difference hash', () => {
  it('produces stable 64-bit hashes and measures visual distance', () => {
    const rising = Uint8Array.from({ length: 72 }, (_, index) => index);
    const falling = Uint8Array.from({ length: 72 }, (_, index) => 255 - index);
    const risingHash = differenceHash(rising);
    expect(risingHash).toHaveLength(16);
    expect(differenceHash(rising)).toBe(risingHash);
    expect(perceptualHashDistance(risingHash, risingHash)).toBe(0);
    expect(perceptuallySimilar(risingHash, differenceHash(falling), 6)).toBe(false);
    expect(perceptualHashDistance('invalid', risingHash)).toBe(Number.POSITIVE_INFINITY);
  });
});
