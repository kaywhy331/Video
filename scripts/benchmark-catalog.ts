import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, platform, arch, release, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { XLSX } from '@shared/xlsx-node';
import { AppDatabase } from '@main/database/database';
import { CatalogService } from '@main/services/catalog-service';
import { PlaceService } from '@main/services/place-service';
import type { CatalogSearchRequest } from '@shared/types';

const ROW_COUNT = 26_000;
const SEARCH_ROUNDS = 25;
const SEARCH_P95_TARGET_MS = 300;
const PAGE_SIZE = 50;

const countries = ['France', 'Italy', 'Japan', 'Mexico', 'Morocco', 'Portugal', 'Thailand', 'Vietnam'];
const cities = ['Paris', 'Rome', 'Kyoto', 'Oaxaca', 'Marrakesh', 'Lisbon', 'Chiang Mai', 'Da Nang'];
const locations = ['Temple District', 'Old Quarter', 'Central Market', 'Riverside', 'Historic Citadel', 'Coastal Promenade'];
const activities = ['Walking', 'Architecture', 'Street food', 'Aerial viewing', 'Museum visit'];
const shots = ['Wide', 'Medium', 'Detail', 'Aerial Wide'];
const objects = ['Temple', 'Market stalls', 'Historic buildings', 'River', 'Public square'];

function rounded(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function percentile(values: number[], percentileValue: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(percentileValue * sorted.length) - 1);
  return sorted[index] ?? sorted[sorted.length - 1] ?? 0;
}

function duration<T>(operation: () => T): { value: T; elapsedMs: number } {
  const started = performance.now();
  const value = operation();
  return { value, elapsedMs: performance.now() - started };
}

function fixtureRows(): Array<Record<string, string | number>> {
  return Array.from({ length: ROW_COUNT }, (_, index) => {
    const countryIndex = index % countries.length;
    const location = locations[index % locations.length] ?? 'Central District';
    const activity = activities[index % activities.length] ?? 'Walking';
    const shot = shots[index % shots.length] ?? 'Wide';
    const object = objects[index % objects.length] ?? 'Historic buildings';
    const assetCode = `VF${String(index + 1).padStart(7, '0')}`;
    return {
      ID: index + 1,
      Page: `https://elements.envato.com/catalog-benchmark-${index + 1}-${assetCode}`,
      Author: `Benchmark Author ${index % 40}`,
      Attributes: 'travel; documentary; catalog benchmark',
      'Item Tags': `${countries[countryIndex]}, ${cities[countryIndex]}, ${location}, ${activity}, ${object}`,
      Title: `${cities[countryIndex]} ${location} ${activity} ${shot} travel footage ${index + 1}`,
      Description: `Benchmark footage showing ${activity.toLowerCase()} around ${location.toLowerCase()}.`,
      Country: countries[countryIndex] ?? 'France',
      City: cities[countryIndex] ?? 'Paris',
      Location: location,
      Activity: activity,
      Shot: shot,
      Scene: `${shot} view of ${location}`,
      Object: object,
      'Time of Day': index % 2 ? 'Daytime' : 'Golden hour',
      Style: index % 3 ? 'Cinematic' : 'Documentary',
      Length: `00:00:${String(8 + (index % 22)).padStart(2, '0')}`,
      Resolution: index % 5 ? '1920 x 1080' : '3840 x 2160',
      'File Size': `${80 + (index % 240)} MB`,
      'Frame Rate': index % 3 ? 30 : 29.97,
      'Alpha Channel': 'No',
      Looped: 'No',
      'Video Encoding': 'H.264',
      Orientation: index % 10 ? 'Landscape' : 'Portrait'
    };
  });
}

function outputPath(): string {
  const outputIndex = process.argv.indexOf('--output');
  const supplied = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
  return resolve(supplied || 'VALIDATION_CATALOG_PERFORMANCE.json');
}

function main(): void {
  const root = mkdtempSync(join(tmpdir(), 'videofactory-catalog-benchmark-'));
  const workbookPath = join(root, 'catalog-26000.xlsx');
  const databasePath = join(root, 'videofactory.sqlite');
  let database: AppDatabase | null = null;

  try {
    const generated = duration(() => {
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(fixtureRows()), 'Catalog');
      const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true });
      writeFileSync(workbookPath, bytes);
    });

    database = new AppDatabase(databasePath);
    let catalog = new CatalogService(database, new PlaceService(database));
    const preview = duration(() => catalog.previewImport(workbookPath));
    if (preview.value.rowCount !== ROW_COUNT || preview.value.diff.inserted !== ROW_COUNT) {
      throw new Error(`Expected ${ROW_COUNT} staged inserts, received ${preview.value.rowCount} rows and ${preview.value.diff.inserted} inserts.`);
    }
    const committed = duration(() => catalog.commitImport(
      workbookPath,
      preview.value.selectedSheet,
      preview.value.mapping,
      preview.value.previewId
    ));
    const integrity = database.integrityCheck();
    database.close();
    database = null;

    const reopened = duration(() => new AppDatabase(databasePath));
    database = reopened.value;
    catalog = new CatalogService(database, new PlaceService(database));
    const stats = catalog.stats();
    const scenarios: Array<{ name: string; request: CatalogSearchRequest }> = [
      { name: 'recent-page', request: { page: 1, pageSize: PAGE_SIZE, sortBy: 'updated', sortDirection: 'desc' } },
      { name: 'fts-location-activity', request: { query: 'Temple Walking', page: 1, pageSize: PAGE_SIZE, sortBy: 'title', sortDirection: 'asc' } },
      { name: 'country-city', request: { country: 'France', city: 'Paris', page: 1, pageSize: PAGE_SIZE, sortBy: 'location', sortDirection: 'asc' } },
      { name: 'orientation-country', request: { country: 'Japan', orientation: 'landscape', page: 1, pageSize: PAGE_SIZE, sortBy: 'title', sortDirection: 'asc' } },
      { name: 'metadata-contains', request: { metadataField: 'objects', metadataValue: 'Historic', page: 1, pageSize: PAGE_SIZE, sortBy: 'updated', sortDirection: 'desc' } }
    ];

    for (const scenario of scenarios) catalog.search(scenario.request);
    const allSamples: number[] = [];
    const searchScenarios = scenarios.map(scenario => {
      const samples: number[] = [];
      let lastResult = catalog.search(scenario.request);
      for (let round = 0; round < SEARCH_ROUNDS; round += 1) {
        const measured = duration(() => catalog.search(scenario.request));
        lastResult = measured.value;
        samples.push(measured.elapsedMs);
        allSamples.push(measured.elapsedMs);
      }
      return {
        name: scenario.name,
        samples: samples.length,
        resultCount: lastResult.total,
        returnedRows: lastResult.rows.length,
        medianMs: rounded(percentile(samples, 0.5)),
        p95Ms: rounded(percentile(samples, 0.95)),
        maxMs: rounded(Math.max(...samples))
      };
    });
    const boundedPage = catalog.search({ page: 1, pageSize: PAGE_SIZE });
    const overallP95 = percentile(allSamples, 0.95);
    const rowCountPassed = committed.value.total === ROW_COUNT && stats.totalAssets === ROW_COUNT;
    const searchPassed = overallP95 < SEARCH_P95_TARGET_MS
      && searchScenarios.every(scenario => scenario.p95Ms < SEARCH_P95_TARGET_MS);
    const boundedPagePassed = boundedPage.total === ROW_COUNT && boundedPage.rows.length <= PAGE_SIZE;
    const receipt = {
      generatedAt: new Date().toISOString(),
      benchmark: 'VideoFactory catalog 26K local qualification',
      environment: {
        platform: platform(),
        release: release(),
        architecture: arch(),
        node: process.version,
        cpuModel: cpus()[0]?.model ?? 'unknown',
        logicalCpuCount: cpus().length,
        totalMemoryBytes: totalmem()
      },
      fixture: {
        rows: ROW_COUNT,
        xlsxBytes: statSync(workbookPath).size,
        generationMs: rounded(generated.elapsedMs)
      },
      import: {
        previewMs: rounded(preview.elapsedMs),
        commitMs: rounded(committed.elapsedMs),
        totalMs: rounded(preview.elapsedMs + committed.elapsedMs),
        stagedRows: preview.value.rowCount,
        committedRows: committed.value.total,
        canonicalAssets: stats.totalAssets,
        integrity
      },
      warmDatabase: {
        reopenMs: rounded(reopened.elapsedMs),
        searchRoundsPerScenario: SEARCH_ROUNDS,
        searchTargetP95Ms: SEARCH_P95_TARGET_MS,
        overallP95Ms: rounded(overallP95),
        scenarios: searchScenarios
      },
      rendererContract: {
        catalogAssets: boundedPage.total,
        requestedPageSize: PAGE_SIZE,
        returnedRows: boundedPage.rows.length,
        rendersEntireCatalog: boundedPage.rows.length === boundedPage.total
      },
      acceptance: {
        catalogImportCountAndIntegrity: rowCountPassed ? 'passed' : 'failed',
        warmCommonSearchP95: searchPassed ? 'passed' : 'failed',
        boundedRendererPage: boundedPagePassed ? 'passed' : 'failed',
        xlsxImportUiResponsiveness: 'not_measured_by_headless_service_benchmark',
        dashboardStartupUnderFiveSeconds: 'not_measured_by_catalog_service_benchmark',
        backgroundRenderResponsiveness: 'not_measured_by_catalog_service_benchmark'
      },
      measuredCriteriaPassed: rowCountPassed && searchPassed && boundedPagePassed,
      fullUiPerformanceQualification: false
    };

    writeFileSync(outputPath(), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    if (!receipt.measuredCriteriaPassed) process.exitCode = 1;
  } finally {
    database?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

main();
