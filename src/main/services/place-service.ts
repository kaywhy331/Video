import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '../database/database';
import {
  normalizePlaceName,
  placeIsSameOrDescendant,
  type CanonicalPlaceNode,
  type Granularity
} from '@shared/geography';

type PlaceType = Exclude<Granularity, 'unknown'>;
export type PlaceEvidenceType = 'imported' | 'uploader_metadata' | 'geocoder' | 'vision' | 'human';
export type PlaceVerificationStatus = 'unverified' | 'accepted' | 'verified' | 'rejected' | 'conflict';

export interface CanonicalPlace {
  id: string;
  name: string;
  normalizedName: string;
  type: PlaceType;
  parentId: string | null;
}

export interface EffectivePlaceEvidence {
  assertionId: string;
  place: CanonicalPlace;
  evidenceType: PlaceEvidenceType;
  confidence: number;
  verificationStatus: PlaceVerificationStatus;
}

interface AssetGeography {
  country: string | null;
  city: string | null;
  location: string | null;
  granularity: Granularity;
  confidence: number;
  verificationStatus: string;
}

function toPlace(row: Record<string, unknown>): CanonicalPlace {
  return {
    id: String(row.id),
    name: String(row.name),
    normalizedName: String(row.normalized_name),
    type: row.place_type as PlaceType,
    parentId: row.parent_id ? String(row.parent_id) : null
  };
}

export class PlaceService {
  constructor(private readonly db: AppDatabase) {}

  ensureHierarchy(input: {
    country?: string | null;
    city?: string | null;
    location?: string | null;
    granularity?: Granularity;
  }): CanonicalPlace | null {
    let parent: CanonicalPlace | null = null;
    if (input.country?.trim()) parent = this.ensurePlace(input.country, 'country', null);
    if (input.city?.trim()) parent = this.ensurePlace(input.city, 'city', parent?.id ?? null);
    if (!input.location?.trim()) return parent;

    const normalizedLocation = normalizePlaceName(input.location);
    if (parent && normalizePlaceName(parent.name) === normalizedLocation) return parent;
    const requested = input.granularity ?? 'unknown';
    const type: PlaceType = requested === 'unknown' || requested === 'country' || requested === 'city'
      ? 'landmark'
      : requested;
    return this.ensurePlace(input.location, type, parent?.id ?? null);
  }

  syncAssetsMissingAssertions(): number {
    const rows = this.db.raw.prepare(`
      SELECT a.id, a.country, a.city, a.location_name, a.location_granularity,
        a.location_confidence, a.verification_status
      FROM assets a
      WHERE (a.country IS NOT NULL OR a.city IS NOT NULL OR a.location_name IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1 FROM asset_place_assertions p WHERE p.asset_id = a.id
        )
      ORDER BY a.id
    `).all() as Array<Record<string, unknown>>;
    this.db.raw.transaction(() => {
      for (const row of rows) this.syncAssetRow(row);
    })();
    return rows.length;
  }

  syncAssetsForImport(importId: string): void {
    const rows = this.db.raw.prepare(`
      SELECT id, country, city, location_name, location_granularity,
        location_confidence, verification_status
      FROM assets WHERE import_id = ?
    `).all(importId) as Array<Record<string, unknown>>;
    this.db.raw.transaction(() => {
      for (const row of rows) this.syncAssetRow(row);
    })();
  }

  syncAsset(assetId: string, evidenceType?: PlaceEvidenceType): EffectivePlaceEvidence | null {
    const row = this.db.raw.prepare(`
      SELECT id, country, city, location_name, location_granularity,
        location_confidence, verification_status
      FROM assets WHERE id = ?
    `).get(assetId) as Record<string, unknown> | undefined;
    if (!row) throw new Error('Asset not found while synchronizing canonical geography.');
    return this.syncAssetRow(row, evidenceType);
  }

  recordVisionAssertion(input: {
    assetId: string;
    placeId: string;
    confidence: number;
    evidenceRef?: string | null;
    evidence?: Record<string, unknown>;
  }): EffectivePlaceEvidence | null {
    const place = this.get(input.placeId);
    if (!place) throw new Error('Vision assertion referenced an unknown canonical place.');
    const current = this.effectiveForAsset(input.assetId);
    const compatible = current
      ? this.placesCompatible(current.place.id, place.id)
      : true;
    const status: PlaceVerificationStatus = current && !compatible
      ? 'conflict'
      : input.confidence >= 0.8 ? 'accepted' : 'unverified';
    this.upsertAssertion({
      assetId: input.assetId,
      place,
      evidenceType: 'vision',
      confidence: input.confidence,
      verificationStatus: status,
      evidenceRef: input.evidenceRef ?? null,
      evidence: input.evidence ?? {}
    });
    this.recomputeEffective(input.assetId);
    return this.effectiveForAsset(input.assetId);
  }

  effectiveForAsset(assetId: string): EffectivePlaceEvidence | null {
    const row = this.db.raw.prepare(`
      SELECT a.id AS assertion_id, a.evidence_type, a.confidence, a.verification_status,
        p.id, p.name, p.normalized_name, p.place_type, p.parent_id
      FROM asset_place_assertions a
      JOIN places p ON p.id = a.place_id
      WHERE a.asset_id = ? AND a.is_effective = 1
      ORDER BY a.updated_at DESC, a.id DESC LIMIT 1
    `).get(assetId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      assertionId: String(row.assertion_id),
      place: toPlace(row),
      evidenceType: row.evidence_type as PlaceEvidenceType,
      confidence: Number(row.confidence),
      verificationStatus: row.verification_status as PlaceVerificationStatus
    };
  }

  assetSatisfiesPlace(assetId: string, requiredPlaceId: string | null): boolean | null {
    if (!requiredPlaceId) return null;
    const evidence = this.effectiveForAsset(assetId);
    if (!evidence || ['rejected', 'conflict'].includes(evidence.verificationStatus)) return null;
    return placeIsSameOrDescendant(evidence.place.id, requiredPlaceId, this.placeMap());
  }

  humanVerifiedForAsset(assetId: string): boolean {
    const evidence = this.effectiveForAsset(assetId);
    return evidence?.evidenceType === 'human' && evidence.verificationStatus === 'verified';
  }

  findExisting(input: {
    country?: string | null;
    city?: string | null;
    location?: string | null;
    granularity?: Granularity;
  }): CanonicalPlace | null {
    const targets: Array<{ name: string; type: PlaceType | null }> = [];
    if (input.location?.trim()) {
      targets.push({
        name: input.location,
        type: input.granularity && input.granularity !== 'unknown' ? input.granularity : null
      });
    }
    if (input.city?.trim()) targets.push({ name: input.city, type: 'city' });
    if (input.country?.trim()) targets.push({ name: input.country, type: 'country' });

    const hierarchy = this.namedPlaceMap();
    for (const target of targets) {
      const rows = this.db.raw.prepare(`
        SELECT * FROM places
        WHERE normalized_name = ? AND (? IS NULL OR place_type = ?)
        ORDER BY CASE place_type
          WHEN 'feature' THEN 0 WHEN 'landmark' THEN 1 WHEN 'neighborhood' THEN 2
          WHEN 'city' THEN 3 WHEN 'region' THEN 4 ELSE 5 END,
          stable_key
      `).all(normalizePlaceName(target.name), target.type, target.type) as Array<Record<string, unknown>>;
      const match = rows
        .map(toPlace)
        .find(place => this.placeMatchesHierarchy(place.id, input, hierarchy));
      if (match) return match;
    }
    return null;
  }

  get(id: string): CanonicalPlace | null {
    const row = this.db.raw.prepare('SELECT * FROM places WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? toPlace(row) : null;
  }

  private syncAssetRow(row: Record<string, unknown>, evidenceType?: PlaceEvidenceType): EffectivePlaceEvidence | null {
    const geography: AssetGeography = {
      country: row.country ? String(row.country) : null,
      city: row.city ? String(row.city) : null,
      location: row.location_name ? String(row.location_name) : null,
      granularity: (row.location_granularity ?? 'unknown') as Granularity,
      confidence: Math.max(0, Math.min(1, Number(row.location_confidence ?? 0))),
      verificationStatus: String(row.verification_status ?? 'unverified')
    };
    const place = this.ensureHierarchy(geography);
    if (!place) return null;
    const source = evidenceType
      ?? (geography.verificationStatus === 'human_verified' ? 'human' : 'imported');
    const status: PlaceVerificationStatus = source === 'human' && geography.verificationStatus === 'human_verified'
      ? 'verified'
      : geography.verificationStatus === 'conflict' ? 'conflict'
        : geography.confidence >= 0.35 ? 'accepted' : 'unverified';
    this.upsertAssertion({
      assetId: String(row.id),
      place,
      evidenceType: source,
      confidence: source === 'human' ? Math.max(geography.confidence, status === 'verified' ? 1 : 0) : geography.confidence,
      verificationStatus: status,
      evidenceRef: null,
      evidence: { country: geography.country, city: geography.city, location: geography.location }
    });
    this.recomputeEffective(String(row.id));
    return this.effectiveForAsset(String(row.id));
  }

  private ensurePlace(name: string, type: PlaceType, parentId: string | null): CanonicalPlace {
    const normalized = normalizePlaceName(name);
    const stableKey = `${type}|${parentId ?? 'root'}|${normalized}`;
    const existing = this.db.raw.prepare('SELECT * FROM places WHERE stable_key = ?').get(stableKey) as Record<string, unknown> | undefined;
    if (existing) return toPlace(existing);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.raw.prepare(`
      INSERT INTO places(
        id, stable_key, name, normalized_name, place_type, parent_id,
        aliases_json, provider_refs_json, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, '[]', '{}', ?, ?)
    `).run(id, stableKey, name.trim(), normalized, type, parentId, now, now);
    return { id, name: name.trim(), normalizedName: normalized, type, parentId };
  }

  private upsertAssertion(input: {
    assetId: string;
    place: CanonicalPlace;
    evidenceType: PlaceEvidenceType;
    confidence: number;
    verificationStatus: PlaceVerificationStatus;
    evidenceRef: string | null;
    evidence: Record<string, unknown>;
  }): void {
    const now = new Date().toISOString();
    this.db.raw.prepare(`
      INSERT INTO asset_place_assertions(
        id, asset_id, place_id, granularity, evidence_type, confidence,
        verification_status, evidence_ref, evidence_json, is_effective, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT(asset_id, place_id, evidence_type) DO UPDATE SET
        confidence = excluded.confidence,
        verification_status = excluded.verification_status,
        evidence_ref = excluded.evidence_ref,
        evidence_json = excluded.evidence_json,
        updated_at = excluded.updated_at
    `).run(
      randomUUID(), input.assetId, input.place.id, input.place.type, input.evidenceType,
      Math.max(0, Math.min(1, input.confidence)), input.verificationStatus,
      input.evidenceRef, JSON.stringify(input.evidence), now, now
    );
  }

  private recomputeEffective(assetId: string): void {
    const chosen = this.db.raw.prepare(`
      SELECT id FROM asset_place_assertions
      WHERE asset_id = ? AND verification_status NOT IN ('rejected','conflict')
      ORDER BY
        CASE evidence_type
          WHEN 'human' THEN 0 WHEN 'vision' THEN 1 WHEN 'geocoder' THEN 2
          WHEN 'uploader_metadata' THEN 3 ELSE 4 END,
        CASE verification_status WHEN 'verified' THEN 0 WHEN 'accepted' THEN 1 ELSE 2 END,
        confidence DESC, updated_at DESC, id DESC
      LIMIT 1
    `).get(assetId) as { id: string } | undefined;
    this.db.raw.prepare('UPDATE asset_place_assertions SET is_effective = 0 WHERE asset_id = ?').run(assetId);
    if (chosen) this.db.raw.prepare('UPDATE asset_place_assertions SET is_effective = 1 WHERE id = ?').run(chosen.id);
  }

  private placeMap(): ReadonlyMap<string, CanonicalPlaceNode> {
    const rows = this.db.raw.prepare('SELECT id, parent_id, place_type FROM places').all() as Array<Record<string, unknown>>;
    return new Map(rows.map(row => [String(row.id), {
      id: String(row.id),
      parentId: row.parent_id ? String(row.parent_id) : null,
      type: row.place_type as PlaceType
    }]));
  }

  private namedPlaceMap(): ReadonlyMap<string, CanonicalPlace> {
    const rows = this.db.raw.prepare('SELECT * FROM places').all() as Array<Record<string, unknown>>;
    return new Map(rows.map(row => {
      const place = toPlace(row);
      return [place.id, place];
    }));
  }

  private placeMatchesHierarchy(
    placeId: string,
    input: { country?: string | null; city?: string | null },
    places: ReadonlyMap<string, CanonicalPlace>
  ): boolean {
    const expectedCountry = input.country?.trim() ? normalizePlaceName(input.country) : null;
    const expectedCity = input.city?.trim() ? normalizePlaceName(input.city) : null;
    let cursor = places.get(placeId) ?? null;
    let countryMatched = !expectedCountry;
    let cityMatched = !expectedCity;
    const visited = new Set<string>();
    while (cursor && !visited.has(cursor.id)) {
      visited.add(cursor.id);
      if (cursor.type === 'country' && cursor.normalizedName === expectedCountry) countryMatched = true;
      if (cursor.type === 'city' && cursor.normalizedName === expectedCity) cityMatched = true;
      cursor = cursor.parentId ? places.get(cursor.parentId) ?? null : null;
    }
    return countryMatched && cityMatched;
  }

  private placesCompatible(leftId: string, rightId: string): boolean {
    const places = this.placeMap();
    return placeIsSameOrDescendant(leftId, rightId, places)
      || placeIsSameOrDescendant(rightId, leftId, places);
  }
}
