import { describe, expect, it } from 'vitest';
import { outputFrameRateEvidence } from '@main/services/render-service';

describe('rendered output frame-rate policy', () => {
  it('accepts an exact 30 fps CFR stream with duration-derived average jitter', () => {
    expect(outputFrameRateEvidence({
      r_frame_rate: '30/1',
      avg_frame_rate: '2718720/90727'
    })).toEqual({
      nominal: 30,
      average: expect.closeTo(29.96594, 5),
      valid: true
    });
  });

  it('rejects a nominal 29.97 fps stream and a materially variable average', () => {
    expect(outputFrameRateEvidence({
      r_frame_rate: '30000/1001',
      avg_frame_rate: '30000/1001'
    }).valid).toBe(false);
    expect(outputFrameRateEvidence({
      r_frame_rate: '30/1',
      avg_frame_rate: '24/1'
    }).valid).toBe(false);
  });

  it('fails closed when either rate is unavailable', () => {
    expect(outputFrameRateEvidence({ r_frame_rate: '30/1' }).valid).toBe(false);
    expect(outputFrameRateEvidence({ avg_frame_rate: '30/1' }).valid).toBe(false);
  });
});
