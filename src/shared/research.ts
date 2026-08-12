import { z } from 'zod';

export const RESEARCH_QUERY_LIMIT = 4;
export const RESEARCH_RESULTS_PER_QUERY_LIMIT = 5;
export const RESEARCH_SOURCE_LIMIT = 12;

const HttpUrlSchema = z.string().url().max(2_000).refine(value => {
  const protocol = new URL(value).protocol;
  return protocol === 'https:' || protocol === 'http:';
}, 'Research sources must use http or https.');

export const ResearchSearchResultSchema = z.object({
  url: HttpUrlSchema,
  title: z.string().trim().min(1).max(500),
  content: z.string().trim().min(1).max(20_000),
  score: z.number().min(0).max(1).nullable().default(null),
  publishedAt: z.string().datetime({ offset: true }).nullable().default(null)
}).strict();

export const ResearchSearchResponseSchema = z.object({
  results: z.array(ResearchSearchResultSchema).max(RESEARCH_QUERY_LIMIT * RESEARCH_RESULTS_PER_QUERY_LIMIT),
  responseTime: z.number().nonnegative().nullable().default(null),
  requestId: z.string().max(250).nullable().default(null)
}).strict();

export const ResearchExtractResultSchema = z.object({
  url: HttpUrlSchema,
  rawContent: z.string().trim().min(1).max(100_000),
  images: z.array(HttpUrlSchema).max(20).default([])
}).strict();

export const ResearchExtractResponseSchema = z.object({
  results: z.array(ResearchExtractResultSchema).max(RESEARCH_SOURCE_LIMIT),
  failedResults: z.array(z.object({ url: HttpUrlSchema, error: z.string().max(2_000) }).strict()).max(RESEARCH_SOURCE_LIMIT).default([]),
  responseTime: z.number().nonnegative().nullable().default(null),
  requestId: z.string().max(250).nullable().default(null)
}).strict();

export const ExtractedClaimSchema = z.object({
  text: z.string().trim().min(1).max(2_000),
  normalizedKey: z.string().trim().min(1).max(300),
  category: z.enum(['historical', 'geographic', 'price', 'hours', 'transport', 'closure', 'event', 'other']),
  confidence: z.number().min(0).max(1),
  stability: z.enum(['stable', 'time_sensitive']),
  validAsOf: z.string().date().nullable(),
  sourceIds: z.array(z.string().trim().min(1).max(200)).min(1).max(RESEARCH_SOURCE_LIMIT),
  material: z.boolean().default(true)
}).strict();

export const ExtractedClaimPackSchema = z.object({
  claims: z.array(ExtractedClaimSchema).max(40)
}).strict();

export type ResearchSearchResult = z.infer<typeof ResearchSearchResultSchema>;
export type ResearchExtractResult = z.infer<typeof ResearchExtractResultSchema>;
export type ExtractedClaim = z.infer<typeof ExtractedClaimSchema>;

export type ClaimCategory = ExtractedClaim['category'];
export type ClaimStatus = 'proposed' | 'accepted' | 'conflict' | 'rejected';

export interface ClaimCandidate extends ExtractedClaim {
  id: string;
}
export interface EvaluatedClaim extends ClaimCandidate {
  status: ClaimStatus;
  freshnessDays: number;
  expiresAt: string | null;
  conflictGroup: string | null;
  omissionReason: string | null;
}

export function freshnessDaysFor(category: ClaimCategory): number {
  if (category === 'closure' || category === 'event') return 7;
  if (category === 'price' || category === 'hours' || category === 'transport') return 30;
  return 365;
}

export function expirationFor(validAsOf: string | null, category: ClaimCategory): string | null {
  if (!validAsOf) return null;
  const date = new Date(`${validAsOf}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + freshnessDaysFor(category));
  return date.toISOString();
}

function canonicalText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function evaluateClaims(
  claims: ClaimCandidate[],
  knownSourceIds: ReadonlySet<string>,
  now = new Date()
): EvaluatedClaim[] {
  const groups = new Map<string, ClaimCandidate[]>();
  for (const claim of claims) {
    const key = claim.normalizedKey.toLowerCase().trim();
    groups.set(key, [...(groups.get(key) ?? []), claim]);
  }

  return claims.map(claim => {
    const freshnessDays = freshnessDaysFor(claim.category);
    const expiresAt = expirationFor(claim.validAsOf, claim.category);
    const unknown = claim.sourceIds.filter(sourceId => !knownSourceIds.has(sourceId));
    if (unknown.length) {
      return { ...claim, status: 'rejected', freshnessDays, expiresAt, conflictGroup: null, omissionReason: `Unknown source IDs: ${unknown.join(', ')}` };
    }
    if (claim.stability === 'time_sensitive' && (!expiresAt || new Date(expiresAt) <= now)) {
      return { ...claim, status: 'rejected', freshnessDays, expiresAt, conflictGroup: null, omissionReason: 'Time-sensitive claim is stale and was omitted.' };
    }
    const peers = groups.get(claim.normalizedKey.toLowerCase().trim()) ?? [];
    const conflicts = peers.some(peer => peer.id !== claim.id && canonicalText(peer.text) !== canonicalText(claim.text));
    if (claim.material && conflicts) {
      return { ...claim, status: 'conflict', freshnessDays, expiresAt, conflictGroup: claim.normalizedKey.toLowerCase().trim(), omissionReason: 'Material sources disagree; claim was omitted.' };
    }
    return { ...claim, status: 'accepted', freshnessDays, expiresAt, conflictGroup: null, omissionReason: null };
  });
}
