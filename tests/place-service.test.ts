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

  it('records reversible-evidence merge and split operations while preserving asset grounding', () => {
    const root = mkdtempSync(join(tmpdir(), 'videofactory-place-operations-'));
    roots.push(root);
    const db = new AppDatabase(join(root, 'videofactory.sqlite'));
    const places = new PlaceService(db);
    const now = new Date().toISOString();
    for (const [id, location] of [['asset-1', 'Old Tower'], ['asset-2', 'Duplicate Tower']] as const) {
      db.raw.prepare(`
        INSERT INTO assets(
          id, stable_key, title, country, city, location_name, orientation,
          location_granularity, location_confidence, verification_status,
          raw_row_json, imported_at, updated_at
        ) VALUES(?, ?, ?, 'France', 'Paris', ?, 'landscape', 'landmark', 1,
          'human_verified', '{}', ?, ?)
      `).run(id, id, id, location, now, now);
      places.syncAsset(id, 'human');
    }
    const old = places.findExisting({ country: 'France', city: 'Paris', location: 'Old Tower', granularity: 'landmark' })!;
    const duplicate = places.findExisting({ country: 'France', city: 'Paris', location: 'Duplicate Tower', granularity: 'landmark' })!;
    const target = places.merge([duplicate.id], old.id, 'Confirmed duplicate landmarks');
    expect(target.aliases).toContain('Duplicate Tower');
    expect(places.effectiveForAsset('asset-2')?.place.id).toBe(old.id);

    const city = places.findExisting({ country: 'France', city: 'Paris', granularity: 'city' })!;
    const split = places.split({
      sourcePlaceId: old.id,
      assetIds: ['asset-2'],
      name: 'New Tower',
      type: 'landmark',
      parentId: city.id,
      latitude: 48.85,
      longitude: 2.35,
      aliases: ['Tower Nouveau'],
      reason: 'Separated distinct landmark'
    });
    expect(places.effectiveForAsset('asset-2')?.place.id).toBe(split.id);
    expect(places.effectiveForAsset('asset-1')?.place.id).toBe(old.id);
    expect(db.raw.prepare('SELECT operation, count(*) AS count FROM place_operations GROUP BY operation ORDER BY operation').all())
      .toEqual([{ operation: 'merge', count: 1 }, { operation: 'split', count: 1 }]);
    db.close();
  });

  it('accumulates aliases when multiple source places merge into one target', () => {
    const root = mkdtempSync(join(tmpdir(), 'videofactory-place-aliases-'));
    roots.push(root);
    const db = new AppDatabase(join(root, 'videofactory.sqlite'));
    const places = new PlaceService(db);
    const target = places.ensureHierarchy({ country: 'France', city: 'Paris', location: 'Main Tower', granularity: 'landmark' })!;
    const first = places.ensureHierarchy({ country: 'France', city: 'Paris', location: 'First Alias', granularity: 'landmark' })!;
    const second = places.ensureHierarchy({ country: 'France', city: 'Paris', location: 'Second Alias', granularity: 'landmark' })!;
    const merged = places.merge([first.id, second.id], target.id, 'Consolidate aliases');
    expect(merged.aliases).toEqual(['First Alias', 'Second Alias']);
    db.close();
  });
});
