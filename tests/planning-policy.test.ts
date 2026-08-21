import { describe, expect, it } from 'vitest';
import { assertPlanningCapacity, evaluateCoverage, topicSimilarity } from '@main/services/planning-policy';
import type { CoverageCluster } from '@shared/types';
import { AppDatabase } from '@main/database/database';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const qualified: CoverageCluster = {
  key: 'Vietnam|Da Nang|My Son', country: 'Vietnam', city: 'Da Nang', locationName: 'My Son',
  assetCount: 120, uniqueShotTypes: 8, uniqueActivities: 10, uniqueTimes: 4,
  landscapeCount: 110, portraitCount: 10, fullHdEligibleCount: 110, fourKCount: 60,
  downloadedCount: 20, verifiedCount: 90, estimatedUniqueShots: 252, repetitionRisk: 0.05,
  exactConfidenceDistribution: { verified: 90, strong: 20, contextual: 8, weak: 2 },
  shotBalance: { aerial: 20, wide: 35, medium: 35, detail: 25, other: 5 },
  variety: { day: 80, night: 25, weather: 15 }, representedActivities: ['walking'],
  representedObjects: ['temple'], missingVisualCategories: [], coverageScore: 90
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

  it('evaluates orientation coverage against the selected output profile', () => {
    const portraitCluster = {
      ...qualified,
      landscapeCount: 5,
      portraitCount: 110
    };
    expect(evaluateCoverage(portraitCluster, 5, { orientation: 'portrait' }).qualified).toBe(true);
    expect(evaluateCoverage(portraitCluster, 5, { orientation: 'landscape' }).reasons)
      .toContain('Landscape/full-screen coverage is insufficient');
  });

  it('detects materially duplicate topic signatures', () => {
    expect(topicSimilarity('A Visual Guide to Da Nang', 'Da Nang: A Visual Guide')).toBeGreaterThanOrEqual(0.8);
    expect(topicSimilarity('A Visual Guide to Da Nang', 'Inside Kyoto Temples')).toBeLessThan(0.3);
  });

  it('blocks project creation after known provider auth or quota exhaustion', () => {
    const root = mkdtempSync(join(tmpdir(), 'videofactory-planning-preflight-'));
    const db = new AppDatabase(join(root, 'db.sqlite'));
    db.raw.prepare(`INSERT INTO provider_health(provider, status, status_code, message, checked_at) VALUES('tavily', 'quota_exhausted', 429, 'Research quota exhausted', ?)`).run(new Date().toISOString());
    expect(() => assertPlanningCapacity(db, {
      monthlyBudgetUsd: 100, maxActiveProjects: 2, maxWaitingDownloads: 1, maxPrivateApproval: 1,
      researchProvider: 'tavily', llmProvider: 'mock', visionProvider: 'disabled'
    } as import('@shared/types').AppSettings, 'New topic')).toThrow('Research quota exhausted');
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
