import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { XLSX, type WorkBook } from '@shared/xlsx-node';
import type { AppDatabase } from '../database/database';
import type { PlaceService } from './place-service';
import type {
  CatalogAsset,
  CatalogExportReport,
  CatalogImportDiff,
  CatalogImportPreview,
  CatalogImportResult,
  CatalogRefreshRun,
  CatalogSearchRequest,
  CatalogSearchResult,
  CatalogStats,
  CoverageCluster,
  CatalogValidationTemplate
} from '@shared/types';
import { MetadataService, CATALOG_METADATA_FIELDS, type CatalogMetadataField } from './metadata-service';
import {
  canonicalizeName,
  inferLocationGranularity,
  inferOrientation,
  normalizeBoolean,
  normalizeNullable,
  parseDurationMs,
  parseFileSizeBytes,
  parseFrameRate,
  parseResolution,
  stableAssetKey
} from '@shared/normalization';

const CANONICAL_ALIASES: Record<string, string[]> = {
  sourceRowId: ['id', 'source row id', 'source_row_id', 'row id'],
  canonicalPageUrl: ['page', 'url', 'page url', 'asset url', 'canonical page url'],
  authorName: ['author', 'uploader', 'creator'],
  rawAttributes: ['attributes', 'raw attributes'],
  rawTags: ['item tags', 'tags', 'keywords'],
  title: ['title', 'item title', 'name'],
  description: ['description', 'item description'],
  rawExtractedData: ['extracted data', 'raw extracted data'],
  country: ['country'],
  city: ['city'],
  locationName: ['location', 'exact location', 'location name', 'landmark'],
  activity: ['activity', 'activities'],
  shotType: ['shot', 'shot type', 'camera shot'],
  sceneDescription: ['scene', 'scene description'],
  objects: ['object', 'objects'],
  timeOfDay: ['time of day', 'timeofday'],
  style: ['style', 'mood'],
  declaredDuration: ['length', 'duration', 'video length'],
  thumbnailUrl: ['thumbnail', 'thumbnail url', 'preview image'],
  declaredResolution: ['resolution', 'video resolution'],
  declaredFileSize: ['file size', 'filesize'],
  declaredFrameRate: ['frame rate', 'framerate', 'fps'],
  declaredAlpha: ['alpha channel', 'alpha'],
  declaredLooped: ['looped', 'loop'],
  declaredCodec: ['video encoding', 'codec', 'encoding'],
  orientation: ['orientation', 'aspect']
};

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

export function detectColumnMapping(columns: string[]): Record<string, string | null> {
  const normalized = new Map(columns.map(column => [normalizeHeader(column), column]));
  const mapping: Record<string, string | null> = {};
  for (const [canonical, aliases] of Object.entries(CANONICAL_ALIASES)) {
    mapping[canonical] = null;
    for (const alias of aliases) {
      const match = normalized.get(normalizeHeader(alias));
      if (match) {
        mapping[canonical] = match;
        break;
      }
    }
  }
  return mapping;
}

function ftsQuery(input: string): string {
  const tokens = input
    .trim()
    .split(/\s+/)
    .map(token => token.replace(/["'*:^(){}[\]]/g, ''))
    .filter(Boolean)
    .slice(0, 12);
  return tokens.map(token => `"${token}"*`).join(' AND ');
}

function toAsset(row: Record<string, unknown>): CatalogAsset {
  return {
    id: String(row.id),
    provider: String(row.provider ?? 'envato'),
    providerAssetId: row.provider_asset_id ? String(row.provider_asset_id) : null,
    sourceRowId: row.source_row_id ? String(row.source_row_id) : null,
    canonicalPageUrl: row.canonical_page_url ? String(row.canonical_page_url) : null,
    authorName: row.author_name ? String(row.author_name) : null,
    title: String(row.title ?? 'Untitled asset'),
    description: row.description ? String(row.description) : null,
    rawAttributes: row.raw_attributes ? String(row.raw_attributes) : null,
    rawTags: row.raw_tags ? String(row.raw_tags) : null,
    country: row.country ? String(row.country) : null,
    city: row.city ? String(row.city) : null,
    locationName: row.location_name ? String(row.location_name) : null,
    activity: row.activity ? String(row.activity) : null,
    shotType: row.shot_type ? String(row.shot_type) : null,
    sceneDescription: row.scene_description ? String(row.scene_description) : null,
    objects: row.objects ? String(row.objects) : null,
    timeOfDay: row.time_of_day ? String(row.time_of_day) : null,
    style: row.style ? String(row.style) : null,
    declaredDurationMs: row.declared_duration_ms === null || row.declared_duration_ms === undefined
      ? null : Number(row.declared_duration_ms),
    thumbnailUrl: row.thumbnail_url ? String(row.thumbnail_url) : null,
    declaredWidth: row.declared_width === null || row.declared_width === undefined ? null : Number(row.declared_width),
    declaredHeight: row.declared_height === null || row.declared_height === undefined ? null : Number(row.declared_height),
    declaredFileSizeBytes: row.declared_file_size_bytes === null || row.declared_file_size_bytes === undefined
      ? null : Number(row.declared_file_size_bytes),
    declaredFrameRate: row.declared_frame_rate === null || row.declared_frame_rate === undefined
      ? null : Number(row.declared_frame_rate),
    declaredAlpha: row.declared_alpha === null || row.declared_alpha === undefined
      ? null : Boolean(row.declared_alpha),
    declaredLooped: row.declared_looped === null || row.declared_looped === undefined
      ? null : Boolean(row.declared_looped),
    declaredCodec: row.declared_codec ? String(row.declared_codec) : null,
    orientation: (row.orientation ?? 'unknown') as CatalogAsset['orientation'],
    locationGranularity: (row.location_granularity ?? 'unknown') as CatalogAsset['locationGranularity'],
    locationConfidence: Number(row.location_confidence ?? 0.25),
    verificationStatus: (row.verification_status ?? 'unverified') as CatalogAsset['verificationStatus'],
    availabilityStatus: (row.availability_status ?? 'unknown') as CatalogAsset['availabilityStatus'],
    localFileId: row.local_file_id ? String(row.local_file_id) : null,
    usedProjectCount: Number(row.used_project_count ?? 0),
    licensedProjectCount: Number(row.licensed_project_count ?? 0),
    mediaStatus: (row.media_status ?? (row.local_file_id ? 'downloaded' : 'metadata_only')) as CatalogAsset['mediaStatus'],
    perceptualHash: row.perceptual_hash ? String(row.perceptual_hash) : null,
    excluded: Boolean(row.excluded),
    importedAt: String(row.imported_at),
    updatedAt: String(row.updated_at)
  };
}

interface NormalizedRow {
  stableKey: string;
  sourceRowId: string | null;
  pageUrl: string | null;
  providerAssetId: string | null;
  authorName: string | null;
  title: string;
  description: string | null;
  rawAttributes: string | null;
  rawTags: string | null;
  rawExtractedData: string | null;
  country: string | null;
  city: string | null;
  locationName: string | null;
  activity: string | null;
  shotType: string | null;
  sceneDescription: string | null;
  objects: string | null;
  timeOfDay: string | null;
  style: string | null;
  durationMs: number | null;
  thumbnailUrl: string | null;
  width: number | null;
  height: number | null;
  fileSizeBytes: number | null;
  frameRate: number | null;
  alpha: boolean | null;
  looped: boolean | null;
  codec: string | null;
  orientation: CatalogAsset['orientation'];
  granularity: CatalogAsset['locationGranularity'];
  locationConfidence: number;
  rawRow: Record<string, unknown>;
}

interface ExistingCatalogRow extends Record<string, unknown> {
  id: string;
  stable_key: string;
  provider: string;
  provider_asset_id: string | null;
  canonical_page_url: string | null;
  title: string;
  raw_row_json: string;
  human_override_json: string | null;
}

interface ExistingCatalogIndex {
  byStableKey: Map<string, ExistingCatalogRow>;
  byProviderAssetId: Map<string, ExistingCatalogRow>;
  byCanonicalUrl: Map<string, ExistingCatalogRow>;
}

export interface CatalogImportHooks {
  onProgress?: (progress: number, phase: string, message: string) => void;
  isCancelled?: () => boolean;
}

export class CatalogImportCancelledError extends Error {
  constructor() {
    super('Catalog import cancelled by the operator.');
    this.name = 'CatalogImportCancelledError';
  }
}

export class CatalogService {
  readonly metadata: MetadataService;
  private cachedFacets: CatalogSearchResult['facets'] | null = null;

  constructor(
    private readonly db: AppDatabase,
    private readonly places: PlaceService,
    private readonly importHooks: CatalogImportHooks = {}
  ) {
    this.metadata = new MetadataService(db);
  }

  invalidateSearchCaches(): void {
    this.cachedFacets = null;
  }

  private importCheckpoint(progress: number, phase: string, message: string): void {
    if (this.importHooks.isCancelled?.()) throw new CatalogImportCancelledError();
    this.importHooks.onProgress?.(Math.max(0, Math.min(1, progress)), phase, message);
  }

  private readWorkbook(filePath: string): WorkBook {
    return XLSX.read(readFileSync(filePath), {
      type: 'buffer',
      cellDates: true,
      raw: false,
      dense: false
    });
  }

  private existingCatalogIndex(): ExistingCatalogIndex {
    const index: ExistingCatalogIndex = {
      byStableKey: new Map(),
      byProviderAssetId: new Map(),
      byCanonicalUrl: new Map()
    };
    const rows = this.db.raw.prepare(`
      SELECT id, stable_key, provider, provider_asset_id, canonical_page_url,
        title, raw_row_json, human_override_json
      FROM assets ORDER BY imported_at, id
    `).all() as ExistingCatalogRow[];
    for (const row of rows) {
      const provider = String(row.provider ?? 'envato').toLowerCase();
      index.byStableKey.set(String(row.stable_key), row);
      if (row.provider_asset_id) {
        const key = `${provider}|${String(row.provider_asset_id).toLowerCase()}`;
        if (!index.byProviderAssetId.has(key)) index.byProviderAssetId.set(key, row);
      }
      if (row.canonical_page_url) {
        const key = `${provider}|${String(row.canonical_page_url).toLowerCase()}`;
        if (!index.byCanonicalUrl.has(key)) index.byCanonicalUrl.set(key, row);
      }
    }
    return index;
  }

  private findExisting(row: NormalizedRow, index: ExistingCatalogIndex): ExistingCatalogRow | undefined {
    return index.byStableKey.get(row.stableKey)
      ?? (row.providerAssetId
        ? index.byProviderAssetId.get(`envato|${row.providerAssetId.toLowerCase()}`)
        : undefined)
      ?? (row.pageUrl
        ? index.byCanonicalUrl.get(`envato|${row.pageUrl.toLowerCase()}`)
        : undefined);
  }

  previewImport(
    filePath: string,
    sheetName?: string,
    suppliedMapping?: Record<string, string | null>
  ): CatalogImportPreview {
    this.importCheckpoint(0.01, 'preview_reading', 'Reading catalog workbook');
    const workbook = this.readWorkbook(filePath);
    const selectedSheet = sheetName && workbook.SheetNames.includes(sheetName)
      ? sheetName
      : workbook.SheetNames[0];
    if (!selectedSheet) throw new Error('Spreadsheet contains no worksheets.');
    const sheet = workbook.Sheets[selectedSheet];
    if (!sheet) throw new Error(`Worksheet not found: ${selectedSheet}`);
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: null,
      raw: false
    });
    this.importCheckpoint(0.2, 'preview_parsing', `Parsed ${rows.length.toLocaleString()} catalog rows`);
    const columns = rows.length ? Object.keys(rows[0] ?? {}) : [];
    const mapping = suppliedMapping ?? detectColumnMapping(columns);
    const normalizedRows: Array<NormalizedRow | null> = [];
    for (const [index, row] of rows.entries()) {
      if (index % 128 === 0) {
        this.importCheckpoint(
          0.2 + 0.35 * (index / Math.max(1, rows.length)),
          'preview_normalizing',
          `Normalizing catalog row ${index.toLocaleString()} of ${rows.length.toLocaleString()}`
        );
      }
      normalizedRows.push(this.normalizeRow(row, mapping));
    }
    this.importCheckpoint(0.56, 'preview_diffing', 'Comparing the staged catalog with current evidence');
    const diff = this.calculateImportDiff(normalizedRows, filePath, selectedSheet);
    const warnings = this.importWarnings(mapping);
    const sourceHash = createHash('sha256').update(readFileSync(filePath)).digest('hex');
    const now = new Date().toISOString();
    const previewId = randomUUID();
    this.db.raw.prepare(`
      UPDATE catalog_import_previews SET status = 'superseded', updated_at = ?
      WHERE source_path = ? AND sheet_name = ? AND status = 'staged'
    `).run(now, filePath, selectedSheet);
    this.db.raw.prepare(`
      INSERT INTO catalog_import_previews(
        id, source_path, source_name, sheet_name, source_sha256, row_count,
        column_mapping_json, diff_json, warnings_json, status, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'staged', ?, ?)
    `).run(
      previewId, filePath, basename(filePath), selectedSheet, sourceHash, rows.length,
      JSON.stringify(mapping), JSON.stringify(diff), JSON.stringify(warnings), now, now
    );
    this.importHooks.onProgress?.(1, 'preview_ready', `Catalog preview ready for ${rows.length.toLocaleString()} rows`);
    return {
      previewId,
      filePath,
      sheetNames: workbook.SheetNames,
      selectedSheet,
      rowCount: rows.length,
      columns,
      mapping,
      sampleRows: rows.slice(0, 8),
      diff,
      warnings
    };
  }

  cancelImportPreview(previewId: string): boolean {
    const result = this.db.raw.prepare(`
      UPDATE catalog_import_previews SET status = 'cancelled', updated_at = ?
      WHERE id = ? AND status = 'staged'
    `).run(new Date().toISOString(), previewId);
    return Number(result.changes) === 1;
  }

  validationTemplates(): CatalogValidationTemplate[] {
    return (this.db.raw.prepare(`
      SELECT * FROM catalog_validation_templates ORDER BY built_in DESC, name, id
    `).all() as Array<Record<string, unknown>>).map(row => ({
      id: String(row.id),
      name: String(row.name),
      description: String(row.description),
      sourcePattern: String(row.source_pattern),
      requiredFields: JSON.parse(String(row.required_fields_json)) as string[],
      identityFields: JSON.parse(String(row.identity_fields_json)) as string[],
      minimumRows: Number(row.minimum_rows),
      maximumInvalidRatio: Number(row.maximum_invalid_ratio),
      builtIn: Boolean(row.built_in)
    }));
  }

  latestRefresh(): CatalogRefreshRun | null {
    const row = this.db.raw.prepare(`
      SELECT * FROM catalog_refresh_runs ORDER BY created_at DESC, id DESC LIMIT 1
    `).get() as Record<string, unknown> | undefined;
    return row ? this.refreshFromRow(row) : null;
  }

  refresh(sourcePath: string, templateId = 'envato-default'): CatalogRefreshRun {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const template = this.validationTemplates().find(item => item.id === templateId);
    if (!template) throw new Error(`Catalog validation template not found: ${templateId}`);
    if (!sourcePath || !existsSync(sourcePath)) {
      const result = this.saveRefresh({
        id, sourcePath, sourceSha256: null, templateId, previewId: null,
        status: 'failed', diff: this.emptyDiff(),
        validation: { valid: false, issues: ['The configured catalog source file does not exist.'] },
        error: 'The configured catalog source file does not exist.', createdAt
      });
      return result;
    }
    try {
      const preview = this.previewImport(sourcePath);
      const issues: string[] = [];
      if (preview.rowCount < template.minimumRows) {
        issues.push(`Expected at least ${template.minimumRows} row(s); found ${preview.rowCount}.`);
      }
      for (const field of template.requiredFields) {
        if (!preview.mapping[field]) issues.push(`Required mapped field is missing: ${field}.`);
      }
      if (!template.identityFields.some(field => Boolean(preview.mapping[field]))) {
        issues.push(`At least one durable identity field is required: ${template.identityFields.join(' or ')}.`);
      }
      const invalidRatio = preview.rowCount ? preview.diff.invalid / preview.rowCount : 1;
      if (invalidRatio > template.maximumInvalidRatio) {
        issues.push(`Invalid-row ratio ${(invalidRatio * 100).toFixed(1)}% exceeds ${(template.maximumInvalidRatio * 100).toFixed(1)}%.`);
      }
      const changed = preview.diff.inserted + preview.diff.changed + preview.diff.conflicts + preview.diff.missing;
      const status: CatalogRefreshRun['status'] = issues.length
        ? 'blocked'
        : changed === 0 ? 'up_to_date' : 'staged';
      if (status !== 'staged') this.cancelImportPreview(preview.previewId);
      return this.saveRefresh({
        id,
        sourcePath,
        sourceSha256: createHash('sha256').update(readFileSync(sourcePath)).digest('hex'),
        templateId,
        previewId: status === 'staged' ? preview.previewId : null,
        status,
        diff: preview.diff,
        validation: { valid: issues.length === 0, issues },
        error: null,
        createdAt
      });
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000);
      return this.saveRefresh({
        id, sourcePath, sourceSha256: null, templateId, previewId: null,
        status: 'failed', diff: this.emptyDiff(),
        validation: { valid: false, issues: [message] }, error: message, createdAt
      });
    }
  }

  private emptyDiff(): CatalogImportDiff {
    return {
      inserted: 0, changed: 0, conflicts: 0, missing: 0, unchanged: 0, invalid: 0,
      sampleInserted: [], sampleChanged: [], sampleConflicts: [], sampleMissing: []
    };
  }

  private saveRefresh(run: CatalogRefreshRun): CatalogRefreshRun {
    this.db.raw.prepare(`
      INSERT INTO catalog_refresh_runs(
        id, source_path, source_sha256, template_id, preview_id, status,
        diff_json, validation_json, error, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id, run.sourcePath, run.sourceSha256, run.templateId, run.previewId,
      run.status, JSON.stringify(run.diff), JSON.stringify(run.validation),
      run.error, run.createdAt
    );
    return run;
  }

  private refreshFromRow(row: Record<string, unknown>): CatalogRefreshRun {
    return {
      id: String(row.id),
      sourcePath: String(row.source_path),
      sourceSha256: row.source_sha256 ? String(row.source_sha256) : null,
      templateId: row.template_id ? String(row.template_id) : null,
      previewId: row.preview_id ? String(row.preview_id) : null,
      status: row.status as CatalogRefreshRun['status'],
      diff: JSON.parse(String(row.diff_json)) as CatalogImportDiff,
      validation: JSON.parse(String(row.validation_json)) as CatalogRefreshRun['validation'],
      error: row.error ? String(row.error) : null,
      createdAt: String(row.created_at)
    };
  }

  private normalizeRow(
    row: Record<string, unknown>,
    mapping: Record<string, string | null>
  ): NormalizedRow | null {
    const get = (key: string): unknown => {
      const column = mapping[key];
      return column ? row[column] : null;
    };

    const sourceRowId = normalizeNullable(get('sourceRowId'));
    const pageUrl = normalizeNullable(get('canonicalPageUrl'));
    const authorName = canonicalizeName(get('authorName'));
    const title = canonicalizeName(get('title'))
      ?? canonicalizeName(get('description'))
      ?? `Asset ${sourceRowId ?? 'untitled'}`;

    if (!pageUrl && !sourceRowId && !title) return null;

    const providerAssetId = pageUrl
      ? pageUrl.match(/-([A-Z0-9]{5,})(?:\?|$)/i)?.[1] ?? null
      : null;
    const country = canonicalizeName(get('country'));
    const city = canonicalizeName(get('city'));
    const locationName = canonicalizeName(get('locationName'));
    const resolution = parseResolution(get('declaredResolution'));
    const orientation = inferOrientation(get('orientation'), resolution.width, resolution.height);

    return {
      stableKey: stableAssetKey({
        provider: 'envato',
        providerAssetId,
        canonicalPageUrl: pageUrl,
        sourceRowId,
        title,
        authorName
      }),
      sourceRowId,
      pageUrl,
      providerAssetId,
      authorName,
      title,
      description: normalizeNullable(get('description')),
      rawAttributes: normalizeNullable(get('rawAttributes')),
      rawTags: normalizeNullable(get('rawTags')),
      rawExtractedData: normalizeNullable(get('rawExtractedData')),
      country,
      city,
      locationName,
      activity: canonicalizeName(get('activity')),
      shotType: canonicalizeName(get('shotType')),
      sceneDescription: canonicalizeName(get('sceneDescription')),
      objects: canonicalizeName(get('objects')),
      timeOfDay: canonicalizeName(get('timeOfDay')),
      style: canonicalizeName(get('style')),
      durationMs: parseDurationMs(get('declaredDuration')),
      thumbnailUrl: normalizeNullable(get('thumbnailUrl')),
      width: resolution.width,
      height: resolution.height,
      fileSizeBytes: parseFileSizeBytes(get('declaredFileSize')),
      frameRate: parseFrameRate(get('declaredFrameRate')),
      alpha: normalizeBoolean(get('declaredAlpha')),
      looped: normalizeBoolean(get('declaredLooped')),
      codec: normalizeNullable(get('declaredCodec')),
      orientation,
      granularity: inferLocationGranularity({ country, city, location: locationName }),
      locationConfidence: locationName ? 0.72 : city ? 0.55 : country ? 0.4 : 0.15,
      rawRow: row
    };
  }

  private importWarnings(mapping: Record<string, string | null>): string[] {
    const warnings: string[] = [];
    if (!mapping.canonicalPageUrl) warnings.push('No URL column was detected.');
    if (!mapping.title) warnings.push('No title column was detected.');
    if (!mapping.country && !mapping.city && !mapping.locationName) {
      warnings.push('No geographic columns were detected; exact-location matching will be unavailable.');
    }
    return warnings;
  }

  private latestSourceAssets(filePath: string, sheetName: string): Map<string, {
    assetId: string | null;
    title: string;
    rawRow: Record<string, unknown>;
  }> {
    const latest = this.db.raw.prepare(`
      SELECT id FROM catalog_imports
      WHERE source_path = ? AND COALESCE(sheet_name, '') = ? AND status = 'completed'
      ORDER BY completed_at DESC, started_at DESC, id DESC LIMIT 1
    `).get(filePath, sheetName) as { id: string } | undefined;
    if (!latest) return new Map();
    const evidenceRows = this.db.raw.prepare(`
      SELECT r.stable_key, COALESCE(a.id, r.asset_id) AS asset_id,
        COALESCE(a.title, json_extract(r.normalized_json, '$.title'), 'Unknown asset') AS title,
        r.raw_row_json
      FROM catalog_import_rows r
      LEFT JOIN assets a ON a.stable_key = r.stable_key
      WHERE r.import_id = ? AND r.stable_key IS NOT NULL
        AND r.disposition NOT IN ('duplicate','missing','invalid')
      ORDER BY r.row_index, r.id
    `).all(latest.id) as Array<Record<string, unknown>>;
    const fallbackRows = evidenceRows.length ? [] : this.db.raw.prepare(`
      SELECT stable_key, id AS asset_id, title, raw_row_json
      FROM assets WHERE import_id = ? ORDER BY stable_key
    `).all(latest.id) as Array<Record<string, unknown>>;
    const result = new Map<string, { assetId: string | null; title: string; rawRow: Record<string, unknown> }>();
    for (const row of evidenceRows.length ? evidenceRows : fallbackRows) {
      const stableKey = String(row.stable_key);
      if (result.has(stableKey)) continue;
      let rawRow: Record<string, unknown> = {};
      try {
        const decoded = JSON.parse(String(row.raw_row_json ?? '{}'));
        if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) rawRow = decoded as Record<string, unknown>;
      } catch {
        // Retain an empty evidence object for malformed legacy rows.
      }
      result.set(stableKey, {
        assetId: row.asset_id ? String(row.asset_id) : null,
        title: String(row.title ?? 'Unknown asset'),
        rawRow
      });
    }
    return result;
  }

  private calculateImportDiff(
    rows: Array<NormalizedRow | null>,
    filePath: string,
    sheetName: string
  ): CatalogImportDiff {
    const existing = this.existingCatalogIndex();
    const priorSourceAssets = this.latestSourceAssets(filePath, sheetName);
    const seen = new Set<string>();
    const seenAssetIds = new Set<string>();
    const sampleInserted: string[] = [];
    const sampleChanged: string[] = [];
    const sampleConflicts: string[] = [];
    const sampleMissing: string[] = [];
    let inserted = 0;
    let changed = 0;
    let conflicts = 0;
    let unchanged = 0;
    let invalid = 0;
    for (const [index, row] of rows.entries()) {
      if (index % 128 === 0) {
        this.importCheckpoint(
          0.56 + 0.38 * (index / Math.max(1, rows.length)),
          'preview_diffing',
          `Comparing catalog row ${index.toLocaleString()} of ${rows.length.toLocaleString()}`
        );
      }
      if (!row) {
        invalid += 1;
        continue;
      }
      if (seen.has(row.stableKey)) continue;
      seen.add(row.stableKey);
      const prior = this.findExisting(row, existing);
      if (prior) seenAssetIds.add(prior.id);
      if (!prior) {
        inserted += 1;
        if (sampleInserted.length < 20) sampleInserted.push(row.title);
      } else if (String(prior.raw_row_json) === JSON.stringify(row.rawRow)) {
        unchanged += 1;
      } else if (prior.human_override_json) {
        conflicts += 1;
        if (sampleConflicts.length < 20) sampleConflicts.push(row.title);
      } else {
        changed += 1;
        if (sampleChanged.length < 20) sampleChanged.push(row.title);
      }
    }
    for (const [stableKey, prior] of priorSourceAssets) {
      if (seen.has(stableKey) || (prior.assetId && seenAssetIds.has(prior.assetId))) continue;
      if (sampleMissing.length < 20) sampleMissing.push(prior.title);
    }
    return {
      inserted,
      changed,
      conflicts,
      missing: [...priorSourceAssets.entries()].filter(([key, prior]) => (
        !seen.has(key) && !(prior.assetId && seenAssetIds.has(prior.assetId))
      )).length,
      unchanged,
      invalid,
      sampleInserted,
      sampleChanged,
      sampleConflicts,
      sampleMissing
    };
  }

  private normalizedMetadata(row: NormalizedRow): Partial<Record<CatalogMetadataField, unknown>> {
    return {
      providerAssetId: row.providerAssetId,
      sourceRowId: row.sourceRowId,
      canonicalPageUrl: row.pageUrl,
      authorName: row.authorName,
      title: row.title,
      description: row.description,
      rawAttributes: row.rawAttributes,
      rawTags: row.rawTags,
      rawExtractedData: row.rawExtractedData,
      country: row.country,
      city: row.city,
      locationName: row.locationName,
      activity: row.activity,
      shotType: row.shotType,
      sceneDescription: row.sceneDescription,
      objects: row.objects,
      timeOfDay: row.timeOfDay,
      style: row.style,
      declaredDurationMs: row.durationMs,
      thumbnailUrl: row.thumbnailUrl,
      declaredWidth: row.width,
      declaredHeight: row.height,
      declaredFileSizeBytes: row.fileSizeBytes,
      declaredFrameRate: row.frameRate,
      declaredAlpha: row.alpha,
      declaredLooped: row.looped,
      declaredCodec: row.codec,
      orientation: row.orientation,
      locationGranularity: row.granularity,
      locationConfidence: row.locationConfidence,
      verificationStatus: 'metadata',
      availabilityStatus: 'unknown',
      excluded: false
    };
  }

  private recordImportRow(input: {
    previewId: string;
    importId: string;
    rowIndex: number;
    rawRow: Record<string, unknown>;
    normalized: NormalizedRow | null;
    disposition: 'inserted' | 'changed' | 'conflict' | 'missing' | 'unchanged' | 'invalid' | 'duplicate';
    assetId: string | null;
    at: string;
    stableKey?: string;
  }): void {
    this.db.raw.prepare(`
      INSERT INTO catalog_import_rows(
        id, preview_id, import_id, row_index, stable_key, raw_row_json,
        normalized_json, disposition, asset_id, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), input.previewId, input.importId, input.rowIndex,
      input.stableKey ?? input.normalized?.stableKey ?? null,
      JSON.stringify(input.rawRow), input.normalized ? JSON.stringify(input.normalized) : null,
      input.disposition, input.assetId, input.at
    );
  }

  commitImport(
    filePath: string,
    sheetName?: string,
    suppliedMapping?: Record<string, string | null>,
    previewId?: string
  ): CatalogImportResult {
    if (!previewId) throw new Error('A current staged import preview is required before commit.');
    this.importCheckpoint(0.01, 'commit_reading', 'Reading the staged catalog workbook');
    const workbook = this.readWorkbook(filePath);
    const selectedSheet = sheetName && workbook.SheetNames.includes(sheetName)
      ? sheetName
      : workbook.SheetNames[0];
    if (!selectedSheet) throw new Error('Spreadsheet contains no worksheets.');
    const sheet = workbook.Sheets[selectedSheet];
    if (!sheet) throw new Error(`Worksheet not found: ${selectedSheet}`);
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: null,
      raw: false
    });
    this.importCheckpoint(0.05, 'commit_validating', `Validating ${rows.length.toLocaleString()} staged rows`);
    const columns = rows.length ? Object.keys(rows[0] ?? {}) : [];
    const mapping = suppliedMapping ?? detectColumnMapping(columns);
    const importId = randomUUID();
    const now = new Date().toISOString();
    const sourceHash = createHash('sha256').update(readFileSync(filePath)).digest('hex');
    const preview = this.db.raw.prepare(`
      SELECT * FROM catalog_import_previews WHERE id = ? AND status = 'staged'
    `).get(previewId) as Record<string, unknown> | undefined;
    if (!preview) throw new Error('A current staged import preview is required before commit.');
    if (
      String(preview.source_path) !== filePath
      || String(preview.sheet_name) !== selectedSheet
      || String(preview.source_sha256) !== sourceHash
      || String(preview.column_mapping_json) !== JSON.stringify(mapping)
    ) throw new Error('Catalog source or mapping changed after preview; preview again before commit.');

    this.db.raw.prepare(`
      INSERT INTO catalog_imports(
        id, source_path, source_name, sheet_name, source_sha256, row_count,
        column_mapping_json, preview_id, status, started_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)
    `).run(
      importId,
      filePath,
      basename(filePath),
      selectedSheet,
      sourceHash,
      rows.length,
      JSON.stringify(mapping),
      previewId,
      now
    );

    const existingIndex = this.existingCatalogIndex();
    const insert = this.db.raw.prepare(`
      INSERT INTO assets(
        id, stable_key, provider, provider_asset_id, source_row_id, canonical_page_url,
        author_name, title, description, raw_attributes, raw_tags, raw_extracted_data,
        country, city, location_name, activity, shot_type, scene_description, objects,
        time_of_day, style, declared_duration_ms, thumbnail_url, declared_width,
        declared_height, declared_file_size_bytes, declared_frame_rate, declared_alpha,
        declared_looped, declared_codec, orientation, location_granularity,
        location_confidence, verification_status, availability_status, raw_row_json,
        import_id, imported_at, updated_at
      ) VALUES(
        ?, ?, 'envato', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'metadata', 'unknown', ?, ?, ?, ?
      )
    `);
    const update = this.db.raw.prepare(`
      UPDATE assets SET
        provider_asset_id = ?,
        source_row_id = ?,
        canonical_page_url = ?,
        author_name = ?,
        title = COALESCE(json_extract(human_override_json, '$.title'), ?),
        description = COALESCE(json_extract(human_override_json, '$.description'), ?),
        raw_attributes = ?,
        raw_tags = ?,
        raw_extracted_data = ?,
        country = COALESCE(json_extract(human_override_json, '$.country'), ?),
        city = COALESCE(json_extract(human_override_json, '$.city'), ?),
        location_name = COALESCE(json_extract(human_override_json, '$.locationName'), ?),
        activity = COALESCE(json_extract(human_override_json, '$.activity'), ?),
        shot_type = COALESCE(json_extract(human_override_json, '$.shotType'), ?),
        scene_description = COALESCE(json_extract(human_override_json, '$.sceneDescription'), ?),
        objects = COALESCE(json_extract(human_override_json, '$.objects'), ?),
        time_of_day = COALESCE(json_extract(human_override_json, '$.timeOfDay'), ?),
        style = COALESCE(json_extract(human_override_json, '$.style'), ?),
        declared_duration_ms = ?,
        thumbnail_url = ?,
        declared_width = ?,
        declared_height = ?,
        declared_file_size_bytes = ?,
        declared_frame_rate = ?,
        declared_alpha = ?,
        declared_looped = ?,
        declared_codec = ?,
        orientation = ?,
        location_granularity = ?,
        location_confidence = CASE
          WHEN verification_status = 'human_verified' THEN location_confidence
          ELSE ?
        END,
        raw_row_json = ?,
        import_id = ?,
        updated_at = ?
      WHERE id = ?
    `);

    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let conflicts = 0;
    let invalid = 0;
    let missing = 0;
    const warnings = this.importWarnings(mapping);
    const seenStableKeys = new Set<string>();
    const seenAssetIds = new Set<string>();
    const assetByStableKey = new Map<string, string>();
    const normalizedByAsset = new Map<string, NormalizedRow>();
    const initialAssetIds = new Set<string>();
    const priorSourceAssets = this.latestSourceAssets(filePath, selectedSheet);

    const transaction = this.db.raw.transaction(() => {
      for (const [rowIndex, row] of rows.entries()) {
        if (rowIndex % 64 === 0) {
          this.importCheckpoint(
            0.08 + 0.58 * (rowIndex / Math.max(1, rows.length)),
            'commit_assets',
            `Committing catalog row ${rowIndex.toLocaleString()} of ${rows.length.toLocaleString()}`
          );
        }
        const normalized = this.normalizeRow(row, mapping);
        if (!normalized) {
          invalid += 1;
          this.recordImportRow({ previewId, importId, rowIndex, rawRow: row, normalized: null, disposition: 'invalid', assetId: null, at: now });
          continue;
        }
        const duplicateWithinFile = seenStableKeys.has(normalized.stableKey);
        if (duplicateWithinFile) {
          const duplicateAssetId = assetByStableKey.get(normalized.stableKey)
            ?? this.findExisting(normalized, existingIndex)?.id
            ?? null;
          this.recordImportRow({
            previewId, importId, rowIndex, rawRow: row, normalized,
            disposition: 'duplicate', assetId: duplicateAssetId, at: now
          });
          continue;
        }
        seenStableKeys.add(normalized.stableKey);
        const existing = this.findExisting(normalized, existingIndex);
        if (existing) seenAssetIds.add(existing.id);
        const rawJson = JSON.stringify(normalized.rawRow);

        if (!existing) {
          const assetId = randomUUID();
          insert.run(
            assetId,
            normalized.stableKey,
            normalized.providerAssetId,
            normalized.sourceRowId,
            normalized.pageUrl,
            normalized.authorName,
            normalized.title,
            normalized.description,
            normalized.rawAttributes,
            normalized.rawTags,
            normalized.rawExtractedData,
            normalized.country,
            normalized.city,
            normalized.locationName,
            normalized.activity,
            normalized.shotType,
            normalized.sceneDescription,
            normalized.objects,
            normalized.timeOfDay,
            normalized.style,
            normalized.durationMs,
            normalized.thumbnailUrl,
            normalized.width,
            normalized.height,
            normalized.fileSizeBytes,
            normalized.frameRate,
            normalized.alpha === null ? null : Number(normalized.alpha),
            normalized.looped === null ? null : Number(normalized.looped),
            normalized.codec,
            normalized.orientation,
            normalized.granularity,
            normalized.locationConfidence,
            rawJson,
            importId,
            now,
            now
          );
          inserted += 1;
          assetByStableKey.set(normalized.stableKey, assetId);
          normalizedByAsset.set(assetId, normalized);
          initialAssetIds.add(assetId);
          this.recordImportRow({ previewId, importId, rowIndex, rawRow: row, normalized, disposition: 'inserted', assetId, at: now });
        } else if (existing.raw_row_json === rawJson) {
          unchanged += 1;
          assetByStableKey.set(normalized.stableKey, existing.id);
          normalizedByAsset.set(existing.id, normalized);
          this.recordImportRow({ previewId, importId, rowIndex, rawRow: row, normalized, disposition: 'unchanged', assetId: existing.id, at: now });
        } else {
          const conflict = Boolean(existing.human_override_json);
          if (conflict) conflicts += 1;
          update.run(
            normalized.providerAssetId,
            normalized.sourceRowId,
            normalized.pageUrl,
            normalized.authorName,
            normalized.title,
            normalized.description,
            normalized.rawAttributes,
            normalized.rawTags,
            normalized.rawExtractedData,
            normalized.country,
            normalized.city,
            normalized.locationName,
            normalized.activity,
            normalized.shotType,
            normalized.sceneDescription,
            normalized.objects,
            normalized.timeOfDay,
            normalized.style,
            normalized.durationMs,
            normalized.thumbnailUrl,
            normalized.width,
            normalized.height,
            normalized.fileSizeBytes,
            normalized.frameRate,
            normalized.alpha === null ? null : Number(normalized.alpha),
            normalized.looped === null ? null : Number(normalized.looped),
            normalized.codec,
            normalized.orientation,
            normalized.granularity,
            normalized.locationConfidence,
            rawJson,
            importId,
            now,
            existing.id
          );
          updated += 1;
          assetByStableKey.set(normalized.stableKey, existing.id);
          normalizedByAsset.set(existing.id, normalized);
          this.recordImportRow({ previewId, importId, rowIndex, rawRow: row, normalized, disposition: conflict ? 'conflict' : 'changed', assetId: existing.id, at: now });
        }
      }
      const missingRows = [...priorSourceAssets.entries()]
        .filter(([stableKey, prior]) => (
          !seenStableKeys.has(stableKey) && !(prior.assetId && seenAssetIds.has(prior.assetId))
        ))
        .map(([stableKey, prior]) => ({ stableKey, ...prior }));
      missing = missingRows.length;
      this.importCheckpoint(0.67, 'commit_missing', `Recording ${missing.toLocaleString()} missing source rows`);
      for (const [offset, row] of missingRows.entries()) {
        if (offset % 64 === 0 && this.importHooks.isCancelled?.()) throw new CatalogImportCancelledError();
        this.recordImportRow({
          previewId, importId, rowIndex: rows.length + offset,
          rawRow: row.rawRow,
          normalized: null, disposition: 'missing', assetId: row.assetId, at: now, stableKey: row.stableKey
        });
      }
      let metadataIndex = 0;
      for (const [assetId, normalized] of normalizedByAsset) {
        if (metadataIndex % 32 === 0) {
          this.importCheckpoint(
            0.7 + 0.2 * (metadataIndex / Math.max(1, normalizedByAsset.size)),
            'commit_metadata',
            `Recording metadata evidence ${metadataIndex.toLocaleString()} of ${normalizedByAsset.size.toLocaleString()}`
          );
        }
        this.metadata.recordImportLayers({
          assetId,
          importId,
          normalized: this.normalizedMetadata(normalized),
          rawRow: normalized.rawRow,
          mapping,
          at: now,
          initialAsset: initialAssetIds.has(assetId)
        });
        metadataIndex += 1;
      }
      this.importCheckpoint(0.92, 'commit_places', 'Synchronizing canonical place evidence');
      this.places.syncAssetsForImport(importId);
      this.importCheckpoint(0.97, 'commit_finalizing', 'Finalizing the catalog import receipt');
      this.db.raw.prepare(`
        UPDATE catalog_import_previews SET status = 'committed', committed_import_id = ?, updated_at = ?
        WHERE id = ?
      `).run(importId, now, previewId);
    });
    try {
      transaction();
    } catch (error) {
      this.db.raw.prepare(`
        UPDATE catalog_imports SET status = ?, error = ?, completed_at = ? WHERE id = ?
      `).run(
        error instanceof CatalogImportCancelledError ? 'cancelled' : 'failed',
        error instanceof Error ? error.message : String(error),
        new Date().toISOString(),
        importId
      );
      throw error;
    }
    this.db.raw.prepare(`
      UPDATE catalog_imports SET
        inserted_count = ?,
        updated_count = ?,
        unchanged_count = ?,
        conflict_count = ?,
        missing_count = ?,
        invalid_count = ?,
        warnings_json = ?,
        status = 'completed',
        completed_at = ?
      WHERE id = ?
    `).run(inserted, updated, unchanged, conflicts, missing, invalid, JSON.stringify(warnings), new Date().toISOString(), importId);

    this.invalidateSearchCaches();
    this.importHooks.onProgress?.(1, 'commit_complete', `Committed ${rows.length.toLocaleString()} catalog rows`);
    return {
      importId,
      inserted,
      updated,
      unchanged,
      conflicts,
      missing,
      invalid,
      total: rows.length,
      warnings
    };
  }

  search(request: CatalogSearchRequest): CatalogSearchResult {
    const page = Math.max(1, request.page || 1);
    const pageSize = Math.min(500, Math.max(10, request.pageSize || 100));
    const where: string[] = ['a.excluded = 0'];
    const params: unknown[] = [];
    let ftsJoin = '';

    if (request.query?.trim()) {
      ftsJoin = 'JOIN assets_fts f ON f.asset_id = a.id';
      where.push('assets_fts MATCH ?');
      params.push(ftsQuery(request.query));
    }
    if (request.country) { where.push('a.country = ? COLLATE NOCASE'); params.push(request.country); }
    if (request.city) { where.push('a.city = ? COLLATE NOCASE'); params.push(request.city); }
    if (request.locationName) { where.push('a.location_name = ? COLLATE NOCASE'); params.push(request.locationName); }
    if (request.author) { where.push('a.author_name = ? COLLATE NOCASE'); params.push(request.author); }
    if (request.orientation) { where.push('a.orientation = ?'); params.push(request.orientation); }
    if (request.verificationStatus) { where.push('a.verification_status = ?'); params.push(request.verificationStatus); }
    if (request.availabilityStatus) { where.push('a.availability_status = ?'); params.push(request.availabilityStatus); }
    if (request.minimumLocationConfidence !== undefined) {
      where.push('a.location_confidence >= ?');
      params.push(request.minimumLocationConfidence);
    }
    if (request.downloaded === true) where.push('a.local_file_id IS NOT NULL');
    if (request.downloaded === false) where.push('a.local_file_id IS NULL');
    if (request.verified === true) where.push(`a.verification_status = 'human_verified'`);
    if (request.verified === false) where.push(`a.verification_status <> 'human_verified'`);
    if (request.used === true) where.push(`EXISTS (
      SELECT 1 FROM project_scenes used_scene WHERE used_scene.selected_asset_id = a.id
    )`);
    if (request.used === false) where.push(`NOT EXISTS (
      SELECT 1 FROM project_scenes used_scene WHERE used_scene.selected_asset_id = a.id
    )`);
    if (request.licensed === true) where.push(`EXISTS (
      SELECT 1 FROM project_licenses licensed_asset
      WHERE licensed_asset.asset_id = a.id
        AND licensed_asset.license_state IN ('OPERATOR_ATTESTED','CERTIFICATE_ATTACHED','VERIFIED')
    )`);
    if (request.licensed === false) where.push(`NOT EXISTS (
      SELECT 1 FROM project_licenses licensed_asset
      WHERE licensed_asset.asset_id = a.id
        AND licensed_asset.license_state IN ('OPERATOR_ATTESTED','CERTIFICATE_ATTACHED','VERIFIED')
    )`);
    if (request.mediaStatus === 'metadata_only') where.push('a.local_file_id IS NULL');
    if (request.mediaStatus === 'downloaded') where.push(`a.local_file_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM media_segments media_segment
      JOIN asset_files media_file ON media_file.id = media_segment.asset_file_id
      WHERE media_file.asset_id = a.id
    )`);
    if (request.mediaStatus === 'analyzed') where.push(`EXISTS (
      SELECT 1 FROM media_segments media_segment
      JOIN asset_files media_file ON media_file.id = media_segment.asset_file_id
      WHERE media_file.asset_id = a.id
    )`);
    if (request.mediaStatus === 'usable_1080p') where.push(`EXISTS (
      SELECT 1 FROM media_segments media_segment
      JOIN asset_files media_file ON media_file.id = media_segment.asset_file_id
      WHERE media_file.asset_id = a.id AND media_segment.eligible_1080p = 1
    )`);
    if (request.mediaStatus === 'usable_4k') where.push(`EXISTS (
      SELECT 1 FROM media_segments media_segment
      JOIN asset_files media_file ON media_file.id = media_segment.asset_file_id
      WHERE media_file.asset_id = a.id AND media_segment.eligible_4k = 1
    )`);
    if (request.metadataField && request.metadataValue) {
      const metadataColumns: Record<NonNullable<CatalogSearchRequest['metadataField']>, string> = {
        providerAssetId: 'a.provider_asset_id',
        sourceRowId: 'a.source_row_id',
        canonicalPageUrl: 'a.canonical_page_url',
        authorName: 'a.author_name',
        title: 'a.title',
        description: 'a.description',
        rawAttributes: 'a.raw_attributes',
        rawTags: 'a.raw_tags',
        country: 'a.country',
        city: 'a.city',
        locationName: 'a.location_name',
        activity: 'a.activity',
        shotType: 'a.shot_type',
        sceneDescription: 'a.scene_description',
        objects: 'a.objects',
        timeOfDay: 'a.time_of_day',
        style: 'a.style',
        declaredCodec: 'a.declared_codec'
      };
      const escaped = request.metadataValue.replace(/[\\%_]/g, character => `\\${character}`);
      where.push(`COALESCE(${metadataColumns[request.metadataField]}, '') LIKE ? ESCAPE '\\' COLLATE NOCASE`);
      params.push(`%${escaped}%`);
    }

    const sortMap: Record<string, string> = {
      title: 'a.title COLLATE NOCASE',
      country: 'a.country COLLATE NOCASE',
      city: 'a.city COLLATE NOCASE',
      location: 'a.location_name COLLATE NOCASE',
      updated: 'a.updated_at'
    };
    const sort = sortMap[request.sortBy ?? 'updated'] ?? 'a.updated_at';
    const direction = request.sortDirection === 'asc' ? 'ASC' : 'DESC';
    const relevance = request.query?.trim()
      ? 'bm25(assets_fts, 0, 2, 1, 1, 1, 3, 6, 5, 2, 3, 5, 1, 1, 1), '
      : '';
    const whereSql = where.join(' AND ');

    const countRow = this.db.raw.prepare(`
      SELECT count(*) AS total FROM assets a ${ftsJoin} WHERE ${whereSql}
    `).get(...params) as { total: number };

    const rows = this.db.raw.prepare(`
      SELECT a.*,
        (SELECT fingerprint.perceptual_hash FROM asset_files fingerprint
          WHERE fingerprint.id = a.local_file_id) AS perceptual_hash,
        (SELECT count(DISTINCT used_scene.project_id) FROM project_scenes used_scene
          WHERE used_scene.selected_asset_id = a.id) AS used_project_count,
        (SELECT count(DISTINCT licensed_asset.project_id) FROM project_licenses licensed_asset
          WHERE licensed_asset.asset_id = a.id
            AND licensed_asset.license_state IN ('OPERATOR_ATTESTED','CERTIFICATE_ATTACHED','VERIFIED')) AS licensed_project_count,
        CASE
          WHEN EXISTS (
            SELECT 1 FROM media_segments s JOIN asset_files f ON f.id = s.asset_file_id
            WHERE f.asset_id = a.id AND s.eligible_4k = 1
          ) THEN 'usable_4k'
          WHEN EXISTS (
            SELECT 1 FROM media_segments s JOIN asset_files f ON f.id = s.asset_file_id
            WHERE f.asset_id = a.id AND s.eligible_1080p = 1
          ) THEN 'usable_1080p'
          WHEN EXISTS (
            SELECT 1 FROM media_segments s JOIN asset_files f ON f.id = s.asset_file_id
            WHERE f.asset_id = a.id
          ) THEN 'analyzed'
          WHEN a.local_file_id IS NOT NULL THEN 'downloaded'
          ELSE 'metadata_only'
        END AS media_status
      FROM assets a ${ftsJoin}
      WHERE ${whereSql}
      ORDER BY ${relevance}${sort} ${direction}, a.id ${direction}
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, (page - 1) * pageSize).map(toAsset);

    return {
      rows,
      total: countRow.total,
      page,
      pageSize,
      facets: this.catalogFacets()
    };
  }

  private catalogFacets(): CatalogSearchResult['facets'] {
    if (this.cachedFacets) return this.cachedFacets;
    const facet = (field: 'country' | 'city' | 'location_name' | 'author_name') => (
      this.db.raw.prepare(`
        SELECT ${field} AS value, count(*) AS count
        FROM assets
        WHERE excluded = 0 AND ${field} IS NOT NULL AND trim(${field}) <> ''
        GROUP BY ${field}
        ORDER BY count DESC, value ASC
        LIMIT 100
      `).all() as Array<{ value: string; count: number }>
    );
    this.cachedFacets = {
      countries: facet('country'),
      cities: facet('city'),
      locations: facet('location_name'),
      authors: facet('author_name')
    };
    return this.cachedFacets;
  }

  stats(): CatalogStats {
    const row = this.db.raw.prepare(`
      SELECT
        count(*) AS total_assets,
        sum(CASE WHEN local_file_id IS NOT NULL THEN 1 ELSE 0 END) AS downloaded_assets,
        sum(CASE WHEN verification_status = 'human_verified' THEN 1 ELSE 0 END) AS verified_assets,
        count(DISTINCT country) AS countries,
        count(DISTINCT city) AS cities,
        count(DISTINCT location_name) AS locations
      FROM assets WHERE excluded = 0
    `).get() as Record<string, number | null>;
    const imports = this.db.raw.prepare(`SELECT count(*) AS count FROM catalog_imports`).get() as { count: number };
    return {
      totalAssets: Number(row.total_assets ?? 0),
      downloadedAssets: Number(row.downloaded_assets ?? 0),
      verifiedAssets: Number(row.verified_assets ?? 0),
      countries: Number(row.countries ?? 0),
      cities: Number(row.cities ?? 0),
      locations: Number(row.locations ?? 0),
      imports: imports.count
    };
  }

  coverage(limit = 100): CoverageCluster[] {
    const rows = this.db.raw.prepare(`
      SELECT
        coalesce(location_name, city, country, 'Unknown') AS key_name,
        country,
        city,
        location_name,
        count(*) AS asset_count,
        count(DISTINCT shot_type) AS unique_shot_types,
        count(DISTINCT activity) AS unique_activities,
        count(DISTINCT time_of_day) AS unique_times,
        sum(CASE WHEN orientation = 'landscape' THEN 1 ELSE 0 END) AS landscape_count,
        sum(CASE WHEN orientation = 'portrait' THEN 1 ELSE 0 END) AS portrait_count,
        sum(CASE WHEN declared_width >= 1920 AND declared_height >= 1080 THEN 1 ELSE 0 END) AS full_hd_count,
        sum(CASE WHEN declared_width >= 3840 AND declared_height >= 2160 THEN 1 ELSE 0 END) AS four_k_count,
        sum(CASE WHEN local_file_id IS NOT NULL THEN 1 ELSE 0 END) AS downloaded_count,
        sum(CASE WHEN verification_status = 'human_verified' THEN 1 ELSE 0 END) AS verified_count,
        sum(CASE WHEN verification_status = 'human_verified' THEN 1 ELSE 0 END) AS confidence_verified,
        sum(CASE WHEN location_confidence >= 0.8 AND verification_status <> 'human_verified' THEN 1 ELSE 0 END) AS confidence_strong,
        sum(CASE WHEN location_confidence >= 0.5 AND location_confidence < 0.8 THEN 1 ELSE 0 END) AS confidence_contextual,
        sum(CASE WHEN location_confidence < 0.5 THEN 1 ELSE 0 END) AS confidence_weak,
        sum(CASE WHEN lower(coalesce(shot_type,'')) LIKE '%aerial%' OR lower(coalesce(shot_type,'')) LIKE '%drone%' THEN 1 ELSE 0 END) AS aerial_count,
        sum(CASE WHEN lower(coalesce(shot_type,'')) LIKE '%wide%' OR lower(coalesce(shot_type,'')) LIKE '%establish%' THEN 1 ELSE 0 END) AS wide_count,
        sum(CASE WHEN lower(coalesce(shot_type,'')) LIKE '%medium%' OR lower(coalesce(shot_type,'')) LIKE '%mid%' THEN 1 ELSE 0 END) AS medium_count,
        sum(CASE WHEN lower(coalesce(shot_type,'')) LIKE '%detail%' OR lower(coalesce(shot_type,'')) LIKE '%close%' OR lower(coalesce(shot_type,'')) LIKE '%macro%' THEN 1 ELSE 0 END) AS detail_count,
        sum(CASE WHEN lower(coalesce(time_of_day,'')) LIKE '%day%' OR lower(coalesce(time_of_day,'')) LIKE '%morning%' OR lower(coalesce(time_of_day,'')) LIKE '%sun%' THEN 1 ELSE 0 END) AS day_count,
        sum(CASE WHEN lower(coalesce(time_of_day,'')) LIKE '%night%' OR lower(coalesce(time_of_day,'')) LIKE '%evening%' OR lower(coalesce(time_of_day,'')) LIKE '%dusk%' THEN 1 ELSE 0 END) AS night_count,
        sum(CASE WHEN lower(coalesce(style,'') || ' ' || coalesce(scene_description,'')) GLOB '*rain*' OR lower(coalesce(style,'') || ' ' || coalesce(scene_description,'')) GLOB '*snow*' OR lower(coalesce(style,'') || ' ' || coalesce(scene_description,'')) GLOB '*cloud*' OR lower(coalesce(style,'') || ' ' || coalesce(scene_description,'')) GLOB '*storm*' THEN 1 ELSE 0 END) AS weather_count,
        group_concat(DISTINCT activity) AS activities,
        group_concat(DISTINCT objects) AS represented_objects,
        sum(CASE
          WHEN declared_duration_ms IS NULL THEN 2
          ELSE min(12, max(1, cast(declared_duration_ms / 4500 AS INTEGER)))
        END) AS estimated_unique_shots
      FROM assets
      WHERE excluded = 0
        AND (country IS NOT NULL OR city IS NOT NULL OR location_name IS NOT NULL)
      GROUP BY country, city, location_name
      HAVING count(*) >= 3
      ORDER BY asset_count DESC
      LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;

    return rows.map(row => {
      const assetCount = Number(row.asset_count);
      const diversity = Number(row.unique_shot_types) + Number(row.unique_activities) + Number(row.unique_times);
      const landscapeRate = assetCount ? Number(row.landscape_count) / assetCount : 0;
      const verifiedRate = assetCount ? Number(row.verified_count) / assetCount : 0;
      const aerial = Number(row.aerial_count);
      const wide = Number(row.wide_count);
      const medium = Number(row.medium_count);
      const detail = Number(row.detail_count);
      const classifiedShots = aerial + wide + medium + detail;
      const shotBalance = { aerial, wide, medium, detail, other: Math.max(0, assetCount - classifiedShots) };
      const representedActivities = String(row.activities ?? '').split(',').map(value => value.trim()).filter(Boolean).slice(0, 40);
      const representedObjects = String(row.represented_objects ?? '').split(',').map(value => value.trim()).filter(Boolean).slice(0, 40);
      const missingVisualCategories: string[] = (['aerial','wide','medium','detail'] as const)
        .filter(category => shotBalance[category] === 0);
      if (Number(row.day_count) === 0) missingVisualCategories.push('day');
      if (Number(row.night_count) === 0) missingVisualCategories.push('night');
      if (!representedActivities.length) missingVisualCategories.push('activity');
      if (!representedObjects.length) missingVisualCategories.push('objects');
      const estimatedUniqueShots = Number(row.estimated_unique_shots);
      const repetitionRisk = Math.max(0, Math.min(1,
        1 - Math.min(1, (assetCount + diversity * 2 + classifiedShots) / 35)
      ));
      const coverageScore = Math.min(100,
        Math.log2(assetCount + 1) * 11
        + Math.min(25, diversity * 2)
        + landscapeRate * 12
        + verifiedRate * 10
      );
      return {
        key: [row.country, row.city, row.location_name].filter(Boolean).join('|'),
        country: row.country ? String(row.country) : null,
        city: row.city ? String(row.city) : null,
        locationName: row.location_name ? String(row.location_name) : null,
        assetCount,
        uniqueShotTypes: Number(row.unique_shot_types),
        uniqueActivities: Number(row.unique_activities),
        uniqueTimes: Number(row.unique_times),
        landscapeCount: Number(row.landscape_count),
        fourKCount: Number(row.four_k_count),
        downloadedCount: Number(row.downloaded_count),
        verifiedCount: Number(row.verified_count),
        portraitCount: Number(row.portrait_count),
        fullHdEligibleCount: Number(row.full_hd_count),
        estimatedUniqueShots,
        repetitionRisk: Math.round(repetitionRisk * 1000) / 1000,
        exactConfidenceDistribution: {
          verified: Number(row.confidence_verified),
          strong: Number(row.confidence_strong),
          contextual: Number(row.confidence_contextual),
          weak: Number(row.confidence_weak)
        },
        shotBalance,
        variety: {
          day: Number(row.day_count),
          night: Number(row.night_count),
          weather: Number(row.weather_count)
        },
        representedActivities,
        representedObjects,
        missingVisualCategories,
        coverageScore: Math.round(coverageScore * 10) / 10
      };
    });
  }

  updateAsset(assetId: string, patch: Record<string, unknown>, reason = 'operator edit'): CatalogAsset {
    const current = this.db.raw.prepare('SELECT * FROM assets WHERE id = ?').get(assetId) as Record<string, unknown> | undefined;
    if (!current) throw new Error('Asset not found.');
    const changes = Object.entries(patch).filter(([key]) => CATALOG_METADATA_FIELDS[key as CatalogMetadataField]?.humanEditable);
    if (!changes.length) return toAsset(current);
    this.db.raw.transaction(() => this.metadata.applyHumanPatch(assetId, Object.fromEntries(changes), reason))();

    if (changes.some(([key]) => [
      'country', 'city', 'locationName', 'locationGranularity',
      'locationConfidence', 'verificationStatus'
    ].includes(key))) {
      this.places.syncAsset(assetId, 'human');
    }

    this.invalidateSearchCaches();
    return toAsset(this.db.raw.prepare('SELECT * FROM assets WHERE id = ?').get(assetId) as Record<string, unknown>);
  }

  bulkUpdateAssets(assetIds: string[], patch: Record<string, unknown>, reason = 'bulk operator edit'): CatalogAsset[] {
    const ids = [...new Set(assetIds)].slice(0, 5_000);
    if (!ids.length) return [];
    const updated = this.db.raw.transaction(() => ids.map(assetId => this.updateAsset(assetId, patch, reason)))();
    return updated;
  }

  exportFiltered(request: CatalogSearchRequest, outputPath: string): CatalogExportReport {
    const rows: CatalogAsset[] = [];
    let page = 1;
    while (true) {
      const result = this.search({ ...request, page, pageSize: 500 });
      rows.push(...result.rows);
      if (rows.length >= result.total) break;
      page += 1;
    }
    const quote = (value: unknown): string => {
      const text = value === null || value === undefined ? '' : String(value);
      return `"${text.replaceAll('"', '""')}"`;
    };
    const columns: Array<keyof CatalogAsset> = [
      'id','provider','providerAssetId','sourceRowId','canonicalPageUrl','authorName','title','description',
      'rawAttributes','rawTags','country','city','locationName','activity','shotType','sceneDescription',
      'objects','timeOfDay','style','declaredDurationMs','thumbnailUrl','declaredWidth','declaredHeight',
      'declaredFileSizeBytes','declaredFrameRate','declaredAlpha','declaredLooped','declaredCodec','orientation',
      'locationGranularity','locationConfidence','verificationStatus','availabilityStatus','localFileId','excluded'
    ];
    const csv = `${columns.join(',')}\n${rows.map(row => columns.map(column => quote(row[column])).join(',')).join('\n')}\n`;
    writeFileSync(outputPath, csv, 'utf8');
    const id = randomUUID();
    const sha256 = createHash('sha256').update(csv).digest('hex');
    const createdAt = new Date().toISOString();
    this.db.raw.prepare(`
      INSERT INTO catalog_exports(id, output_path, filter_json, row_count, sha256, created_at)
      VALUES(?, ?, ?, ?, ?, ?)
    `).run(id, outputPath, JSON.stringify(request), rows.length, sha256, createdAt);
    return { id, outputPath, rowCount: rows.length, sha256, createdAt };
  }

  revisions(assetId: string): Array<{
    id: string;
    fieldName: string;
    previousValue: unknown;
    newValue: unknown;
    reason: string | null;
    createdAt: string;
    revertedAt: string | null;
  }> {
    return (this.db.raw.prepare(`
      SELECT * FROM asset_metadata_revisions
      WHERE asset_id = ? ORDER BY created_at DESC, id DESC LIMIT 250
    `).all(assetId) as Array<Record<string, unknown>>).map(row => ({
      id: String(row.id),
      fieldName: String(row.field_name),
      previousValue: row.previous_value_json ? JSON.parse(String(row.previous_value_json)) : null,
      newValue: row.new_value_json ? JSON.parse(String(row.new_value_json)) : null,
      reason: row.reason ? String(row.reason) : null,
      createdAt: String(row.created_at),
      revertedAt: row.reverted_at ? String(row.reverted_at) : null
    }));
  }

  revertRevision(revisionId: string): CatalogAsset {
    const revision = this.db.raw.prepare(`
      SELECT * FROM asset_metadata_revisions WHERE id = ?
    `).get(revisionId) as Record<string, unknown> | undefined;
    if (!revision) throw new Error('Metadata revision not found.');
    if (revision.reverted_at) throw new Error('Metadata revision was already reverted.');
    const assetId = String(revision.asset_id);
    const fieldName = String(revision.field_name);
    const previousValue = revision.previous_value_json
      ? JSON.parse(String(revision.previous_value_json))
      : null;
    const asset = this.updateAsset(assetId, { [fieldName]: previousValue }, `Undo revision ${revisionId}`);
    this.db.raw.prepare('UPDATE asset_metadata_revisions SET reverted_at = ? WHERE id = ?')
      .run(new Date().toISOString(), revisionId);
    return asset;
  }
}
