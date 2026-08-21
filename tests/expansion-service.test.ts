import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { XLSX } from '@shared/xlsx-node';
import { AppDatabase } from '@main/database/database';
import { CatalogService } from '@main/services/catalog-service';
import { ExpansionService, type CatalogImportRunner, type SheetValuesReader } from '@main/services/expansion-service';
import { PlaceService } from '@main/services/place-service';
import { buildDefaultSettings } from '@main/app-paths';
import type { SecretStatus } from '@shared/types';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(
  sheetRows: unknown[][] = [],
  sheet: SheetValuesReader = { getValues: async () => sheetRows }
) {
  const root = mkdtempSync(join(tmpdir(), 'videofactory-expansion-'));
  roots.push(root);
  const settings = buildDefaultSettings(join(root, 'data-root'));
  const db = new AppDatabase(join(root, 'videofactory.sqlite'));
  const places = new PlaceService(db);
  const catalog = new CatalogService(db, places);
  const secrets: SecretStatus = {
    llmApiKeyConfigured: false, visionApiKeyConfigured: false,
    researchApiKeyConfigured: false, httpTtsApiKeyConfigured: false,
    youtubeClientConfigured: false, youtubeAuthorized: false,
    youtubeApiKeyConfigured: false
  };
  const importOperations: string[] = [];
  const importRunner: CatalogImportRunner = {
    async stage(operationId, request) {
      importOperations.push(operationId);
      if (!request.rows.length) throw new Error('Google Sheets returned no rows.');
      mkdirSync(dirname(request.filePath), { recursive: true });
      const rows = request.rows.map(row => row.map(value => value === null || value === undefined ? '' : String(value)));
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), request.sheetName ?? 'Catalog');
      XLSX.writeFile(workbook, request.filePath);
      return {
        sourceSha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
        preview: catalog.previewImport(request.filePath, request.sheetName)
      };
    },
    async preview(operationId, request) {
      importOperations.push(operationId);
      return catalog.previewImport(request.filePath, request.sheetName);
    },
    cancel: () => false
  };
  const service = new ExpansionService(db, catalog, () => settings, () => secrets, importRunner, sheet);
  return { root, settings, db, catalog, service, importOperations };
}

function insertTopic(db: AppDatabase): string {
  const now = new Date().toISOString();
  db.raw.prepare(`
    INSERT INTO topic_candidates(
      id, destination_key, title, destination, angle, viewer_promise,
      keywords_json, coverage_json, opportunity_score, feasibility,
      reasons_json, raw_metrics_json, created_at
    ) VALUES('topic-1', 'paris', 'Paris visual guide', 'Paris', 'visual guide',
      'A grounded guide', '["paris"]', ?, 50, 'qualified', '[]', '{}', ?)
  `).run(JSON.stringify({
    assetCount: 20, coverageScore: 80, downloadedCount: 10,
    exactConfidenceDistribution: { verified: 8, strong: 6, contextual: 4, weak: 2 }
  }), now);
  return 'topic-1';
}

describe('expansion registry, opportunity evidence, and Sheets staging', () => {
  it('separates configured, available, and externally qualified capability state', () => {
    const value = fixture();
    const registry = value.service.registry();
    expect(registry.outputProfiles.map(profile => profile.profileKey)).toEqual([
      'landscape_1080p', 'vertical_1080p', 'landscape_4k'
    ]);
    expect(registry.providers.find(provider => provider.providerKey === 'local_ai_registry')).toMatchObject({
      configured: false, available: false, externalQualification: 'unverified'
    });
    expect(registry.providers.find(provider => provider.providerKey === 'keyword_manual')).toMatchObject({
      configured: true, available: true, externalQualification: 'not_required'
    });
    value.db.close();
  });

  it('labels Google Search as a proxy and persists explainable weighted opportunity components', () => {
    const value = fixture();
    const topicId = insertTopic(value.db);
    value.service.importKeywordMetric({
      topicCandidateId: topicId, keyword: 'paris travel', provider: 'Google Search',
      metricType: 'monthly search volume', value: 10_000, geographyCode: 'US',
      languageCode: 'en', collectedAt: '2026-08-12T12:00:00.000Z', confidence: 0.8,
      youtubeNative: false, rawMetadata: {}
    });
    value.service.importKeywordMetric({
      topicCandidateId: topicId, keyword: 'paris travel', provider: 'YouTube Data API',
      metricType: 'competition score', value: 25, geographyCode: 'US',
      languageCode: 'en', collectedAt: '2026-08-12T12:00:00.000Z', confidence: 0.9,
      youtubeNative: true, rawMetadata: { normalizedScore: 25 }
    });
    const result = value.service.opportunities()[0]!;
    expect(result.labels).toContain('Google Search proxy (monthly search volume) — not YouTube search volume');
    expect(result.components).toMatchObject({ visualCoverage: 80, lowCompetition: 75 });
    expect(result.opportunityScore).toBeGreaterThan(40);
    const stored = value.db.raw.prepare(`SELECT demand_score, competition_score, raw_metrics_json FROM topic_candidates WHERE id = ?`).get(topicId) as Record<string, unknown>;
    expect(Number(stored.demand_score)).toBeGreaterThan(0);
    expect(Number(stored.competition_score)).toBe(25);
    expect(JSON.parse(String(stored.raw_metrics_json)).metricLabels).toContain('YouTube-native competition score');
    value.db.close();
  });

  it('materializes read-only Sheet values and stages but never commits the catalog diff', async () => {
    const value = fixture([
      ['ID', 'Page', 'Title', 'Country', 'City'],
      ['1', 'https://elements.envato.com/paris-ABCDE', 'Paris', 'France', 'Paris']
    ]);
    const run = await value.service.stageGoogleSheet({
      spreadsheetId: 'spreadsheet-fixture', sheetRange: 'Catalog!A:E',
      validationTemplateId: 'envato-default', operationId: 'sheet-stage-operation'
    });
    expect(run).toMatchObject({ status: 'staged', rowCount: 1 });
    expect(run.previewId).toBeTruthy();
    expect(run.materializedPath && existsSync(run.materializedPath)).toBe(true);
    expect(value.catalog.stats().totalAssets).toBe(0);
    expect(value.db.raw.prepare(`SELECT count(*) AS count FROM catalog_imports`).get()).toEqual({ count: 0 });
    expect(value.db.raw.prepare(`SELECT status FROM catalog_import_previews WHERE id = ?`).get(run.previewId!)).toEqual({ status: 'staged' });
    expect(value.importOperations).toEqual(['sheet-stage-operation']);
    const replacement = await value.service.stagedGoogleSheetPreview(run.previewId!);
    expect(replacement.previewId).not.toBe(run.previewId);
    expect(value.service.googleSheetsRuns()[0]?.previewId).toBe(replacement.previewId);
    expect(value.db.raw.prepare(`SELECT status FROM catalog_import_previews WHERE id = ?`).get(run.previewId!)).toEqual({ status: 'superseded' });
    value.db.close();
  });

  it('records a failed bounded sync receipt without altering the catalog', async () => {
    const value = fixture([]);
    const run = await value.service.stageGoogleSheet({ spreadsheetId: 'spreadsheet-empty', sheetRange: 'Catalog!A:E' });
    expect(run.status).toBe('failed');
    expect(run.error).toContain('no rows');
    expect(value.catalog.stats().totalAssets).toBe(0);
    value.db.close();
  });

  it('cancels while the remote Sheet fetch is pending and never starts materialization', async () => {
    let resolveRows: (rows: unknown[][]) => void = () => undefined;
    const sheet: SheetValuesReader = {
      getValues: () => new Promise(resolve => { resolveRows = resolve; })
    };
    const value = fixture([], sheet);
    const pending = value.service.stageGoogleSheet({
      spreadsheetId: 'spreadsheet-cancel', sheetRange: 'Catalog!A:E', operationId: 'sheet-fetch-operation'
    });
    await Promise.resolve();
    expect(value.service.googleSheetOperationStatus()).toMatchObject({
      operationId: 'sheet-fetch-operation',
      operation: 'stage',
      state: 'running',
      phase: 'fetching_sheet'
    });
    expect(value.service.cancelGoogleSheetOperation('sheet-fetch-operation')).toBe(true);
    expect(value.service.googleSheetOperationStatus()).toMatchObject({
      operationId: 'sheet-fetch-operation',
      state: 'cancelling',
      phase: 'cancelling'
    });
    await expect(pending).rejects.toMatchObject({ name: 'CatalogImportCancelledError' });
    expect(value.service.googleSheetOperationStatus()).toBeNull();
    resolveRows([['ID'], ['1']]);
    expect(value.importOperations).toEqual([]);
    expect(value.service.googleSheetsRuns()[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('cancelled') });
    value.db.close();
  });

  it('keeps hard-rejected topics at zero regardless of demand evidence', () => {
    const value = fixture();
    const topicId = insertTopic(value.db);
    value.db.raw.prepare(`UPDATE topic_candidates SET feasibility = 'rejected' WHERE id = ?`).run(topicId);
    value.service.importKeywordMetric({
      topicCandidateId: topicId, keyword: 'paris travel', provider: 'YouTube Data API',
      metricType: 'demand score', value: 100, geographyCode: 'US', languageCode: 'en',
      collectedAt: '2026-08-12T12:00:00.000Z', confidence: 1,
      youtubeNative: true, rawMetadata: { normalizedScore: 100 }
    });
    expect(value.service.opportunities()[0]).toMatchObject({ feasibility: 'rejected', opportunityScore: 0 });
    value.db.close();
  });
});
