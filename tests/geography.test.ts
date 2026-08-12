import { describe, expect, it } from 'vitest';
import { geographySatisfies, placeIsSameOrDescendant } from '@shared/geography';

describe('exact-location hard gate', () => {
  it('accepts an exact landmark match', () => {
    expect(geographySatisfies(
      { country: 'Vietnam', city: 'Da Nang', location: 'Mỹ Sơn Sanctuary', granularity: 'landmark' },
      { country: 'Vietnam', city: 'Da Nang', location: 'Mỹ Sơn Sanctuary', granularity: 'landmark' }
    )).toBe(true);
  });

  it('rejects a visually similar location in another city or country', () => {
    expect(geographySatisfies(
      { country: 'Thailand', city: 'Ayutthaya', location: 'Temple ruins', granularity: 'landmark' },
      { country: 'Vietnam', city: 'Da Nang', location: 'Mỹ Sơn Sanctuary', granularity: 'landmark' }
    )).toBe(false);
  });

  it('does not allow country-level evidence to satisfy a named landmark', () => {
    expect(geographySatisfies(
      { country: 'Vietnam', city: null, location: null, granularity: 'country' },
      { country: 'Vietnam', city: 'Da Nang', location: 'Mỹ Sơn Sanctuary', granularity: 'landmark' }
    )).toBe(false);
  });

  it('accepts descendants but rejects sibling places in the canonical hierarchy', () => {
    const places = new Map([
      ['france', { id: 'france', parentId: null, type: 'country' as const }],
      ['paris', { id: 'paris', parentId: 'france', type: 'city' as const }],
      ['eiffel', { id: 'eiffel', parentId: 'paris', type: 'landmark' as const }],
      ['louvre', { id: 'louvre', parentId: 'paris', type: 'landmark' as const }]
    ]);
    expect(placeIsSameOrDescendant('eiffel', 'paris', places)).toBe(true);
    expect(placeIsSameOrDescendant('eiffel', 'eiffel', places)).toBe(true);
    expect(placeIsSameOrDescendant('louvre', 'eiffel', places)).toBe(false);
    expect(placeIsSameOrDescendant('paris', 'eiffel', places)).toBe(false);
  });
});
