import { describe, expect, it } from 'vitest';
import { geographySatisfies } from '@shared/geography';

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
});
