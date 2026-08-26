import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { performance as nodePerformance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import ffmpegPath from 'ffmpeg-static';
import * as XLSX from 'xlsx';
import type { ValidationSource } from '../../scripts/validation-source.mjs';
import {
  ELECTRON_PERFORMANCE_SCHEMA_VERSION,
  assessElectronPerformanceEvidence,
  type ElectronPerformanceEvidenceInput,
  type ElectronPerformanceMode
} from '../../scripts/electron-performance-evidence.mjs';
import {
  FFMPEG_BACKGROUND_RESOURCE_POLICY,
  backgroundFfmpegGlobalArguments,
  backgroundFfmpegThreadCount,
  backgroundFfmpegVideoArguments
} from '@shared/ffmpeg-resource-policy';

test.describe.configure({ mode: 'serial' });

const mode = requiredEnvironment('VIDEOFACTORY_PERFORMANCE_MODE') as ElectronPerformanceMode;
const requestedRows = Number(requiredEnvironment('VIDEOFACTORY_PERFORMANCE_ROWS'));
const outputPath = resolve(requiredEnvironment('VIDEOFACTORY_PERFORMANCE_OUTPUT'));
const source = JSON.parse(requiredEnvironment('VIDEOFACTORY_PERFORMANCE_SOURCE')) as ValidationSource;
const deviceClass = process.env.VIDEOFACTORY_PERFORMANCE_DEVICE_CLASS?.trim() || null;
const ci = process.env.VIDEOFACTORY_PERFORMANCE_CI === 'true';
const navigationViews = [
  { label: 'Settings', heading: 'Keep media local' },
  { label: 'Exceptions', heading: 'Review only the problems' },
  { label: 'Autopilot', heading: 'Produce the next accurate video' },
  { label: 'Library', heading: 'Ground every production decision' }
];
const searchQueries = ['Paris Architecture', 'Kyoto Walking', 'Rome Street food', 'Oaxaca Museum', 'Lisbon Aerial'];

interface RendererQualificationState {
  heartbeatGapsMs: number[];
  progressEvents: number;
  lastHeartbeatAt: number;
  pendingOperation?: Promise<unknown>;
}

test('records fail-closed production Electron performance evidence', async () => {
  if (!ffmpegPath) throw new Error('ffmpeg-static did not provide a qualification binary.');
  if (!Number.isSafeInteger(requestedRows) || requestedRows < 100) throw new Error('Invalid qualification row count.');

  const dataRoot = mkdtempSync(join(tmpdir(), 'videofactory-electron-performance-'));
  const workbookPath = join(dataRoot, `catalog-${requestedRows}.xlsx`);
  const databasePath = join(dataRoot, 'data', 'videofactory.sqlite');
  let application: ElectronApplication | null = null;
  let background: ChildProcessWithoutNullStreams | null = null;

  try {
    const workbookBytes = generateWorkbook(workbookPath, requestedRows);
    const workbookSha256 = createHash('sha256').update(workbookBytes).digest('hex');

    const initialLaunch = await launchApplication(dataRoot);
    application = initialLaunch.application;
    let page = initialLaunch.page;
    await installRendererInstrumentation(page);

    await resetHeartbeat(page);
    const previewOperationId = `performance-preview-${Date.now()}`;
    await startPreview(page, workbookPath, previewOperationId);
    const previewActive = await waitForOperation(page, previewOperationId);
    const previewNavigation = await measureNavigation(page, previewOperationId);
    const preview = await finishPendingOperation(page) as {
      rowCount: number;
      selectedSheet: string;
      mapping: Record<string, string | null>;
      previewId: string;
      diff: { inserted: number };
    };
    const previewHeartbeat = await takeHeartbeat(page);

    await resetHeartbeat(page);
    const commitOperationId = `performance-commit-${Date.now()}`;
    await startCommit(page, workbookPath, commitOperationId, preview);
    const commitActive = await waitForOperation(page, commitOperationId);
    const commitNavigation = await measureNavigation(page, commitOperationId);
    const committed = await finishPendingOperation(page) as { total: number };
    const commitHeartbeat = await takeHeartbeat(page);
    const progressEvents = await page.evaluate(() => (
      window as unknown as { __videoFactoryPerformance: RendererQualificationState }
    ).__videoFactoryPerformance.progressEvents);
    const importedStats = await page.evaluate(() => window.videoFactory.catalog.stats());

    await application.close();
    application = null;
    const integrity = databaseIntegrity(databasePath);

    const measuredLaunch = await launchApplication(dataRoot);
    application = measuredLaunch.application;
    page = measuredLaunch.page;
    const electronVersion = await application.evaluate(() => process.versions.electron ?? 'unknown');
    await installRendererInstrumentation(page);
    await openView(page, 'Library');
    await expect(page.getByText(`${requestedRows.toLocaleString()} matching assets`, { exact: true })).toBeVisible();
    await expect(page.locator('.catalog-table tbody tr')).toHaveCount(Math.min(50, requestedRows));

    const catalogSearchSamples = await measureCatalogSearch(page, searchQueries);
    const catalogUiSamples = await measureCatalogUiInteraction(page, ['Kyoto', 'Paris', 'Rome']);
    const scrollFrameSamples = await measureScrollFrames(page);
    const catalogDomRows = await page.locator('.catalog-table tbody tr').count();
    const catalogMemory = await rendererWorkingSetKb(application);

    let ffmpegOutput = '';
    const logicalCpuCount = cpus().length;
    const backgroundThreadCount = backgroundFfmpegThreadCount(logicalCpuCount);
    const backgroundStartedAt = nodePerformance.now();
    const ffmpeg = spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'info', '-stats',
      ...backgroundFfmpegGlobalArguments(logicalCpuCount),
      '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30',
      '-t', '300', '-an', '-c:v', 'libx264',
      ...backgroundFfmpegVideoArguments(logicalCpuCount),
      '-preset', 'veryfast', '-f', 'null', '-'
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    ffmpeg.stdin.end();
    background = ffmpeg;
    ffmpeg.stdout.on('data', chunk => { ffmpegOutput = boundedOutput(ffmpegOutput, chunk); });
    ffmpeg.stderr.on('data', chunk => { ffmpegOutput = boundedOutput(ffmpegOutput, chunk); });
    const observedFrameProgress = await waitForFfmpegProgress(() => ffmpegOutput, ffmpeg);
    const observedRunning = ffmpeg.exitCode === null;

    await resetHeartbeat(page);
    const backgroundNavigation = await measureNavigation(page);
    const backgroundSearch = await measureCatalogSearch(page, [...searchQueries].reverse());
    await page.waitForTimeout(1_000);
    const backgroundHeartbeat = await takeHeartbeat(page);
    const backgroundMemory = await rendererWorkingSetKb(application);
    const backgroundElapsedMs = nodePerformance.now() - backgroundStartedAt;
    await stopChild(ffmpeg);
    background = null;

    const input: ElectronPerformanceEvidenceInput = {
      schemaVersion: ELECTRON_PERFORMANCE_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      harness: 'videofactory-electron-performance',
      mode,
      source,
      environment: {
        platform: platform(), release: release(), architecture: arch(), node: process.version,
        electron: electronVersion, cpuModel: cpus()[0]?.model ?? 'unknown',
        logicalCpuCount, totalMemoryBytes: totalmem(), ci,
        productionBuild: true, deviceClass
      },
      fixture: {
        requestedRows,
        xlsxSha256: workbookSha256,
        xlsxBytes: statSync(workbookPath).size
      },
      measurements: {
        import: {
          previewRows: preview.rowCount,
          insertedRows: preview.diff.inserted,
          committedRows: committed.total,
          catalogRows: importedStats.totalAssets,
          integrity,
          progressEvents,
          previewObservedActive: previewActive || previewNavigation.observedActive,
          commitObservedActive: commitActive || commitNavigation.observedActive,
          previewHeartbeatGapsMs: previewHeartbeat,
          commitHeartbeatGapsMs: commitHeartbeat,
          previewNavigationSamplesMs: previewNavigation.samples,
          commitNavigationSamplesMs: commitNavigation.samples
        },
        startup: {
          usableMs: measuredLaunch.usableMs,
          electronLaunchMs: measuredLaunch.electronLaunchMs,
          rendererReadyMs: measuredLaunch.rendererReadyMs
        },
        catalog: {
          totalRows: importedStats.totalAssets,
          domRows: catalogDomRows,
          searchSamplesMs: catalogSearchSamples,
          uiInteractionSamplesMs: catalogUiSamples,
          scrollFrameSamplesMs: scrollFrameSamples,
          rendererWorkingSetKb: catalogMemory
        },
        backgroundRender: {
          engine: 'ffmpeg-static/libx264',
          workload: 'draft-1080p30-veryfast',
          resourcePolicy: FFMPEG_BACKGROUND_RESOURCE_POLICY,
          threadCount: backgroundThreadCount,
          observedRunning,
          observedFrameProgress,
          elapsedMs: backgroundElapsedMs,
          heartbeatGapsMs: backgroundHeartbeat,
          navigationSamplesMs: backgroundNavigation.samples,
          searchSamplesMs: backgroundSearch,
          rendererWorkingSetKb: backgroundMemory
        }
      }
    };
    const receipt = assessElectronPerformanceEvidence(input);
    mkdirSync(resolve(outputPath, '..'), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    expect(receipt.smokeCriteriaPassed, JSON.stringify(receipt.derived, null, 2)).toBe(true);
    if (mode === 'qualification') expect(receipt.externalQualificationPassed).toBe(true);
  } finally {
    if (background) await stopChild(background);
    await application?.close().catch(() => undefined);
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

async function launchApplication(dataRoot: string): Promise<{
  application: ElectronApplication;
  page: Page;
  usableMs: number;
  electronLaunchMs: number;
  rendererReadyMs: number;
}> {
  const startedAt = nodePerformance.now();
  const application = await electron.launch({
    args: [
      'out/main/index.js',
      '--no-sandbox',
      `--user-data-dir=${join(dataRoot, 'electron-user-data')}`
    ],
    env: {
      ...process.env,
      VIDEOFACTORY_DEV_DATA_ROOT: dataRoot,
      XDG_CONFIG_HOME: join(dataRoot, 'xdg-config'),
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
    }
  });
  const electronLaunchMs = nodePerformance.now() - startedAt;
  const page = application.windows()[0] ?? await application.firstWindow();
  await page.getByRole('heading', { name: /Produce the next accurate video/i }).waitFor();
  await expect.poll(() => application.evaluate(({ BrowserWindow }) => (
    BrowserWindow.getAllWindows()[0]?.isVisible() ?? false
  )), { message: 'The usable dashboard must be in a visible OS window.' }).toBe(true);
  const usableMs = nodePerformance.now() - startedAt;
  return {
    application,
    page,
    usableMs,
    electronLaunchMs,
    rendererReadyMs: usableMs - electronLaunchMs
  };
}

async function installRendererInstrumentation(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state: RendererQualificationState = {
      heartbeatGapsMs: [],
      progressEvents: 0,
      lastHeartbeatAt: window.performance.now()
    };
    window.videoFactory.app.onProgress(() => { state.progressEvents += 1; });
    setInterval(() => {
      const now = window.performance.now();
      state.heartbeatGapsMs.push(now - state.lastHeartbeatAt);
      state.lastHeartbeatAt = now;
      if (state.heartbeatGapsMs.length > 100_000) state.heartbeatGapsMs.splice(0, 50_000);
    }, 20);
    (window as unknown as { __videoFactoryPerformance: RendererQualificationState }).__videoFactoryPerformance = state;
  });
}

async function resetHeartbeat(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = (window as unknown as { __videoFactoryPerformance: RendererQualificationState }).__videoFactoryPerformance;
    state.heartbeatGapsMs = [];
    state.lastHeartbeatAt = window.performance.now();
  });
}

async function takeHeartbeat(page: Page): Promise<number[]> {
  return page.evaluate(() => (
    window as unknown as { __videoFactoryPerformance: RendererQualificationState }
  ).__videoFactoryPerformance.heartbeatGapsMs.slice());
}

async function startPreview(page: Page, filePath: string, operationId: string): Promise<void> {
  await page.evaluate(({ filePath, operationId }) => {
    const state = (window as unknown as { __videoFactoryPerformance: RendererQualificationState }).__videoFactoryPerformance;
    state.pendingOperation = window.videoFactory.catalog.previewImport({ filePath, operationId });
  }, { filePath, operationId });
}

async function startCommit(
  page: Page,
  filePath: string,
  operationId: string,
  preview: { selectedSheet: string; mapping: Record<string, string | null>; previewId: string }
): Promise<void> {
  await page.evaluate(({ filePath, operationId, preview }) => {
    const state = (window as unknown as { __videoFactoryPerformance: RendererQualificationState }).__videoFactoryPerformance;
    state.pendingOperation = window.videoFactory.catalog.commitImport({
      filePath,
      operationId,
      sheetName: preview.selectedSheet,
      mapping: preview.mapping,
      previewId: preview.previewId
    });
  }, { filePath, operationId, preview });
}

async function finishPendingOperation(page: Page): Promise<unknown> {
  return page.evaluate(async () => {
    const state = (window as unknown as { __videoFactoryPerformance: RendererQualificationState }).__videoFactoryPerformance;
    const pending = state.pendingOperation;
    if (!pending) throw new Error('Qualification operation was not started.');
    return pending;
  });
}

async function waitForOperation(page: Page, operationId: string): Promise<boolean> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const active = await page.evaluate(async id => (await window.videoFactory.catalog.importStatus())?.operationId === id, operationId);
    if (active) return true;
    await page.waitForTimeout(25);
  }
  return false;
}

async function measureNavigation(page: Page, operationId?: string): Promise<{ samples: number[]; observedActive: boolean }> {
  const samples: number[] = [];
  let observedActive = false;
  for (const view of navigationViews) {
    if (operationId) {
      observedActive ||= await page.evaluate(async id => (await window.videoFactory.catalog.importStatus())?.operationId === id, operationId);
    }
    samples.push(await page.evaluate(async ({ label, heading }) => {
      const button = [...document.querySelectorAll('nav button')].find(candidate =>
        candidate.textContent?.trim().startsWith(label)
      );
      if (!(button instanceof HTMLButtonElement)) throw new Error(`Navigation button is missing: ${label}`);
      const startedAt = window.performance.now();
      button.click();
      const deadline = startedAt + 10_000;
      while (window.performance.now() < deadline) {
        const paintedHeading = [...document.querySelectorAll('main h1')].some(candidate =>
          candidate.textContent?.includes(heading)
        );
        if (button.classList.contains('nav-active') && paintedHeading) {
          await new Promise<void>(resolveFrame => requestAnimationFrame(() => resolveFrame()));
          await new Promise<void>(resolveFrame => requestAnimationFrame(() => resolveFrame()));
          return window.performance.now() - startedAt;
        }
        await new Promise<void>(resolveFrame => requestAnimationFrame(() => resolveFrame()));
      }
      throw new Error(`Navigation did not paint the ${label} view within 10 seconds.`);
    }, view));
  }
  return { samples, observedActive };
}

async function openView(page: Page, view: string): Promise<void> {
  const button = page.getByRole('button', { name: new RegExp(`^${view}`) }).first();
  await button.click();
  await expect(button).toHaveClass(/nav-active/);
}

async function measureCatalogSearch(page: Page, queries: string[]): Promise<number[]> {
  await page.evaluate(async values => {
    for (const query of values) {
      await window.videoFactory.catalog.search({ query, page: 1, pageSize: 50 });
    }
  }, queries);
  return page.evaluate(async values => {
    const samples: number[] = [];
    for (const query of values) {
      const startedAt = window.performance.now();
      const result = await window.videoFactory.catalog.search({ query, page: 1, pageSize: 50 });
      if (result.total <= 0 || result.rows.length === 0) throw new Error(`Qualification search returned no rows: ${query}`);
      samples.push(window.performance.now() - startedAt);
    }
    return samples;
  }, queries);
}

async function measureCatalogUiInteraction(page: Page, queries: string[]): Promise<number[]> {
  await openView(page, 'Library');
  const input = page.getByLabel('Search catalog');
  const firstRow = page.locator('.catalog-table tbody tr').first();
  const samples: number[] = [];
  for (const query of queries) {
    const startedAt = nodePerformance.now();
    await input.fill(query);
    await expect(firstRow).toContainText(query);
    samples.push(nodePerformance.now() - startedAt);
  }
  await input.fill('');
  await expect(page.getByText(`${requestedRows.toLocaleString()} matching assets`, { exact: true })).toBeVisible();
  return samples;
}

async function measureScrollFrames(page: Page): Promise<number[]> {
  return page.evaluate(async () => {
    const container = document.querySelector('.catalog-table-wrap');
    if (!(container instanceof HTMLElement)) throw new Error('Catalog table scroll container is missing.');
    const samples: number[] = [];
    for (let index = 0; index < 12; index += 1) {
      const startedAt = window.performance.now();
      container.scrollTop = index % 2 === 0 ? container.scrollHeight : 0;
      await new Promise<void>(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame())));
      samples.push(window.performance.now() - startedAt);
    }
    return samples;
  });
}

async function rendererWorkingSetKb(application: ElectronApplication): Promise<number> {
  return application.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) return 0;
    const rendererPid = window.webContents.getOSProcessId();
    return app.getAppMetrics().find(metric => metric.pid === rendererPid)?.memory.workingSetSize ?? 0;
  });
}

function generateWorkbook(path: string, rows: number): Buffer {
  const countries = ['France', 'Italy', 'Japan', 'Mexico', 'Morocco', 'Portugal', 'Thailand', 'Vietnam'];
  const cities = ['Paris', 'Rome', 'Kyoto', 'Oaxaca', 'Marrakesh', 'Lisbon', 'Chiang Mai', 'Da Nang'];
  const activities = ['Walking', 'Architecture', 'Street food', 'Aerial viewing', 'Museum visit'];
  const records = Array.from({ length: rows }, (_, index) => {
    const group = index % countries.length;
    const activity = activities[index % activities.length] ?? 'Walking';
    const city = cities[group] ?? 'Paris';
    const country = countries[group] ?? 'France';
    return {
      ID: index + 1,
      Page: `https://elements.envato.com/electron-performance-${String(index + 1).padStart(7, '0')}`,
      Author: `Qualification Author ${index % 40}`,
      Attributes: 'travel; documentary; Electron performance qualification',
      'Item Tags': `${country}, ${city}, ${activity}, landmark, architecture`,
      Title: `${city} ${activity} architecture travel footage ${index + 1}`,
      Description: `Representative ${activity.toLowerCase()} footage in ${city}.`,
      Country: country,
      City: city,
      Location: `${city} Central District`,
      Activity: activity,
      Shot: ['Wide', 'Medium', 'Detail', 'Aerial Wide'][index % 4],
      Scene: `${activity} view of ${city}`,
      Object: 'Historic architecture',
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
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(records), 'Catalog');
  const bytes = Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true }));
  writeFileSync(path, bytes);
  return bytes;
}

function databaseIntegrity(path: string): string {
  const database = new DatabaseSync(path);
  try {
    const row = database.prepare('PRAGMA integrity_check').get() as { integrity_check?: string };
    return row.integrity_check ?? 'missing';
  } finally {
    database.close();
  }
}

async function waitForFfmpegProgress(
  output: () => string,
  child: ChildProcessWithoutNullStreams
): Promise<boolean> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (/frame=\s*\d+/i.test(output())) return true;
    if (child.exitCode !== null) return false;
    await new Promise(resolveTimer => setTimeout(resolveTimer, 100));
  }
  return false;
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGKILL');
  await Promise.race([
    new Promise<void>(resolveExit => child.once('exit', () => resolveExit())),
    new Promise<void>(resolveTimer => setTimeout(resolveTimer, 5_000))
  ]);
}

function boundedOutput(current: string, chunk: Buffer): string {
  return `${current}${chunk.toString('utf8')}`.slice(-65_536);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
