import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '../database/database';
import type {
  CatalogAsset,
  MetadataAssertion,
  MetadataAssertionState,
  MetadataLayer
} from '@shared/types';

export interface MetadataFieldDefinition {
  column: string;
  rawSourceKey?: string;
  humanEditable: boolean;
}

export const CATALOG_METADATA_FIELDS = {
  providerAssetId: { column: 'provider_asset_id', humanEditable: false },
  sourceRowId: { column: 'source_row_id', rawSourceKey: 'sourceRowId', humanEditable: false },
  canonicalPageUrl: { column: 'canonical_page_url', rawSourceKey: 'canonicalPageUrl', humanEditable: false },
  authorName: { column: 'author_name', rawSourceKey: 'authorName', humanEditable: false },
  title: { column: 'title', rawSourceKey: 'title', humanEditable: true },
  description: { column: 'description', rawSourceKey: 'description', humanEditable: true },
  rawAttributes: { column: 'raw_attributes', rawSourceKey: 'rawAttributes', humanEditable: false },
  rawTags: { column: 'raw_tags', rawSourceKey: 'rawTags', humanEditable: false },
  rawExtractedData: { column: 'raw_extracted_data', rawSourceKey: 'rawExtractedData', humanEditable: false },
  country: { column: 'country', rawSourceKey: 'country', humanEditable: true },
  city: { column: 'city', rawSourceKey: 'city', humanEditable: true },
  locationName: { column: 'location_name', rawSourceKey: 'locationName', humanEditable: true },
  activity: { column: 'activity', rawSourceKey: 'activity', humanEditable: true },
  shotType: { column: 'shot_type', rawSourceKey: 'shotType', humanEditable: true },
  sceneDescription: { column: 'scene_description', rawSourceKey: 'sceneDescription', humanEditable: true },
  objects: { column: 'objects', rawSourceKey: 'objects', humanEditable: true },
  timeOfDay: { column: 'time_of_day', rawSourceKey: 'timeOfDay', humanEditable: true },
  style: { column: 'style', rawSourceKey: 'style', humanEditable: true },
  declaredDurationMs: { column: 'declared_duration_ms', rawSourceKey: 'declaredDuration', humanEditable: false },
  thumbnailUrl: { column: 'thumbnail_url', rawSourceKey: 'thumbnailUrl', humanEditable: false },
  declaredWidth: { column: 'declared_width', rawSourceKey: 'declaredResolution', humanEditable: false },
  declaredHeight: { column: 'declared_height', rawSourceKey: 'declaredResolution', humanEditable: false },
  declaredFileSizeBytes: { column: 'declared_file_size_bytes', rawSourceKey: 'declaredFileSize', humanEditable: false },
  declaredFrameRate: { column: 'declared_frame_rate', rawSourceKey: 'declaredFrameRate', humanEditable: false },
  declaredAlpha: { column: 'declared_alpha', rawSourceKey: 'declaredAlpha', humanEditable: false },
  declaredLooped: { column: 'declared_looped', rawSourceKey: 'declaredLooped', humanEditable: false },
  declaredCodec: { column: 'declared_codec', rawSourceKey: 'declaredCodec', humanEditable: false },
  orientation: { column: 'orientation', rawSourceKey: 'orientation', humanEditable: true },
  locationGranularity: { column: 'location_granularity', humanEditable: true },
  locationConfidence: { column: 'location_confidence', humanEditable: true },
  verificationStatus: { column: 'verification_status', humanEditable: true },
  availabilityStatus: { column: 'availability_status', humanEditable: true },
  excluded: { column: 'excluded', humanEditable: true }
} satisfies Record<string, MetadataFieldDefinition>;

export type CatalogMetadataField = keyof typeof CATALOG_METADATA_FIELDS;

function decode(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

function decodeObject(value: unknown): Record<string, unknown> {
  const parsed = decode(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function toAssertion(row: Record<string, unknown>): MetadataAssertion {
  return {
    id: String(row.id),
    assetId: String(row.asset_id),
    fieldName: String(row.field_name),
    layer: row.layer as MetadataLayer,
    value: decode(row.value_json),
    source: String(row.source),
    provider: row.provider ? String(row.provider) : null,
    model: row.model ? String(row.model) : null,
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    verificationState: row.verification_state as MetadataAssertionState,
    actor: row.actor ? String(row.actor) : null,
    evidenceRef: row.evidence_ref ? String(row.evidence_ref) : null,
    evidence: decodeObject(row.evidence_json),
    effective: Boolean(row.is_effective),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    reviewedAt: row.reviewed_at ? String(row.reviewed_at) : null,
    assetTitle: row.asset_title ? String(row.asset_title) : undefined
  };
}

export class MetadataService {
  private readonly insertAssertionStatement: ReturnType<AppDatabase['raw']['prepare']>;

  constructor(private readonly db: AppDatabase) {
    this.insertAssertionStatement = db.raw.prepare(`
      INSERT INTO asset_metadata_assertions(
        id, asset_id, field_name, layer, value_json, source, provider, model,
        confidence, verification_state, actor, evidence_ref, evidence_json,
        is_effective, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  list(assetId: string): MetadataAssertion[] {
    this.ensureLegacyHumanAssertions(assetId);
    return (this.db.raw.prepare(`
      SELECT * FROM asset_metadata_assertions
      WHERE asset_id = ?
      ORDER BY field_name,
        CASE layer WHEN 'human' THEN 0 WHEN 'normalized' THEN 1 WHEN 'ai' THEN 2 ELSE 3 END,
        updated_at DESC, id DESC
    `).all(assetId) as Array<Record<string, unknown>>).map(toAssertion);
  }

  inbox(limit = 500): MetadataAssertion[] {
    return (this.db.raw.prepare(`
      SELECT assertion.*, asset.title AS asset_title
      FROM asset_metadata_assertions assertion
      JOIN assets asset ON asset.id = assertion.asset_id
      WHERE assertion.layer = 'ai' AND assertion.verification_state = 'proposed'
      ORDER BY assertion.confidence DESC, assertion.created_at, assertion.id
      LIMIT ?
    `).all(Math.max(1, Math.min(2_000, limit))) as Array<Record<string, unknown>>).map(toAssertion);
  }

  recordImportLayers(input: {
    assetId: string;
    importId: string;
    normalized: Partial<Record<CatalogMetadataField, unknown>>;
    rawRow: Record<string, unknown>;
    mapping: Record<string, string | null>;
    at: string;
    initialAsset?: boolean;
  }): void {
    if (!input.initialAsset) this.ensureLegacyHumanAssertions(input.assetId);
    for (const [fieldName, definition] of Object.entries(CATALOG_METADATA_FIELDS) as Array<[
      CatalogMetadataField,
      MetadataFieldDefinition
    ]>) {
      const normalizedValue = input.normalized[fieldName];
      const rawColumn = definition.rawSourceKey ? input.mapping[definition.rawSourceKey] : null;
      const rawValue = rawColumn ? input.rawRow[rawColumn] : null;
      if (!input.initialAsset) {
        this.supersede(input.assetId, fieldName, 'raw', input.at);
        this.supersede(input.assetId, fieldName, 'normalized', input.at);
      }
      if (rawColumn) {
        this.insertAssertion({
          assetId: input.assetId,
          fieldName,
          layer: 'raw',
          value: rawValue,
          source: 'catalog_import',
          confidence: null,
          verificationState: 'accepted',
          actor: 'catalog_importer',
          evidenceRef: input.importId,
          evidence: { importId: input.importId, sourceColumn: rawColumn },
          at: input.at,
          effective: false
        });
      }
      this.insertAssertion({
        assetId: input.assetId,
        fieldName,
        layer: 'normalized',
        value: normalizedValue ?? null,
        source: 'catalog_normalizer',
        confidence: fieldName === 'locationConfidence' ? Number(normalizedValue ?? 0) : 1,
        verificationState: 'accepted',
        actor: 'catalog_importer',
        evidenceRef: input.importId,
        evidence: { importId: input.importId, rawSourceColumn: rawColumn },
        at: input.at,
        effective: Boolean(input.initialAsset)
      });
      if (!input.initialAsset) this.recomputeField(input.assetId, fieldName, input.at);
    }
  }

  applyHumanPatch(
    assetId: string,
    patch: Record<string, unknown>,
    reason: string,
    actor = 'operator'
  ): void {
    const current = this.db.raw.prepare('SELECT * FROM assets WHERE id = ?').get(assetId) as Record<string, unknown> | undefined;
    if (!current) throw new Error('Asset not found.');
    const entries = Object.entries(patch).filter(([fieldName]) => {
      const definition = CATALOG_METADATA_FIELDS[fieldName as CatalogMetadataField];
      return Boolean(definition?.humanEditable);
    }) as Array<[CatalogMetadataField, unknown]>;
    if (!entries.length) return;
    const now = new Date().toISOString();
    const overrides = decodeObject(current.human_override_json);

    for (const [fieldName, value] of entries) {
      const definition = CATALOG_METADATA_FIELDS[fieldName];
      this.db.raw.prepare(`
        INSERT INTO asset_metadata_revisions(
          id, asset_id, field_name, previous_value_json, new_value_json,
          source, confidence, reason, created_at
        ) VALUES(?, ?, ?, ?, ?, 'human', 1.0, ?, ?)
      `).run(
        randomUUID(), assetId, fieldName, JSON.stringify(current[definition.column] ?? null),
        JSON.stringify(value ?? null), reason, now
      );
      this.supersede(assetId, fieldName, 'human', now);
      this.insertAssertion({
        assetId,
        fieldName,
        layer: 'human',
        value: value ?? null,
        source: 'human_override',
        confidence: 1,
        verificationState: 'verified',
        actor,
        evidenceRef: null,
        evidence: { reason },
        at: now
      });
      overrides[fieldName] = value ?? null;
      this.recomputeField(assetId, fieldName, now);
    }
    this.db.raw.prepare('UPDATE assets SET human_override_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(overrides), now, assetId);
  }

  propose(input: {
    assetId: string;
    fieldName: CatalogMetadataField;
    value: unknown;
    provider: string;
    model: string;
    confidence: number;
    evidenceRef?: string | null;
    evidence?: Record<string, unknown>;
  }): MetadataAssertion {
    if (!CATALOG_METADATA_FIELDS[input.fieldName]) throw new Error('Unknown metadata field.');
    const asset = this.db.raw.prepare('SELECT id FROM assets WHERE id = ?').get(input.assetId);
    if (!asset) throw new Error('Asset not found.');
    const at = new Date().toISOString();
    const id = this.insertAssertion({
      assetId: input.assetId,
      fieldName: input.fieldName,
      layer: 'ai',
      value: input.value,
      source: 'ai_suggestion',
      provider: input.provider,
      model: input.model,
      confidence: input.confidence,
      verificationState: 'proposed',
      actor: `${input.provider}:${input.model}`,
      evidenceRef: input.evidenceRef ?? null,
      evidence: input.evidence ?? {},
      at
    });
    return toAssertion(this.db.raw.prepare('SELECT * FROM asset_metadata_assertions WHERE id = ?').get(id) as Record<string, unknown>);
  }

  review(assertionId: string, decision: 'accept' | 'reject', actor = 'operator'): MetadataAssertion {
    const row = this.db.raw.prepare(`
      SELECT * FROM asset_metadata_assertions WHERE id = ?
    `).get(assertionId) as Record<string, unknown> | undefined;
    if (!row || row.layer !== 'ai') throw new Error('AI metadata suggestion not found.');
    if (row.verification_state !== 'proposed') throw new Error('Metadata suggestion was already reviewed.');
    const at = new Date().toISOString();
    const state: MetadataAssertionState = decision === 'accept' ? 'accepted' : 'rejected';
    this.db.raw.prepare(`
      UPDATE asset_metadata_assertions SET verification_state = ?, actor = ?,
        reviewed_at = ?, updated_at = ? WHERE id = ?
    `).run(state, actor, at, at, assertionId);
    this.recomputeField(String(row.asset_id), String(row.field_name) as CatalogMetadataField, at);
    return toAssertion(this.db.raw.prepare('SELECT * FROM asset_metadata_assertions WHERE id = ?').get(assertionId) as Record<string, unknown>);
  }

  effectiveValue(assetId: string, fieldName: CatalogMetadataField): unknown {
    const row = this.db.raw.prepare(`
      SELECT value_json FROM asset_metadata_assertions
      WHERE asset_id = ? AND field_name = ? AND is_effective = 1 LIMIT 1
    `).get(assetId, fieldName) as { value_json: string | null } | undefined;
    return row ? decode(row.value_json) : undefined;
  }

  private ensureLegacyHumanAssertions(assetId: string): void {
    const asset = this.db.raw.prepare('SELECT * FROM assets WHERE id = ?').get(assetId) as Record<string, unknown> | undefined;
    if (!asset) throw new Error('Asset not found.');
    const overrides = decodeObject(asset.human_override_json);
    const now = new Date().toISOString();
    for (const [fieldName, value] of Object.entries(overrides)) {
      const definition = CATALOG_METADATA_FIELDS[fieldName as CatalogMetadataField];
      if (!definition?.humanEditable) continue;
      const existing = this.db.raw.prepare(`
        SELECT id FROM asset_metadata_assertions
        WHERE asset_id = ? AND field_name = ? AND layer = 'human'
          AND verification_state = 'verified' LIMIT 1
      `).get(assetId, fieldName);
      if (existing) continue;
      this.insertAssertion({
        assetId,
        fieldName: fieldName as CatalogMetadataField,
        layer: 'human',
        value,
        source: 'legacy_human_override',
        confidence: 1,
        verificationState: 'verified',
        actor: 'operator',
        evidenceRef: null,
        evidence: { migratedFrom: 'assets.human_override_json' },
        at: now
      });
      this.recomputeField(assetId, fieldName as CatalogMetadataField, now);
    }
  }

  private supersede(assetId: string, fieldName: CatalogMetadataField, layer: MetadataLayer, at: string): void {
    this.db.raw.prepare(`
      UPDATE asset_metadata_assertions SET verification_state = 'superseded',
        is_effective = 0, updated_at = ?
      WHERE asset_id = ? AND field_name = ? AND layer = ?
        AND verification_state NOT IN ('rejected','superseded')
    `).run(at, assetId, fieldName, layer);
  }

  private insertAssertion(input: {
    assetId: string;
    fieldName: CatalogMetadataField;
    layer: MetadataLayer;
    value: unknown;
    source: string;
    provider?: string | null;
    model?: string | null;
    confidence: number | null;
    verificationState: MetadataAssertionState;
    actor: string | null;
    evidenceRef: string | null;
    evidence: Record<string, unknown>;
    at: string;
    effective?: boolean;
  }): string {
    const id = randomUUID();
    this.insertAssertionStatement.run(
      id, input.assetId, input.fieldName, input.layer, JSON.stringify(input.value ?? null),
      input.source, input.provider ?? null, input.model ?? null, input.confidence,
      input.verificationState, input.actor, input.evidenceRef, JSON.stringify(input.evidence),
      Number(input.effective ?? false), input.at, input.at
    );
    return id;
  }

  private recomputeField(assetId: string, fieldName: CatalogMetadataField, at: string): void {
    const definition = CATALOG_METADATA_FIELDS[fieldName];
    if (!definition) return;
    const chosen = this.db.raw.prepare(`
      SELECT id, value_json FROM asset_metadata_assertions
      WHERE asset_id = ? AND field_name = ?
        AND verification_state IN ('accepted','verified')
      ORDER BY
        CASE layer WHEN 'human' THEN 0 WHEN 'normalized' THEN 1 WHEN 'ai' THEN 2 ELSE 3 END,
        CASE verification_state WHEN 'verified' THEN 0 ELSE 1 END,
        confidence DESC, updated_at DESC, id DESC
      LIMIT 1
    `).get(assetId, fieldName) as { id: string; value_json: string | null } | undefined;
    this.db.raw.prepare(`
      UPDATE asset_metadata_assertions SET is_effective = 0
      WHERE asset_id = ? AND field_name = ?
    `).run(assetId, fieldName);
    if (!chosen) return;
    this.db.raw.prepare('UPDATE asset_metadata_assertions SET is_effective = 1 WHERE id = ?').run(chosen.id);
    const value = decode(chosen.value_json);
    this.db.raw.prepare(`UPDATE assets SET ${definition.column} = ?, updated_at = ? WHERE id = ?`)
      .run(value, at, assetId);
  }
}
