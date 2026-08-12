export type Granularity = 'country' | 'region' | 'city' | 'neighborhood' | 'landmark' | 'feature' | 'unknown';

const ORDER: Record<Granularity, number> = {
  unknown: 0,
  country: 1,
  region: 2,
  city: 3,
  neighborhood: 4,
  landmark: 5,
  feature: 6
};

export interface Geography {
  country?: string | null;
  city?: string | null;
  location?: string | null;
  granularity: Granularity;
}

export interface CanonicalPlaceNode {
  id: string;
  parentId: string | null;
  type: Exclude<Granularity, 'unknown'>;
}

export function normalizePlaceName(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function same(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  return normalizePlaceName(a) === normalizePlaceName(b);
}

export function placeIsSameOrDescendant(
  candidatePlaceId: string | null,
  requiredPlaceId: string | null,
  places: ReadonlyMap<string, CanonicalPlaceNode>
): boolean {
  if (!requiredPlaceId) return true;
  if (!candidatePlaceId) return false;
  const visited = new Set<string>();
  let currentId: string | null = candidatePlaceId;
  while (currentId && !visited.has(currentId)) {
    if (currentId === requiredPlaceId) return true;
    visited.add(currentId);
    currentId = places.get(currentId)?.parentId ?? null;
  }
  return false;
}

export function geographySatisfies(asset: Geography, required: Geography): boolean {
  if (required.country && !same(asset.country, required.country)) return false;
  if (required.city && !same(asset.city, required.city)) return false;
  if (required.location && !same(asset.location, required.location)) return false;
  if (required.granularity !== 'unknown' && ORDER[asset.granularity] < ORDER[required.granularity]) return false;
  return true;
}

export function describeGeographyMatch(asset: Geography, required: Geography): string[] {
  const reasons: string[] = [];
  if (required.country && same(asset.country, required.country)) reasons.push(`Country matches: ${required.country}`);
  if (required.city && same(asset.city, required.city)) reasons.push(`City matches: ${required.city}`);
  if (required.location && same(asset.location, required.location)) reasons.push(`Exact location matches: ${required.location}`);
  if (ORDER[asset.granularity] >= ORDER[required.granularity]) {
    reasons.push(`Location evidence is specific enough (${asset.granularity})`);
  }
  return reasons;
}
