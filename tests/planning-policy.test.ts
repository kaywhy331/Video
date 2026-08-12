import { describe, expect, it } from 'vitest';
import { evaluateCoverage, topicSimilarity } from '@main/services/planning-policy';
import type { CoverageCluster } from '@shared/types';

const qualified: CoverageCluster = {
  key: 'Vietnam|Da Nang|My Son', country: 'Vietnam', city: 'Da Nang', locationName: 'My Son',
  assetCount: 120, uniqueShotTypes: 8, uniqueActivities: 10, uniqueTimes: 4,
  landscapeCount: 110, fourKCount: 60, downloadedCount: 20, verifiedCount: 90, coverageScore: 90
};

describe('coverage-first planning policy', () => {
  it('qualifies deep diverse coverage and records explainable components', () => {
    const result = evaluateCoverage(qualified, 5);
    expect(result.qualified).toBe(true);
    expect(result.estimatedShots).toBeGreaterThanOrEqual(result.requiredShots * 1.35);
    expect(result.components.shotDiversity).toBe(100);
  });

  it('rejects thin coverage before weighted scoring', () => {
    const result = evaluateCoverage({
      ...qualified, assetCount: 5, uniqueShotTypes: 2, landscapeCount: 2, verifiedCount: 1
    }, 5);
    expect(result.qualified).toBe(false);
    expect(result.reasons).toContain('Fewer than 12 unique source assets');
    expect(result.reasons).toContain('Fewer than four shot categories');
  });

  it('detects materially duplicate topic signatures', () => {
    expect(topicSimilarity('A Visual Guide to Da Nang', 'Da Nang: A Visual Guide')).toBeGreaterThanOrEqual(0.8);
    expect(topicSimilarity('A Visual Guide to Da Nang', 'Inside Kyoto Temples')).toBeLessThan(0.3);
  });
});
