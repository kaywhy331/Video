import type { VisualTreatment } from './types';

export type EditingOverlayKind =
  | 'map_card'
  | 'text_card'
  | 'location_label'
  | 'chapter_card'
  | 'lower_third'
  | 'logo'
  | 'data_callout';

export interface EditingClaimInput {
  id: string;
  text: string;
}

export interface SceneEditingInput {
  sceneId: string;
  ordinal: number;
  visualTreatment: VisualTreatment;
  chapter: string | null;
  previousChapter: string | null;
  country: string | null;
  city: string | null;
  location: string | null;
  requiredPlaceId: string | null;
  latitude: number | null;
  longitude: number | null;
  acceptedClaims: EditingClaimInput[];
  channelName: string;
  channelShort: string;
}

export interface EditingOverlayPlan {
  kind: EditingOverlayKind;
  primaryText: string;
  secondaryText: string | null;
  evidenceIds: string[];
  placement: 'full' | 'top_left' | 'top_right' | 'bottom_left' | 'bottom_right';
}

export interface SceneEditingPlan {
  version: 'editing-v1';
  sceneId: string;
  ordinal: number;
  visualTreatment: VisualTreatment;
  sourceKind: 'footage' | 'generated_graphic';
  mapMode: 'coordinate_plot' | 'hierarchy_not_to_scale' | null;
  geography: {
    country: string | null;
    city: string | null;
    location: string | null;
    requiredPlaceId: string | null;
    latitude: number | null;
    longitude: number | null;
  };
  overlays: EditingOverlayPlan[];
  inputHash: string;
}

function clean(value: string | null | undefined, maximum = 180): string | null {
  const normalized = value?.replace(/\s+/g, ' ').trim() ?? '';
  return normalized ? normalized.slice(0, maximum) : null;
}

function fnv1a(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `editing-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function planSceneEditing(input: SceneEditingInput): SceneEditingPlan {
  const country = clean(input.country, 120);
  const city = clean(input.city, 120);
  const location = clean(input.location, 180);
  const chapter = clean(input.chapter, 180);
  const previousChapter = clean(input.previousChapter, 180);
  const channel = clean(input.channelName, 120) ?? clean(input.channelShort, 12);
  const locationLabel = location ?? city ?? country;
  const claims = input.acceptedClaims
    .map(claim => ({ id: clean(claim.id, 200), text: clean(claim.text, 180) }))
    .filter((claim): claim is { id: string; text: string } => Boolean(claim.id && claim.text))
    .sort((left, right) => left.id.localeCompare(right.id));
  const sourceKind: SceneEditingPlan['sourceKind'] = ['MAP_OR_GRAPHIC', 'TEXT_OR_ARCHIVAL'].includes(input.visualTreatment)
    ? 'generated_graphic'
    : 'footage';
  const coordinatesValid = Number.isFinite(input.latitude)
    && Number.isFinite(input.longitude)
    && Math.abs(input.latitude ?? 0) <= 90
    && Math.abs(input.longitude ?? 0) <= 180;
  const mapMode: SceneEditingPlan['mapMode'] = input.visualTreatment === 'MAP_OR_GRAPHIC'
    ? coordinatesValid ? 'coordinate_plot' : 'hierarchy_not_to_scale'
    : null;
  const overlays: EditingOverlayPlan[] = [];

  if (sourceKind === 'generated_graphic') {
    overlays.push({
      kind: input.visualTreatment === 'MAP_OR_GRAPHIC' ? 'map_card' : 'text_card',
      primaryText: locationLabel ?? chapter ?? 'Context',
      secondaryText: input.visualTreatment === 'MAP_OR_GRAPHIC'
        ? mapMode === 'coordinate_plot' ? 'Coordinate plot · verified place record' : 'Place hierarchy · schematic, not to scale'
        : 'Source-grounded archival or text treatment',
      evidenceIds: [input.requiredPlaceId, ...claims.map(claim => claim.id)].filter((value): value is string => Boolean(value)),
      placement: 'full'
    });
  }
  if (locationLabel) {
    overlays.push({
      kind: 'location_label',
      primaryText: locationLabel,
      secondaryText: [city, country].filter(value => value && value !== locationLabel).join(' · ') || null,
      evidenceIds: input.requiredPlaceId ? [input.requiredPlaceId] : [],
      placement: 'top_left'
    });
  }
  if (chapter && chapter !== previousChapter) {
    overlays.push({
      kind: 'chapter_card',
      primaryText: chapter,
      secondaryText: locationLabel,
      evidenceIds: input.requiredPlaceId ? [input.requiredPlaceId] : [],
      placement: 'full'
    });
  }
  if (chapter || locationLabel) {
    overlays.push({
      kind: 'lower_third',
      primaryText: chapter ?? locationLabel ?? 'VideoFactory',
      secondaryText: chapter && locationLabel && chapter !== locationLabel ? locationLabel : null,
      evidenceIds: input.requiredPlaceId ? [input.requiredPlaceId] : [],
      placement: 'bottom_left'
    });
  }
  if (channel) {
    overlays.push({
      kind: 'logo',
      primaryText: channel,
      secondaryText: null,
      evidenceIds: [],
      placement: 'top_right'
    });
  }
  const materialClaim = claims[0];
  if (materialClaim) {
    overlays.push({
      kind: 'data_callout',
      primaryText: materialClaim.text,
      secondaryText: 'Sourced fact',
      evidenceIds: [materialClaim.id],
      placement: 'bottom_right'
    });
  }

  const planWithoutHash = {
    version: 'editing-v1' as const,
    sceneId: input.sceneId,
    ordinal: input.ordinal,
    visualTreatment: input.visualTreatment,
    sourceKind,
    mapMode,
    geography: {
      country,
      city,
      location,
      requiredPlaceId: input.requiredPlaceId,
      latitude: coordinatesValid ? input.latitude : null,
      longitude: coordinatesValid ? input.longitude : null
    },
    overlays
  };
  return {
    ...planWithoutHash,
    inputHash: fnv1a(JSON.stringify(planWithoutHash))
  };
}
