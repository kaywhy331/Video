import { describe, expect, it } from 'vitest';
import { MatchingService } from '@main/services/matching-service';
import type { CatalogAsset, ProjectScene } from '@shared/types';

function asset(id: string, patch: Partial<CatalogAsset> = {}): CatalogAsset {
  const now = '2026-08-20T00:00:00.000Z';
  return {
    id,
    provider: 'envato',
    providerAssetId: id,
    sourceRowId: id,
    canonicalPageUrl: `https://elements.envato.com/${id}`,
    authorName: 'Fixture',
    title: `${id} Paris landmark`,
    description: 'Paris landmark travel footage',
    rawAttributes: null,
    rawTags: 'Paris landmark travel',
    country: 'France',
    city: 'Paris',
    locationName: 'Eiffel Tower',
    activity: 'sightseeing',
    shotType: 'wide static',
    sceneDescription: 'Wide static view of the Eiffel Tower',
    objects: 'tower',
    timeOfDay: 'day',
    style: 'static documentary',
    declaredDurationMs: 12_000,
    thumbnailUrl: null,
    declaredWidth: 1920,
    declaredHeight: 1080,
    declaredFileSizeBytes: 10_000_000,
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
    perceptualHash: null,
    excluded: false,
    importedAt: now,
    updatedAt: now,
    ...patch
  };
}

function scene(patch: Partial<ProjectScene> = {}) {
  return {
    requiredCountry: 'France',
    requiredCity: 'Paris',
    requiredLocation: 'Eiffel Tower',
    requiredGranularity: 'landmark' as const,
    requiredObjects: ['tower'],
    requiredActivities: ['sightseeing'],
    preferredShots: ['wide'],
    narration: 'Paris landmark tower sightseeing',
    ...patch
  };
}

const output = { width: 1920, height: 1080, orientation: 'landscape' as const };
const policy = {
  maxSourceUses: 2,
  maxConsecutiveShotMotion: 2,
  perceptualDuplicateDistance: 6,
  heroSceneOrdinal: null
};

describe('global storyboard matching', () => {
  it('[MAT-001][MAT-002] hard-filters geography and explains every scored candidate', () => {
    const result = new MatchingService().rank(scene(), [
      asset('paris'),
      asset('london', { country: 'United Kingdom', city: 'London', locationName: 'Tower Bridge' })
    ], new Map(), output);
    expect(result.map(candidate => candidate.asset.id)).toEqual(['paris']);
    expect(result[0]!.components).toMatchObject({ metadata: expect.any(Number), locationEvidence: expect.any(Number) });
    expect(result[0]!.reasons).toEqual(expect.arrayContaining(['Required objects match', 'Activity matches']));
  });

  it('[MAT-003] enforces configured source-use limits unless an explicit exception is supplied', () => {
    const service = new MatchingService();
    const assets = [asset('a'), asset('b')];
    const result = service.optimizeSequence(Array.from({ length: 4 }, () => scene()), assets, output, {
      ...policy,
      maxSourceUses: 2
    });
    const counts = result.reduce((map, item) => {
      if (item.selected) map.set(item.selected.asset.id, (map.get(item.selected.asset.id) ?? 0) + 1);
      return map;
    }, new Map<string, number>());
    expect([...counts.values()].every(count => count <= 2)).toBe(true);
    const exception = service.optimizeSequence([scene(), scene()], [asset('only')], output, {
      ...policy,
      maxSourceUses: 1,
      sourceReuseExceptions: new Set(['only'])
    });
    expect(exception.map(item => item.selected?.asset.id)).toEqual(['only', 'only']);
    expect(exception[1]!.selected?.reasons).toContain('Recorded source-reuse exception permits this selection');
  });

  it('[MAT-004] blocks adjacent perceptual duplicates and penalizes similar candidates globally', () => {
    const result = new MatchingService().optimizeSequence(
      [scene(), scene(), scene()],
      [
        asset('a', { perceptualHash: '0000000000000000' }),
        asset('b', { perceptualHash: '0000000000000001' }),
        asset('c', {
          perceptualHash: 'ffffffffffffffff',
          shotType: 'close tracking',
          style: 'moving documentary'
        })
      ],
      output,
      { ...policy, maxSourceUses: 1 }
    );
    expect(result[0]!.selected?.asset.id).toBe('a');
    expect(result[1]!.selected?.asset.id).toBe('c');
    expect(result[2]!.selected?.asset.id).toBe('b');
    expect(result[2]!.selected?.reasons.some(reason => reason.includes('perceptual-duplicate penalty'))).toBe(true);
  });

  it('[MAT-005] limits consecutive identical shot-type and motion signatures when alternatives exist', () => {
    const result = new MatchingService().optimizeSequence(
      [scene(), scene(), scene()],
      [
        asset('a'),
        asset('b'),
        asset('c'),
        asset('d', { shotType: 'close tracking', style: 'moving documentary' })
      ],
      output,
      { ...policy, maxSourceUses: 1, maxConsecutiveShotMotion: 2 }
    );
    expect(result.slice(0, 2).every(item => item.selected?.asset.shotType === 'wide static')).toBe(true);
    expect(result[2]!.selected?.asset.id).toBe('d');
  });

  it('[MAT-006][MAT-010] reserves the highest-ranked hero for the requested scene deterministically', () => {
    const service = new MatchingService();
    const assets = [asset('a'), asset('b'), asset('c')];
    const request = { ...policy, maxSourceUses: 1, heroSceneOrdinal: 3 };
    const first = service.optimizeSequence([scene(), scene(), scene()], assets, output, request);
    const second = service.optimizeSequence([scene(), scene(), scene()], assets, output, request);
    expect(first[2]).toMatchObject({ role: 'hero', selected: { asset: { id: 'a' } } });
    expect(first.slice(0, 2).map(item => item.selected?.asset.id)).not.toContain('a');
    expect(first.map(item => item.selected?.asset.id)).toEqual(second.map(item => item.selected?.asset.id));
  });

  it('[MAT-007] rejects known media below the crop-retained output gate', () => {
    const result = new MatchingService().rank(scene(), [
      asset('too-small', { declaredWidth: 1280, declaredHeight: 720 }),
      asset('qualified')
    ], new Map(), output);
    expect(result.map(candidate => candidate.asset.id)).toEqual(['qualified']);
  });
});
