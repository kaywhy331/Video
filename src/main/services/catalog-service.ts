import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import * as XLSX from 'xlsx';
import type { AppDatabase } from '../database/database';
import type {
  CatalogAsset,
  CatalogImportPreview,
  CatalogImportResult,
  CatalogSearchRequest,
  CatalogSearchResult,
  CatalogStats,
  CoverageCluster
} from '@shared/types';
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

export class CatalogService {
  constructor(private readonly db: AppDatabase) {}

  private readWorkbook(filePath: string): XLSX.WorkBook {
    return XLSX.readFile(filePath, {
      cellDates: true,
      raw: false,
      dense: false
    });
  }

  previewImport(filePath: string, sheetName?: string): CatalogImportPreview {
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
    const columns = rows.length ? Object.keys(rows[0] ?? {}) : [];
    return {
      filePath,
      sheetNames: workbook.SheetNames,
      selectedSheet,
      rowCount: rows.length,
      columns,
      mapping: detectColumnMapping(columns),
      sampleRows: rows.slice(0, 8)
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

  commitImport(
    filePath: string,
    sheetName?: string,
    suppliedMapping?: Record<string, string | null>
  ): CatalogImportResult {
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
    const columns = rows.length ? Object.keys(rows[0] ?? {}) : [];
    const mapping = suppliedMapping ?? detectColumnMapping(columns);
    const importId = randomUUID();
    const now = new Date().toISOString();
    const sourceHash = createHash('sha256').update(readFileSync(filePath)).digest('hex');

    this.db.raw.prepare(`
      INSERT INTO catalog_imports(
        id, source_path, source_name, sheet_name, source_sha256, row_count,
        column_mapping_json, started_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      importId,
      filePath,
      basename(filePath),
      selectedSheet,
      sourceHash,
      rows.length,
      JSON.stringify(mapping),
      now
    );

    const getExisting = this.db.raw.prepare(`
      SELECT id, raw_row_json, human_override_json
      FROM assets WHERE stable_key = ?
    `);
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
      WHERE stable_key = ?
    `);

    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let conflicts = 0;
    let invalid = 0;
    const warnings: string[] = [];

    const transaction = this.db.raw.transaction(() => {
      for (const row of rows) {
        const normalized = this.normalizeRow(row, mapping);
        if (!normalized) {
          invalid += 1;
          continue;
        }
        const existing = getExisting.get(normalized.stableKey) as
          | { id: string; raw_row_json: string; human_override_json: string | null }
          | undefined;
        const rawJson = JSON.stringify(normalized.rawRow);

        if (!existing) {
          insert.run(
            randomUUID(),
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
        } else if (existing.raw_row_json === rawJson) {
          unchanged += 1;
        } else {
          if (existing.human_override_json) conflicts += 1;
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
            normalized.stableKey
          );
          updated += 1;
        }
      }
    });
    transaction();

    if (!mapping.canonicalPageUrl) warnings.push('No URL column was detected.');
    if (!mapping.title) warnings.push('No title column was detected.');
    if (!mapping.country && !mapping.city && !mapping.locationName) {
      warnings.push('No geographic columns were detected; exact-location matching will be unavailable.');
    }

    this.db.raw.prepare(`
      UPDATE catalog_imports SET
        inserted_count = ?,
        updated_count = ?,
        unchanged_count = ?,
        conflict_count = ?,
        invalid_count = ?,
        warnings_json = ?,
        completed_at = ?
      WHERE id = ?
    `).run(inserted, updated, unchanged, conflicts, invalid, JSON.stringify(warnings), new Date().toISOString(), importId);

    return {
      importId,
      inserted,
      updated,
      unchanged,
      conflicts,
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
    if (request.downloaded === true) where.push('a.local_file_id IS NOT NULL');
    if (request.downloaded === false) where.push('a.local_file_id IS NULL');
    if (request.verified === true) where.push(`a.verification_status = 'human_verified'`);
    if (request.verified === false) where.push(`a.verification_status <> 'human_verified'`);

    const sortMap: Record<string, string> = {
      title: 'a.title',
      country: 'a.country',
      city: 'a.city',
      location: 'a.location_name',
      updated: 'a.updated_at'
    };
    const sort = sortMap[request.sortBy ?? 'updated'] ?? 'a.updated_at';
    const direction = request.sortDirection === 'asc' ? 'ASC' : 'DESC';
    const whereSql = where.join(' AND ');

    const countRow = this.db.raw.prepare(`
      SELECT count(*) AS total FROM assets a ${ftsJoin} WHERE ${whereSql}
    `).get(...params) as { total: number };

    const rows = this.db.raw.prepare(`
      SELECT a.* FROM assets a ${ftsJoin}
      WHERE ${whereSql}
      ORDER BY ${sort} ${direction}, a.id ASC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, (page - 1) * pageSize).map(toAsset);

    const facet = (field: string): Array<{ value: string; count: number }> => {
      const safeFields = new Set(['country', 'city', 'location_name', 'author_name']);
      if (!safeFields.has(field)) return [];
      return (this.db.raw.prepare(`
        SELECT ${field} AS value, count(*) AS count
        FROM assets
        WHERE excluded = 0 AND ${field} IS NOT NULL AND trim(${field}) <> ''
        GROUP BY ${field}
        ORDER BY count DESC, value ASC
        LIMIT 100
      `).all() as Array<{ value: string; count: number }>);
    };

    return {
      rows,
      total: countRow.total,
      page,
      pageSize,
      facets: {
        countries: facet('country'),
        cities: facet('city'),
        locations: facet('location_name'),
        authors: facet('author_name')
      }
    };
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
        sum(CASE WHEN declared_width >= 3840 AND declared_height >= 2160 THEN 1 ELSE 0 END) AS four_k_count,
        sum(CASE WHEN local_file_id IS NOT NULL THEN 1 ELSE 0 END) AS downloaded_count,
        sum(CASE WHEN verification_status = 'human_verified' THEN 1 ELSE 0 END) AS verified_count
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
        coverageScore: Math.round(coverageScore * 10) / 10
      };
    });
  }

  updateAsset(assetId: string, patch: Record<string, unknown>, reason = 'operator edit'): CatalogAsset {
    const allowedMap: Record<string, string> = {
      title: 'title',
      description: 'description',
      country: 'country',
      city: 'city',
      locationName: 'location_name',
      activity: 'activity',
      shotType: 'shot_type',
      sceneDescription: 'scene_description',
      objects: 'objects',
      timeOfDay: 'time_of_day',
      style: 'style',
      orientation: 'orientation',
      locationGranularity: 'location_granularity',
      locationConfidence: 'location_confidence',
      verificationStatus: 'verification_status',
      availabilityStatus: 'availability_status',
      excluded: 'excluded'
    };
    const current = this.db.raw.prepare('SELECT * FROM assets WHERE id = ?').get(assetId) as Record<string, unknown> | undefined;
    if (!current) throw new Error('Asset not found.');

    const changes = Object.entries(patch).filter(([key]) => allowedMap[key]);
    if (!changes.length) return toAsset(current);
    const now = new Date().toISOString();

    const transaction = this.db.raw.transaction(() => {
      const overrides = current.human_override_json
        ? JSON.parse(String(current.human_override_json)) as Record<string, unknown>
        : {};
      for (const [key, value] of changes) {
        const column = allowedMap[key];
        if (!column) continue;
        this.db.raw.prepare(`
          INSERT INTO asset_metadata_revisions(
            id, asset_id, field_name, previous_value_json, new_value_json,
            source, confidence, reason, created_at
          ) VALUES(?, ?, ?, ?, ?, 'human', 1.0, ?, ?)
        `).run(
          randomUUID(),
          assetId,
          key,
          JSON.stringify(current[column] ?? null),
          JSON.stringify(value ?? null),
          reason,
          now
        );
        this.db.raw.prepare(`UPDATE assets SET ${column} = ?, updated_at = ? WHERE id = ?`)
          .run(value === undefined ? null : value, now, assetId);
        overrides[key] = value;
      }
      this.db.raw.prepare(`
        UPDATE assets SET human_override_json = ?, updated_at = ? WHERE id = ?
      `).run(JSON.stringify(overrides), now, assetId);
    });
    transaction();

    return toAsset(this.db.raw.prepare('SELECT * FROM assets WHERE id = ?').get(assetId) as Record<string, unknown>);
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
