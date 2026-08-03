import type { CatalogAsset, ProjectScene } from '@shared/types';
import { describeGeographyMatch, geographySatisfies } from '@shared/geography';

function terms(value: string | null | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .toLowerCase()
      .split(/[^a-z0-9\u00c0-\u024f]+/i)
      .filter(token => token.length > 2)
  );
}

function overlap(a: Iterable<string>, b: Iterable<string>): number {
  const right = new Set(b);
  let count = 0;
  let total = 0;
  for (const value of a) {
    total += 1;
    if (right.has(value)) count += 1;
  }
  return total ? count / total : 0;
}

export interface CandidateScore {
  asset: CatalogAsset;
  score: number;
  components: Record<string, number>;
  reasons: string[];
}

export class MatchingService {
  rank(scene: Pick<ProjectScene,
    'requiredCountry' | 'requiredCity' | 'requiredLocation' | 'requiredGranularity'
    | 'requiredObjects' | 'requiredActivities' | 'preferredShots' | 'narration'
  >, assets: CatalogAsset[], sourceUseCount: Map<string, number>): CandidateScore[] {
    const requiredGeo = {
      country: scene.requiredCountry,
      city: scene.requiredCity,
      location: scene.requiredLocation,
      granularity: scene.requiredGranularity
    };
    const narrationTerms = terms(scene.narration);
    const requiredObjectTerms = new Set(scene.requiredObjects.flatMap(value => [...terms(value)]));
    const requiredActivityTerms = new Set(scene.requiredActivities.flatMap(value => [...terms(value)]));
    const preferredShotTerms = new Set(scene.preferredShots.flatMap(value => [...terms(value)]));

    const eligible = assets.filter(asset => geographySatisfies({
      country: asset.country,
      city: asset.city,
      location: asset.locationName,
      granularity: asset.locationGranularity
    }, requiredGeo));

    return eligible.map(asset => {
      const metadataText = [
        asset.title, asset.description, asset.rawTags, asset.activity, asset.shotType,
        asset.sceneDescription, asset.objects, asset.timeOfDay, asset.style
      ].filter(Boolean).join(' ');
      const metadataTerms = terms(metadataText);
      const metadataMatch = overlap(narrationTerms, metadataTerms);
      const objectMatch = requiredObjectTerms.size ? overlap(requiredObjectTerms, metadataTerms) : 0.5;
      const activityMatch = requiredActivityTerms.size ? overlap(requiredActivityTerms, metadataTerms) : 0.5;
      const shotMatch = preferredShotTerms.size ? overlap(preferredShotTerms, terms(asset.shotType)) : 0.5;
      const locationEvidence = asset.verificationStatus === 'human_verified'
        ? 1
        : asset.locationConfidence;
      const resolution = asset.declaredWidth && asset.declaredHeight
        ? (asset.declaredWidth >= 3840 && asset.declaredHeight >= 2160 ? 1 : asset.declaredWidth >= 1920 ? 0.75 : 0.25)
        : 0.4;
      const orientation = asset.orientation === 'landscape' ? 1 : asset.orientation === 'unknown' ? 0.45 : 0.1;
      const reuse = sourceUseCount.get(asset.id) ?? 0;
      const reusePenalty = reuse === 0 ? 0 : reuse === 1 ? 0.16 : 0.55;

      const components = {
        metadata: metadataMatch * 0.28,
        objects: objectMatch * 0.14,
        activities: activityMatch * 0.08,
        locationEvidence: locationEvidence * 0.18,
        shot: shotMatch * 0.12,
        resolution: resolution * 0.08,
        orientation: orientation * 0.06,
        availability: (asset.availabilityStatus === 'unavailable' ? 0 : 0.03),
        localReuse: (asset.localFileId ? 0.03 : 0),
        reusePenalty: -reusePenalty
      };
      const score = Math.max(0, Math.min(100,
        Object.values(components).reduce((sum, value) => sum + value, 0) * 100
      ));
      const reasons = [
        ...describeGeographyMatch({
          country: asset.country,
          city: asset.city,
          location: asset.locationName,
          granularity: asset.locationGranularity
        }, requiredGeo),
        ...(objectMatch >= 0.5 ? ['Required objects match'] : []),
        ...(activityMatch >= 0.5 ? ['Activity matches'] : []),
        ...(shotMatch >= 0.5 ? ['Preferred shot type matches'] : []),
        asset.orientation === 'landscape' ? 'Landscape orientation' : 'Orientation may require framing',
        asset.localFileId ? 'Original is already stored locally' : 'Manual acquisition is required',
        reuse > 0 ? `Source reuse penalty applied (${reuse} prior use)` : 'No source reuse'
      ];
      return { asset, score, components, reasons };
    }).sort((a, b) => b.score - a.score || a.asset.id.localeCompare(b.asset.id));
  }
}
