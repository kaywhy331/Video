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

function same(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  return a.trim().localeCompare(b.trim(), undefined, { sensitivity: 'base' }) === 0;
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
