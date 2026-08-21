import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '../database/database';
import type { CanonicalPlace } from '@shared/types';
import {
  normalizePlaceName,
  placeIsSameOrDescendant,
  type CanonicalPlaceNode,
  type Granularity
} from '@shared/geography';

type PlaceType = Exclude<Granularity, 'unknown'>;
export type PlaceEvidenceType = 'imported' | 'uploader_metadata' | 'geocoder' | 'vision' | 'human';
export type PlaceVerificationStatus = 'unverified' | 'accepted' | 'verified' | 'rejected' | 'conflict';

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
    parentId: row.parent_id ? String(row.parent_id) : null,
    latitude: row.latitude === null || row.latitude === undefined ? null : Number(row.latitude),
    longitude: row.longitude === null || row.longitude === undefined ? null : Number(row.longitude),
    aliases: (() => {
      try {
        const parsed = JSON.parse(String(row.aliases_json ?? '[]'));
        return Array.isArray(parsed) ? parsed.map(String) : [];
      } catch {
        return [];
      }
    })(),
    assetCount: Number(row.asset_count ?? 0)
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

  recordHumanAssertion(input: {
    assetId: string;
    placeId: string;
    reason: string;
    evidenceRef?: string | null;
    evidence?: Record<string, unknown>;
  }): EffectivePlaceEvidence {
    const place = this.get(input.placeId);
    if (!place) throw new Error('Human location verification referenced an unknown canonical place.');
    const asset = this.db.raw.prepare('SELECT id FROM assets WHERE id = ?').get(input.assetId);
    if (!asset) throw new Error('Human location verification referenced an unknown asset.');
    const reason = input.reason.trim();
    if (!reason) throw new Error('Human location verification requires a reason.');
    const now = new Date().toISOString();
    this.db.raw.transaction(() => {
      this.upsertAssertion({
        assetId: input.assetId,
        place,
        evidenceType: 'human',
        confidence: 1,
        verificationStatus: 'verified',
        evidenceRef: input.evidenceRef ?? null,
        evidence: { ...input.evidence, reason, verifiedAt: now }
      });
      this.recomputeEffective(input.assetId);
      this.applyEffectiveGeographyToAsset(input.assetId, now);
    })();
    const effective = this.effectiveForAsset(input.assetId);
    if (!effective || effective.evidenceType !== 'human' || effective.verificationStatus !== 'verified') {
      throw new Error('Human location verification did not become the effective asset evidence.');
    }
    return effective;
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

  list(query?: string): CanonicalPlace[] {
    const needle = query?.trim() ? `%${normalizePlaceName(query)}%` : null;
    return (this.db.raw.prepare(`
      SELECT p.*,
        (SELECT count(DISTINCT a.asset_id) FROM asset_place_assertions a WHERE a.place_id = p.id) AS asset_count
      FROM places p
      WHERE ? IS NULL OR normalized_name LIKE ? OR lower(aliases_json) LIKE ?
      ORDER BY CASE place_type
        WHEN 'country' THEN 0 WHEN 'region' THEN 1 WHEN 'city' THEN 2
        WHEN 'neighborhood' THEN 3 WHEN 'landmark' THEN 4 ELSE 5 END,
        normalized_name, stable_key
      LIMIT 2_000
    `).all(needle, needle, needle) as Array<Record<string, unknown>>).map(toPlace);
  }

  merge(sourcePlaceIds: string[], targetPlaceId: string, reason: string, actor = 'operator'): CanonicalPlace {
    const sources = [...new Set(sourcePlaceIds)].filter(id => id !== targetPlaceId);
    const target = this.get(targetPlaceId);
    if (!target || !sources.length) throw new Error('Place merge requires valid source and target places.');
    const sourceRows = sources.map(id => this.get(id));
    if (sourceRows.some(place => !place)) throw new Error('One or more source places do not exist.');
    const affected = (this.db.raw.prepare(`
      SELECT DISTINCT asset_id FROM asset_place_assertions
      WHERE place_id IN (${sources.map(() => '?').join(',')})
      ORDER BY asset_id
    `).all(...sources) as Array<{ asset_id: string }>).map(row => row.asset_id);
    const now = new Date().toISOString();
    const mergedAliases = new Set(target.aliases ?? []);
    for (const source of sourceRows as CanonicalPlace[]) {
      mergedAliases.add(source.name);
      for (const alias of source.aliases ?? []) mergedAliases.add(alias);
    }
    this.db.raw.transaction(() => {
      this.db.raw.prepare('UPDATE places SET aliases_json = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify([...mergedAliases].sort()), now, targetPlaceId);
      for (const source of sourceRows as CanonicalPlace[]) {
        const assertions = this.db.raw.prepare(`
          SELECT * FROM asset_place_assertions WHERE place_id = ? ORDER BY id
        `).all(source.id) as Array<Record<string, unknown>>;
        for (const assertion of assertions) {
          const existing = this.db.raw.prepare(`
            SELECT id, confidence, updated_at FROM asset_place_assertions
            WHERE asset_id = ? AND place_id = ? AND evidence_type = ?
          `).get(assertion.asset_id, targetPlaceId, assertion.evidence_type) as Record<string, unknown> | undefined;
          if (existing) {
            if (Number(assertion.confidence) > Number(existing.confidence)) {
              this.db.raw.prepare(`
                UPDATE asset_place_assertions SET confidence = ?, verification_status = ?,
                  evidence_ref = ?, evidence_json = ?, updated_at = ? WHERE id = ?
              `).run(assertion.confidence, assertion.verification_status, assertion.evidence_ref,
                assertion.evidence_json, now, existing.id);
            }
            this.db.raw.prepare('DELETE FROM asset_place_assertions WHERE id = ?').run(assertion.id);
          } else {
            this.db.raw.prepare(`
              UPDATE asset_place_assertions SET place_id = ?, granularity = ?, updated_at = ? WHERE id = ?
            `).run(targetPlaceId, target.type, now, assertion.id);
          }
        }
        this.db.raw.prepare('UPDATE places SET parent_id = ?, updated_at = ? WHERE parent_id = ?')
          .run(targetPlaceId, now, source.id);
        this.db.raw.prepare('DELETE FROM places WHERE id = ?').run(source.id);
      }
      for (const assetId of affected) {
        this.recomputeEffective(assetId);
        this.applyEffectiveGeographyToAsset(assetId, now);
      }
      this.db.raw.prepare(`
        INSERT INTO place_operations(
          id, operation, source_place_ids_json, target_place_id,
          affected_asset_ids_json, before_json, after_json, actor, reason, created_at
        ) VALUES(?, 'merge', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), JSON.stringify(sources), targetPlaceId, JSON.stringify(affected),
        JSON.stringify(sourceRows), JSON.stringify(this.get(targetPlaceId)), actor, reason, now);
    })();
    return this.get(targetPlaceId)!;
  }

  split(input: {
    sourcePlaceId: string;
    assetIds: string[];
    name: string;
    type: PlaceType;
    parentId: string | null;
    latitude?: number | null;
    longitude?: number | null;
    aliases?: string[];
    reason: string;
    actor?: string;
  }): CanonicalPlace {
    const source = this.get(input.sourcePlaceId);
    if (!source) throw new Error('Source place does not exist.');
    if (input.parentId && !this.get(input.parentId)) throw new Error('Split place parent does not exist.');
    const assetIds = [...new Set(input.assetIds)];
    const placeholders = assetIds.map(() => '?').join(',');
    const eligible = (this.db.raw.prepare(`
      SELECT DISTINCT asset_id FROM asset_place_assertions
      WHERE place_id = ? AND asset_id IN (${placeholders}) ORDER BY asset_id
    `).all(input.sourcePlaceId, ...assetIds) as Array<{ asset_id: string }>).map(row => row.asset_id);
    if (eligible.length !== assetIds.length) throw new Error('Every split asset must currently assert the source place.');
    const now = new Date().toISOString();
    const id = randomUUID();
    const stableKey = `${input.type}|${input.parentId ?? 'root'}|${normalizePlaceName(input.name)}|${id.slice(0, 8)}`;
    this.db.raw.transaction(() => {
      this.db.raw.prepare(`
        INSERT INTO places(
          id, stable_key, name, normalized_name, place_type, parent_id,
          latitude, longitude, aliases_json, provider_refs_json, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)
      `).run(id, stableKey, input.name.trim(), normalizePlaceName(input.name), input.type,
        input.parentId, input.latitude ?? null, input.longitude ?? null,
        JSON.stringify([...(input.aliases ?? [])].sort()), now, now);
      this.db.raw.prepare(`
        UPDATE asset_place_assertions SET place_id = ?, granularity = ?, updated_at = ?
        WHERE place_id = ? AND asset_id IN (${placeholders})
      `).run(id, input.type, now, input.sourcePlaceId, ...assetIds);
      for (const assetId of assetIds) {
        this.recomputeEffective(assetId);
        this.applyEffectiveGeographyToAsset(assetId, now);
      }
      this.db.raw.prepare(`
        INSERT INTO place_operations(
          id, operation, source_place_ids_json, target_place_id,
          affected_asset_ids_json, before_json, after_json, actor, reason, created_at
        ) VALUES(?, 'split', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), JSON.stringify([input.sourcePlaceId]), id, JSON.stringify(assetIds),
        JSON.stringify(source), JSON.stringify(this.get(id)), input.actor ?? 'operator', input.reason, now);
    })();
    return this.get(id)!;
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
    return { id, name: name.trim(), normalizedName: normalized, type, parentId, latitude: null, longitude: null, aliases: [], assetCount: 0 };
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

  private applyEffectiveGeographyToAsset(assetId: string, now: string): void {
    const evidence = this.effectiveForAsset(assetId);
    if (!evidence) return;
    const hierarchy = this.namedPlaceMap();
    let cursor: CanonicalPlace | null = evidence.place;
    let country: string | null = null;
    let city: string | null = null;
    while (cursor) {
      if (cursor.type === 'country') country = cursor.name;
      if (cursor.type === 'city') city = cursor.name;
      cursor = cursor.parentId ? hierarchy.get(cursor.parentId) ?? null : null;
    }
    const locationName = ['country','city'].includes(evidence.place.type) ? null : evidence.place.name;
    this.db.raw.prepare(`
      UPDATE assets SET country = ?, city = ?, location_name = ?,
        location_granularity = ?, location_confidence = ?,
        verification_status = CASE WHEN ? = 'human' AND ? = 'verified'
          THEN 'human_verified' ELSE verification_status END,
        updated_at = ? WHERE id = ?
    `).run(country, city, locationName, evidence.place.type, evidence.confidence,
      evidence.evidenceType, evidence.verificationStatus, now, assetId);
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
