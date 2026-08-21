import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase } from '@main/database/database';
import { ProjectService } from '@main/services/project-service';
import type { AppSettings, CatalogAsset, CoverageCluster } from '@shared/types';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'videofactory-project-guidance-'));
  roots.push(root);
  const db = new AppDatabase(join(root, 'videofactory.sqlite'));
  const now = new Date().toISOString();
  const assets: CatalogAsset[] = [];
  for (let index = 1; index <= 12; index += 1) {
    const location = `Site ${index}`;
    const shotType = ['wide', 'aerial', 'tracking', 'detail'][(index - 1) % 4]!;
    db.raw.prepare(`
      INSERT INTO assets(
        id, stable_key, canonical_page_url, title, description, country, city,
        location_name, shot_type, scene_description, objects, orientation,
        location_granularity, location_confidence, verification_status,
        availability_status, declared_width, declared_height, raw_row_json,
        imported_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, 'France', 'Paris', ?, ?, ?, 'plaza', 'landscape',
        'landmark', 1, 'human_verified', 'available', 1920, 1080, '{}', ?, ?)
    `).run(
      `asset-${index}`,
      `asset-${index}`,
      `https://elements.envato.com/asset-${index}`,
      `Paris ${location}`,
      `A ${shotType} view of ${location}.`,
      location,
      shotType,
      `Visitors cross the plaza at ${location}.`,
      now,
      now
    );
    assets.push({
      id: `asset-${index}`,
      provider: 'envato',
      providerAssetId: `provider-${index}`,
      sourceRowId: String(index),
      canonicalPageUrl: `https://elements.envato.com/asset-${index}`,
      authorName: 'Fixture author',
      title: `Paris ${location}`,
      description: `A ${shotType} view of ${location}.`,
      rawAttributes: null,
      rawTags: 'paris, plaza',
      country: 'France',
      city: 'Paris',
      locationName: location,
      activity: 'walking',
      shotType,
      sceneDescription: `Visitors cross the plaza at ${location}.`,
      objects: 'plaza',
      timeOfDay: 'day',
      style: 'cinematic',
      declaredDurationMs: 10_000,
      thumbnailUrl: null,
      declaredWidth: 1920,
      declaredHeight: 1080,
      declaredFileSizeBytes: null,
      declaredFrameRate: 30,
      declaredAlpha: false,
      declaredLooped: false,
      declaredCodec: 'h264',
      orientation: 'landscape',
      locationGranularity: 'landmark',
      locationConfidence: 1,
      verificationStatus: 'human_verified',
      availabilityStatus: 'available',
      localFileId: null,
      usedProjectCount: 0,
      licensedProjectCount: 0,
      mediaStatus: 'metadata_only',
      excluded: false,
      importedAt: now,
      updatedAt: now
    });
  }
  const coverage = {
    key: 'france|paris|',
    country: 'France',
    city: 'Paris',
    locationName: null,
    assetCount: 12,
    uniqueShotTypes: 4,
    uniqueActivities: 1,
    uniqueTimes: 1,
    landscapeCount: 12,
    portraitCount: 0,
    fourKCount: 0,
    downloadedCount: 0,
    verifiedCount: 12,
    fullHdEligibleCount: 12,
    estimatedUniqueShots: 12,
    repetitionRisk: 0,
    exactConfidenceDistribution: { verified: 12, strong: 0, contextual: 0, weak: 0 },
    shotBalance: { aerial: 0, wide: 4, medium: 4, detail: 4, other: 0 },
    variety: { day: 12, night: 0, weather: 0 },
    representedActivities: ['walking'],
    representedObjects: ['landmark'],
    missingVisualCategories: [],
    coverageScore: 90
  } satisfies CoverageCluster;
  const ai = {
    configured: vi.fn(() => true),
    generateScript: vi.fn(async () => ({
      title: 'A Visual Guide to Paris',
      topic: 'A Visual Guide to Paris',
      destination: 'Paris',
      summary: 'A catalog-grounded view of Paris.',
      scenes: assets.slice(0, 3).map((asset, index) => ({
        chapter: index === 0 ? 'Opening' : 'Visual journey',
        narration: `The view focuses on ${asset.locationName}.`,
        targetDurationMs: 4_500,
        requiredCountry: asset.country,
        requiredCity: asset.city,
        requiredLocation: asset.locationName,
        requiredGranularity: asset.locationGranularity,
        requiredObjects: ['plaza'],
        requiredActivities: ['walking'],
        preferredShots: [asset.shotType!],
        visualTreatment: 'EXACT_LOCATION_FOOTAGE' as const,
        claimIds: []
      }))
    }))
  };
  const catalog = {
    coverage: vi.fn(() => [coverage]),
    search: vi.fn(() => ({ rows: assets }))
  };
  const settings = {
    defaultOutput: '1080p',
    maxActiveProjects: 2,
    maxWaitingDownloads: 2,
    maxPrivateApproval: 2,
    monthlyBudgetUsd: 100,
    projectBudgetUsd: 15,
    targetVideoMinutes: 5,
    researchProvider: 'disabled',
    researchMaxResultsPerQuery: 5,
    llmProvider: 'mock',
    llmModel: 'fixture',
    visionProvider: 'disabled',
    channelShort: 'TRAVEL'
  } as AppSettings;
  const service = new ProjectService(
    db,
    catalog as never,
    ai as never,
    () => settings,
    { ensureHierarchy: vi.fn(() => null) } as never
  );
  return { db, service, ai, coverage };
}

describe('guided project provenance', () => {
  it('persists the raw editorial seed immutably without turning it into evidence', async () => {
    const { db, service, ai, coverage } = fixture();
    const startingScript = 'Open calmly on the plaza. The city was founded in 9999.';

    const project = await service.createAutopilot({
      destinationKey: coverage.key,
      targetMinutes: 1,
      startingScript
    });

    expect(project.guidance).toMatchObject({
      mode: 'guided',
      startingScript,
      startingScriptSha256: createHash('sha256').update(startingScript).digest('hex'),
      requestedDestinationKey: coverage.key,
      requestedTargetDurationMs: 60_000,
      resolvedDestination: 'Paris',
      resolvedTargetDurationMs: 60_000,
      constraints: {
        role: 'editorial_guidance_only',
        evidenceEligible: false,
        rawTextSharedWithLanguageProvider: false
      }
    });
    expect(ai.generateScript).toHaveBeenCalledWith(expect.objectContaining({ startingScript }));
    expect(db.raw.prepare(`
      SELECT count(*) AS count FROM research_sources
      WHERE summary LIKE '%9999%' OR raw_json LIKE '%9999%'
    `).get()).toEqual({ count: 0 });
    expect(db.raw.prepare(`
      SELECT count(*) AS count FROM fact_claims WHERE text LIKE '%9999%'
    `).get()).toEqual({ count: 0 });
    expect(db.integrityCheck()).toBe('ok');
    db.close();
  });

  it('revalidates guided destination coverage before any provider or project work', async () => {
    const { db, service, ai } = fixture();

    await expect(service.createAutopilot({
      destinationKey: 'missing|destination|',
      targetMinutes: 1,
      startingScript: 'Use a reflective documentary tone.'
    })).rejects.toThrow('unavailable in current catalog coverage');
    expect(ai.configured).not.toHaveBeenCalled();
    expect(ai.generateScript).not.toHaveBeenCalled();
    expect(db.raw.prepare(`SELECT count(*) AS count FROM projects`).get()).toEqual({ count: 0 });
    expect(db.raw.prepare(`SELECT count(*) AS count FROM project_guidance`).get()).toEqual({ count: 0 });
    db.close();
  });
});
