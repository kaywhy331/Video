import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { XLSX } from '@shared/xlsx-node';
import { AppDatabase } from '@main/database/database';
import { CatalogImportWorkerService } from '@main/services/catalog-import-worker-service';
import type { CatalogImportPreview, CatalogImportResult, ProgressEvent } from '@shared/types';

const ROW_COUNT = Number(process.env.CATALOG_RESPONSIVENESS_ROWS ?? 26_000);
const HEARTBEAT_INTERVAL_MS = 20;
const MAX_EVENT_LOOP_P99_GAP_MS = 250;
const MAX_PING_P99_LATENCY_MS = 50;

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

function fixtureRows(): Array<Record<string, string | number>> {
  return Array.from({ length: ROW_COUNT }, (_, index) => {
    const group = index % countries.length;
    const location = locations[index % locations.length] ?? 'Central District';
    const activity = activities[index % activities.length] ?? 'Walking';
    const shot = shots[index % shots.length] ?? 'Wide';
    const object = objects[index % objects.length] ?? 'Historic buildings';
    const assetCode = `VF${String(index + 1).padStart(7, '0')}`;
    return {
      ID: index + 1,
      Page: `https://elements.envato.com/responsiveness-${index + 1}-${assetCode}`,
      Author: `Responsiveness Author ${index % 40}`,
      Attributes: 'travel; documentary; responsiveness qualification',
      'Item Tags': `${countries[group]}, ${cities[group]}, ${location}, ${activity}, ${object}`,
      Title: `${cities[group]} ${location} ${activity} ${shot} travel footage ${index + 1}`,
      Description: `Qualification footage showing ${activity.toLowerCase()} around ${location.toLowerCase()}.`,
      Country: countries[group] ?? 'France',
      City: cities[group] ?? 'Paris',
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

interface ResponsivenessMeasurement<T> {
  value: T;
  elapsedMs: number;
  heartbeatCount: number;
  activePingCount: number;
  eventLoopGapP95Ms: number;
  eventLoopGapP99Ms: number;
  eventLoopGapMaxMs: number;
  pingLatencyP95Ms: number;
  pingLatencyP99Ms: number;
  pingLatencyMaxMs: number;
}

async function measure<T>(
  runner: CatalogImportWorkerService,
  operation: () => Promise<T>
): Promise<ResponsivenessMeasurement<T>> {
  const gaps: number[] = [];
  const pingLatencies: number[] = [];
  let activePingCount = 0;
  let lastBeat = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    gaps.push(now - lastBeat);
    lastBeat = now;
    const pingStarted = performance.now();
    const ping = runner.ping();
    pingLatencies.push(performance.now() - pingStarted);
    if (ping.activeOperation) activePingCount += 1;
  }, HEARTBEAT_INTERVAL_MS);
  const started = performance.now();
  try {
    const value = await operation();
    return {
      value,
      elapsedMs: performance.now() - started,
      heartbeatCount: gaps.length,
      activePingCount,
      eventLoopGapP95Ms: percentile(gaps, 0.95),
      eventLoopGapP99Ms: percentile(gaps, 0.99),
      eventLoopGapMaxMs: Math.max(0, ...gaps),
      pingLatencyP95Ms: percentile(pingLatencies, 0.95),
      pingLatencyP99Ms: percentile(pingLatencies, 0.99),
      pingLatencyMaxMs: Math.max(0, ...pingLatencies)
    };
  } finally {
    clearInterval(timer);
  }
}

function outputPath(): string {
  const outputIndex = process.argv.indexOf('--output');
  return resolve(outputIndex >= 0 && process.argv[outputIndex + 1]
    ? process.argv[outputIndex + 1]!
    : 'VALIDATION_CATALOG_RESPONSIVENESS.json');
}

async function main(): Promise<void> {
  if (!Number.isInteger(ROW_COUNT) || ROW_COUNT < 100 || ROW_COUNT > 100_000) {
    throw new Error('CATALOG_RESPONSIVENESS_ROWS must be an integer between 100 and 100000.');
  }
  const workerPath = resolve('out/main/catalog-import-worker.js');
  if (!existsSync(workerPath)) throw new Error('Build the catalog import worker before running this harness.');
  const root = mkdtempSync(join(tmpdir(), 'videofactory-catalog-responsive-'));
  const workbookPath = join(root, `catalog-${ROW_COUNT}.xlsx`);
  const stagedWorkbookPath = join(root, `catalog-sheets-stage-${ROW_COUNT}.xlsx`);
  const cancelledWorkbookPath = join(root, `catalog-sheets-cancel-${ROW_COUNT}.xlsx`);
  const databasePath = join(root, 'videofactory.sqlite');
  let database: AppDatabase | null = null;
  let runner: CatalogImportWorkerService | null = null;

  try {
    const generationStarted = performance.now();
    const records = fixtureRows();
    const columns = Object.keys(records[0] ?? {});
    const sheetRows: unknown[][] = [columns, ...records.map(record => columns.map(column => record[column]))];
    {
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(records), 'Catalog');
      writeFileSync(workbookPath, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true }));
    }
    records.length = 0;
    const generationMs = performance.now() - generationStarted;

    database = new AppDatabase(databasePath);
    const progressEvents: ProgressEvent[] = [];
    runner = new CatalogImportWorkerService(databasePath, event => progressEvents.push(event), workerPath);
    const sheetsStage = await measure(runner, () => runner!.stage('responsive-sheets-stage', {
      filePath: stagedWorkbookPath,
      rows: sheetRows,
      sheetName: 'Catalog'
    }));
    if (sheetsStage.value.preview.rowCount !== ROW_COUNT || sheetsStage.value.preview.diff.inserted !== ROW_COUNT) {
      throw new Error(`Expected ${ROW_COUNT} Google Sheets staged inserts, received ${sheetsStage.value.preview.rowCount}/${sheetsStage.value.preview.diff.inserted}.`);
    }
    const preview = await measure(runner, () => runner!.preview('responsive-preview', { filePath: workbookPath }));
    const staged = preview.value as CatalogImportPreview;
    if (staged.rowCount !== ROW_COUNT || staged.diff.inserted !== ROW_COUNT) {
      throw new Error(`Expected ${ROW_COUNT} staged inserts, received ${staged.rowCount}/${staged.diff.inserted}.`);
    }
    const commit = await measure(runner, () => runner!.commit('responsive-commit', {
      filePath: workbookPath,
      sheetName: staged.selectedSheet,
      mapping: staged.mapping,
      previewId: staged.previewId
    }));
    const committed = commit.value as CatalogImportResult;

    let cancellation = { requested: false, observed: false, managedOutputRemoved: true, elapsedMs: 0, message: '' };
    if (ROW_COUNT >= 5_000) {
      const cancelStarted = performance.now();
      const cancelledStage = runner.stage('responsive-cancel', {
        filePath: cancelledWorkbookPath,
        rows: sheetRows,
        sheetName: 'Catalog'
      });
      const cancelTimer = setTimeout(() => {
        cancellation.requested = runner?.cancel('responsive-cancel') ?? false;
      }, 25);
      try {
        await cancelledStage;
      } catch (error) {
        cancellation.observed = error instanceof Error && error.name === 'CatalogImportCancelledError';
        cancellation.message = error instanceof Error ? error.message : String(error);
      } finally {
        clearTimeout(cancelTimer);
        cancellation.elapsedMs = performance.now() - cancelStarted;
        cancellation.managedOutputRemoved = !existsSync(cancelledWorkbookPath);
      }
    }

    const integrity = database.integrityCheck();
    const assetCount = Number((database.raw.prepare('SELECT count(*) AS count FROM assets').get() as { count: number }).count);
    const sheetsStageResponsive = sheetsStage.activePingCount > 0
      && sheetsStage.eventLoopGapP99Ms < MAX_EVENT_LOOP_P99_GAP_MS
      && sheetsStage.pingLatencyP99Ms < MAX_PING_P99_LATENCY_MS;
    const previewResponsive = preview.activePingCount > 0
      && preview.eventLoopGapP99Ms < MAX_EVENT_LOOP_P99_GAP_MS
      && preview.pingLatencyP99Ms < MAX_PING_P99_LATENCY_MS;
    const commitResponsive = commit.activePingCount > 0
      && commit.eventLoopGapP99Ms < MAX_EVENT_LOOP_P99_GAP_MS
      && commit.pingLatencyP99Ms < MAX_PING_P99_LATENCY_MS;
    const cancellationPassed = ROW_COUNT < 5_000
      || (cancellation.requested && cancellation.observed && cancellation.managedOutputRemoved);
    const receipt = {
      generatedAt: new Date().toISOString(),
      benchmark: 'VideoFactory catalog main-process responsiveness qualification',
      environment: {
        platform: platform(), release: release(), architecture: arch(), node: process.version,
        cpuModel: cpus()[0]?.model ?? 'unknown', logicalCpuCount: cpus().length,
        totalMemoryBytes: totalmem()
      },
      fixture: {
        rows: ROW_COUNT,
        xlsxBytes: statSync(workbookPath).size,
        generationMs: rounded(generationMs)
      },
      heartbeat: {
        intervalMs: HEARTBEAT_INTERVAL_MS,
        acceptedPercentile: 0.99,
        maximumAcceptedP99GapMs: MAX_EVENT_LOOP_P99_GAP_MS,
        maximumAcceptedP99PingLatencyMs: MAX_PING_P99_LATENCY_MS,
        endpoint: 'catalog:ping'
      },
      sheetsStage: {
        elapsedMs: rounded(sheetsStage.elapsedMs), heartbeatCount: sheetsStage.heartbeatCount,
        activePingCount: sheetsStage.activePingCount,
        eventLoopGapP95Ms: rounded(sheetsStage.eventLoopGapP95Ms),
        eventLoopGapP99Ms: rounded(sheetsStage.eventLoopGapP99Ms),
        eventLoopGapMaxMs: rounded(sheetsStage.eventLoopGapMaxMs),
        pingLatencyP95Ms: rounded(sheetsStage.pingLatencyP95Ms),
        pingLatencyP99Ms: rounded(sheetsStage.pingLatencyP99Ms),
        pingLatencyMaxMs: rounded(sheetsStage.pingLatencyMaxMs),
        stagedRows: sheetsStage.value.preview.rowCount,
        progressEvents: progressEvents.filter(event => event.jobId === 'responsive-sheets-stage').length
      },
      preview: {
        elapsedMs: rounded(preview.elapsedMs), heartbeatCount: preview.heartbeatCount,
        activePingCount: preview.activePingCount,
        eventLoopGapP95Ms: rounded(preview.eventLoopGapP95Ms),
        eventLoopGapP99Ms: rounded(preview.eventLoopGapP99Ms),
        eventLoopGapMaxMs: rounded(preview.eventLoopGapMaxMs),
        pingLatencyP95Ms: rounded(preview.pingLatencyP95Ms),
        pingLatencyP99Ms: rounded(preview.pingLatencyP99Ms),
        pingLatencyMaxMs: rounded(preview.pingLatencyMaxMs)
      },
      commit: {
        elapsedMs: rounded(commit.elapsedMs), heartbeatCount: commit.heartbeatCount,
        activePingCount: commit.activePingCount,
        eventLoopGapP95Ms: rounded(commit.eventLoopGapP95Ms),
        eventLoopGapP99Ms: rounded(commit.eventLoopGapP99Ms),
        eventLoopGapMaxMs: rounded(commit.eventLoopGapMaxMs),
        pingLatencyP95Ms: rounded(commit.pingLatencyP95Ms),
        pingLatencyP99Ms: rounded(commit.pingLatencyP99Ms),
        pingLatencyMaxMs: rounded(commit.pingLatencyMaxMs),
        committedRows: committed.total,
        progressEvents: progressEvents.filter(event => event.jobId === 'responsive-commit').length
      },
      cancellation,
      database: { assetCount, integrity },
      acceptance: {
        googleSheetsStageMainProcessResponsive: sheetsStageResponsive ? 'passed' : 'failed',
        previewMainProcessResponsive: previewResponsive ? 'passed' : 'failed',
        commitMainProcessResponsive: commitResponsive ? 'passed' : 'failed',
        progressReported: progressEvents.length > 4 ? 'passed' : 'failed',
        cancellationAffordance: cancellationPassed ? 'passed' : 'failed',
        catalogCountAndIntegrity: assetCount === ROW_COUNT && integrity === 'ok' ? 'passed' : 'failed'
      },
      measuredCriteriaPassed: sheetsStageResponsive && previewResponsive && commitResponsive
        && progressEvents.length > 4
        && cancellationPassed
        && assetCount === ROW_COUNT
        && integrity === 'ok'
    };
    writeFileSync(outputPath(), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    if (!receipt.measuredCriteriaPassed) process.exitCode = 1;
  } finally {
    await runner?.shutdown();
    database?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
