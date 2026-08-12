import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase } from '@main/database/database';
import { PlaceService } from '@main/services/place-service';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('canonical place lookup', () => {
  it('uses the parent hierarchy to disambiguate duplicate place names', () => {
    const root = mkdtempSync(join(tmpdir(), 'videofactory-places-'));
    roots.push(root);
    const db = new AppDatabase(join(root, 'videofactory.sqlite'));
    const places = new PlaceService(db);
    const french = places.ensureHierarchy({
      country: 'France', city: 'Springfield', location: 'Central Tower', granularity: 'landmark'
    })!;
    places.ensureHierarchy({
      country: 'United States', city: 'Springfield', location: 'Central Tower', granularity: 'landmark'
    });

    expect(places.findExisting({
      country: 'France', city: 'Springfield', location: 'Central Tower', granularity: 'landmark'
    })?.id).toBe(french.id);
    expect(places.findExisting({
      country: 'Italy', city: 'Springfield', location: 'Central Tower', granularity: 'landmark'
    })).toBeNull();
    db.close();
  });
});
