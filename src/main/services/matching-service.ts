import type { CatalogAsset, ProjectScene } from '@shared/types';
import { describeGeographyMatch, geographySatisfies } from '@shared/geography';
import { cropRetainedPixels, qualifiesOutputPixels } from '@shared/output-profile';
import { perceptualHashDistance, perceptuallySimilar } from '@shared/perceptual-hash';

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

export type MatchingScene = Pick<ProjectScene,
  'requiredCountry' | 'requiredCity' | 'requiredLocation' | 'requiredGranularity'
  | 'requiredObjects' | 'requiredActivities' | 'preferredShots' | 'narration'
>;

export type MatchingSequenceScene = MatchingScene & { forceGraphic?: boolean };

export interface MatchingOutput {
  width: number;
  height: number;
  orientation: 'landscape' | 'portrait' | 'square';
}

export interface SequenceMatchingPolicy {
  maxSourceUses: number;
  maxConsecutiveShotMotion: number;
  perceptualDuplicateDistance: number;
  heroSceneOrdinal: number | null;
  sourceReuseExceptions?: ReadonlySet<string>;
  candidatePoolSize?: number;
  beamWidth?: number;
}

export interface SequenceMatch {
  candidates: CandidateScore[];
  selected: CandidateScore | null;
  role: 'primary' | 'hero' | 'graphic';
}

interface BeamChoice {
  candidate: CandidateScore | null;
  reasons: string[];
  adjustedScore: number;
}

interface BeamState {
  choices: BeamChoice[];
  sourceUses: Map<string, number>;
  perceptualHashes: string[];
  lastPerceptualHash: string | null;
  lastShotMotion: string | null;
  consecutiveShotMotion: number;
  totalScore: number;
  deterministicKey: string;
}

function knownDimensions(asset: CatalogAsset): boolean {
  return Number(asset.declaredWidth) > 0 && Number(asset.declaredHeight) > 0;
}

export function shotMotionSignature(asset: CatalogAsset): string | null {
  const shot = [...terms(asset.shotType)].sort().join('-');
  const motionText = [asset.shotType, asset.style, asset.description, asset.sceneDescription]
    .filter(Boolean).join(' ').toLowerCase();
  const motion = [
    ['static', /\b(static|locked|tripod|still)\b/],
    ['pan', /\bpan(?:ning)?\b/],
    ['tilt', /\btilt(?:ing)?\b/],
    ['tracking', /\b(track(?:ing)?|dolly|follow)\b/],
    ['orbit', /\b(orbit|arc)\b/],
    ['aerial', /\b(aerial|drone|flyover)\b/],
    ['handheld', /\b(handheld|shaky)\b/],
    ['timelapse', /\b(time[ -]?lapse|hyperlapse)\b/]
  ].find(([, pattern]) => (pattern as RegExp).test(motionText))?.[0] ?? '';
  return shot || motion ? `${shot || 'unspecified'}|${motion || 'unspecified'}` : null;
}

export class MatchingService {
  rank(
    scene: MatchingScene,
    assets: CatalogAsset[],
    sourceUseCount: Map<string, number>,
    output: MatchingOutput = { width: 1920, height: 1080, orientation: 'landscape' }
  ): CandidateScore[] {
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

    const eligible = assets.filter(asset => {
      if (!geographySatisfies({
        country: asset.country,
        city: asset.city,
        location: asset.locationName,
        granularity: asset.locationGranularity
      }, requiredGeo)) return false;
      return !knownDimensions(asset) || qualifiesOutputPixels(
        Number(asset.declaredWidth), Number(asset.declaredHeight), output.width, output.height
      );
    });

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
      const retained = cropRetainedPixels(
        Number(asset.declaredWidth), Number(asset.declaredHeight), output.width, output.height
      );
      const retainedWidth = retained.width;
      const retainedHeight = retained.height;
      const resolution = retainedWidth >= output.width && retainedHeight >= output.height ? 1
        : retainedWidth >= output.width * 0.75 && retainedHeight >= output.height * 0.75 ? 0.5 : 0.1;
      const orientation = asset.orientation === output.orientation
        ? 1
        : asset.orientation === 'unknown' ? 0.45 : 0.1;
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
        asset.orientation === output.orientation ? `${output.orientation} orientation matches output` : 'Orientation may require framing',
        asset.localFileId ? 'Original is already stored locally' : 'Manual acquisition is required',
        reuse > 0 ? `Source reuse penalty applied (${reuse} prior use)` : 'No source reuse'
      ];
      return { asset, score, components, reasons };
    }).sort((a, b) => b.score - a.score || a.asset.id.localeCompare(b.asset.id));
  }

  optimizeSequence(
    scenes: MatchingSequenceScene[],
    assets: CatalogAsset[],
    output: MatchingOutput,
    policy: SequenceMatchingPolicy
  ): SequenceMatch[] {
    const maxSourceUses = Math.max(1, Math.floor(policy.maxSourceUses));
    const maxConsecutive = Math.max(1, Math.floor(policy.maxConsecutiveShotMotion));
    const duplicateDistance = Math.max(0, Math.min(64, Math.floor(policy.perceptualDuplicateDistance)));
    const candidatePoolSize = Math.max(3, Math.min(30, Math.floor(policy.candidatePoolSize ?? 12)));
    const beamWidth = Math.max(8, Math.min(256, Math.floor(policy.beamWidth ?? 64)));
    const reuseExceptions = policy.sourceReuseExceptions ?? new Set<string>();
    const candidatesByScene = scenes.map(scene => scene.forceGraphic
      ? []
      : this.rank(scene, assets, new Map(), output));
    const heroIndex = policy.heroSceneOrdinal === null
      ? -1
      : Math.max(0, Math.min(scenes.length - 1, Math.floor(policy.heroSceneOrdinal) - 1));
    const reservedHeroId = heroIndex >= 0 ? candidatesByScene[heroIndex]?.[0]?.asset.id ?? null : null;

    let beam: BeamState[] = [{
      choices: [],
      sourceUses: new Map(),
      perceptualHashes: [],
      lastPerceptualHash: null,
      lastShotMotion: null,
      consecutiveShotMotion: 0,
      totalScore: 0,
      deterministicKey: ''
    }];

    for (let sceneIndex = 0; sceneIndex < scenes.length; sceneIndex += 1) {
      const baseCandidates = candidatesByScene[sceneIndex] ?? [];
      const pool = baseCandidates.slice(0, candidatePoolSize);
      const expanded: BeamState[] = [];
      for (const state of beam) {
        const allowed = pool.filter(candidate => {
          const id = candidate.asset.id;
          if (reservedHeroId && sceneIndex < heroIndex && id === reservedHeroId) return false;
          if (reservedHeroId && sceneIndex === heroIndex && id !== reservedHeroId) return false;
          const uses = state.sourceUses.get(id) ?? 0;
          if (uses >= maxSourceUses && !reuseExceptions.has(id)) return false;
          const hash = candidate.asset.perceptualHash ?? null;
          if (hash && state.lastPerceptualHash
            && perceptuallySimilar(hash, state.lastPerceptualHash, duplicateDistance)) return false;
          const signature = shotMotionSignature(candidate.asset);
          return !(signature && signature === state.lastShotMotion
            && state.consecutiveShotMotion >= maxConsecutive);
        });

        const choices: Array<CandidateScore | null> = [...allowed, null];
        for (const candidate of choices) {
          if (!candidate && allowed.length && sceneIndex === heroIndex && reservedHeroId) continue;
          const sourceUses = new Map(state.sourceUses);
          const hashes = [...state.perceptualHashes];
          const reasons: string[] = [];
          let adjustment = 0;
          let lastHash: string | null = null;
          let signature: string | null = null;
          let consecutive = 0;
          let choiceKey = '~graphic';
          if (candidate) {
            const id = candidate.asset.id;
            choiceKey = id;
            const priorUses = sourceUses.get(id) ?? 0;
            sourceUses.set(id, priorUses + 1);
            if (priorUses > 0) {
              adjustment -= priorUses === 1 ? 16 : 55;
              reasons.push(`Global source-use penalty applied (${priorUses} prior use${priorUses === 1 ? '' : 's'})`);
            }
            if (priorUses >= maxSourceUses && reuseExceptions.has(id)) {
              reasons.push('Recorded source-reuse exception permits this selection');
            }
            const hash = candidate.asset.perceptualHash ?? null;
            if (hash) {
              const similar = hashes
                .map(previous => perceptualHashDistance(hash, previous))
                .filter(distance => distance <= duplicateDistance);
              if (similar.length) {
                adjustment -= 8 + similar.length * 4;
                reasons.push(`Global perceptual-duplicate penalty applied (${similar.length} similar prior selection${similar.length === 1 ? '' : 's'})`);
              }
              hashes.push(hash);
              lastHash = hash;
            }
            signature = shotMotionSignature(candidate.asset);
            consecutive = signature && signature === state.lastShotMotion
              ? state.consecutiveShotMotion + 1
              : signature ? 1 : 0;
            if (sceneIndex === heroIndex && id === reservedHeroId) {
              reasons.push(`Highest-ranked hero reserved for scene ${sceneIndex + 1}`);
            }
          }
          const adjustedScore = candidate ? Math.max(0, candidate.score + adjustment) : -30;
          expanded.push({
            choices: [...state.choices, { candidate, reasons, adjustedScore }],
            sourceUses,
            perceptualHashes: hashes,
            lastPerceptualHash: candidate ? lastHash : null,
            lastShotMotion: candidate ? signature : null,
            consecutiveShotMotion: candidate ? consecutive : 0,
            totalScore: state.totalScore + adjustedScore,
            deterministicKey: `${state.deterministicKey}|${choiceKey}`
          });
        }
      }
      beam = expanded
        .sort((left, right) => right.totalScore - left.totalScore
          || left.deterministicKey.localeCompare(right.deterministicKey))
        .slice(0, beamWidth);
    }

    const winner = beam[0];
    if (!winner) return scenes.map((_, index) => ({
      candidates: candidatesByScene[index] ?? [], selected: null, role: 'graphic'
    }));
    return winner.choices.map((choice, index) => ({
      candidates: candidatesByScene[index] ?? [],
      selected: choice.candidate ? {
        ...choice.candidate,
        score: choice.adjustedScore,
        components: {
          ...choice.candidate.components,
          sequencePolicy: choice.adjustedScore - choice.candidate.score
        },
        reasons: [...choice.candidate.reasons, ...choice.reasons]
      } : null,
      role: choice.candidate ? (index === heroIndex ? 'hero' : 'primary') : 'graphic'
    }));
  }
}
