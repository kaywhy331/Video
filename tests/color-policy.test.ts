import { describe, expect, it } from 'vitest';
import { assertSupportedSourceColor, sourceColorTreatment } from '@shared/color-policy';

describe('source color policy (REN-011)', () => {
  it('keeps ordinary SDR sources and recognizes both supported HDR transfer profiles', () => {
    expect(sourceColorTreatment({ colorSpace: 'bt709', colorTransfer: 'bt709', colorPrimaries: 'bt709' }).mode)
      .toBe('sdr');
    expect(sourceColorTreatment({ colorSpace: 'bt2020nc', colorTransfer: 'smpte2084', colorPrimaries: 'bt2020' }))
      .toMatchObject({ mode: 'tone_map_pq', videoFilter: expect.stringContaining('tonemap=') });
    expect(sourceColorTreatment({ colorSpace: 'bt2020nc', colorTransfer: 'arib-std-b67', colorPrimaries: 'bt2020' }))
      .toMatchObject({ mode: 'tone_map_hlg', videoFilter: expect.stringContaining('tonemap=') });
  });

  it('fails closed for log, ambiguous wide-gamut, and malformed HDR metadata', () => {
    for (const metadata of [
      { colorTransfer: 'log100' },
      { colorSpace: 'bt2020nc', colorTransfer: 'unknown', colorPrimaries: 'bt2020' },
      { colorTransfer: 'smpte2084', colorPrimaries: 'bt709' },
      { colorTransfer: 'vendor-camera-log' }
    ]) {
      expect(sourceColorTreatment(metadata).mode).toBe('blocked');
      expect(() => assertSupportedSourceColor(metadata)).toThrow(/HDR|log|PQ/i);
    }
  });
});
