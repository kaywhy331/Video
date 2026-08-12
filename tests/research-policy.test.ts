import { describe, expect, it } from 'vitest';
import { evaluateClaims, expirationFor, freshnessDaysFor, type ClaimCandidate } from '@shared/research';

function claim(patch: Partial<ClaimCandidate> = {}): ClaimCandidate {
  return {
    id: 'claim-1', text: 'The museum opens at 9 AM.', normalizedKey: 'museum-hours',
    category: 'hours', confidence: 0.9, stability: 'time_sensitive', validAsOf: '2026-08-01',
    sourceIds: ['source-1'], material: true, ...patch
  };
}

describe('research claim policy', () => {
  it('uses category-specific freshness windows', () => {
    expect(freshnessDaysFor('historical')).toBe(365);
    expect(freshnessDaysFor('hours')).toBe(30);
    expect(freshnessDaysFor('closure')).toBe(7);
    expect(expirationFor('2026-08-01', 'closure')).toBe('2026-08-08T00:00:00.000Z');
  });

  it('omits stale time-sensitive claims before acceptance', () => {
    const result = evaluateClaims([claim({ validAsOf: '2026-06-01' })], new Set(['source-1']), new Date('2026-08-12T00:00:00.000Z'))[0]!;
    expect(result).toMatchObject({ status: 'rejected', omissionReason: 'Time-sensitive claim is stale and was omitted.' });
  });

  it('rejects model-invented source IDs', () => {
    const result = evaluateClaims([claim({ sourceIds: ['invented'] })], new Set(['source-1']), new Date('2026-08-12T00:00:00.000Z'))[0]!;
    expect(result.status).toBe('rejected');
    expect(result.omissionReason).toContain('invented');
  });

  it('marks material disagreement as conflict rather than choosing a claim', () => {
    const results = evaluateClaims([
      claim(),
      claim({ id: 'claim-2', text: 'The museum opens at 10 AM.', sourceIds: ['source-2'] })
    ], new Set(['source-1', 'source-2']), new Date('2026-08-12T00:00:00.000Z'));
    expect(results.map(result => result.status)).toEqual(['conflict', 'conflict']);
    expect(results.every(result => result.conflictGroup === 'museum-hours')).toBe(true);
  });
});
