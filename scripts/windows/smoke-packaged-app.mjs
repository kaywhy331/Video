import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { _electron as electron } from '@playwright/test';
import * as XLSX from 'xlsx';

const runtimeRows = 26_000;
const runtimeEventRelativePath = join('qualification', 'windows-package-runtime.jsonl');

const { values } = parseArgs({
  options: {
    executable: { type: 'string' },
    'data-root': { type: 'string' },
    'user-data-root': { type: 'string' },
    'expected-version': { type: 'string' },
    kind: { type: 'string' },
    result: { type: 'string' },
    'timeout-seconds': { type: 'string', default: '90' }
  },
  strict: true
});

for (const option of ['executable', 'data-root', 'user-data-root', 'expected-version', 'kind', 'result']) {
  if (!values[option]) throw new Error(`--${option} is required.`);
}

const timeoutSeconds = Number(values['timeout-seconds']);
if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 300) {
  throw new Error('--timeout-seconds must be an integer between 10 and 300.');
}

const executablePath = resolve(values.executable);
const dataRoot = resolve(values['data-root']);
const userDataRoot = resolve(values['user-data-root']);
const resultPath = resolve(values.result);
const timeoutMs = timeoutSeconds * 1_000;
const startedAt = new Date();
let application;
let closedOrderly = false;
let quitRequestedAt;

if (!['archive', 'installed'].includes(values.kind)) {
  throw new Error('--kind must be archive or installed.');
}

const runtimeQualificationRequested = values.kind === 'installed';
const runtimeEventPath = join(dataRoot, runtimeEventRelativePath);
const runtimeWorkbookPath = join(dataRoot, `windows-runtime-catalog-${runtimeRows}.xlsx`);

function delay(milliseconds) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
}

function readRuntimeEvents() {
  if (!existsSync(runtimeEventPath)) return [];
  const text = readFileSync(runtimeEventPath, 'utf8').trim();
  if (!text) return [];
  return text.split(/\r?\n/u).map((line, index) => {
    const event = JSON.parse(line);
    if (event.schemaVersion !== 1 || event.sequence !== index + 1 || typeof event.event !== 'string') {
      throw new Error('The packaged runtime event stream is malformed or out of sequence.');
    }
    return event;
  });
}

async function waitForRuntimeEvent(name) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = readRuntimeEvents().find(candidate => candidate.event === name);
    if (event) return event;
    await delay(25);
  }
  throw new Error(`The packaged application did not record ${name} within ${timeoutSeconds} seconds.`);
}

async function waitForCatalogOperation(page, operationId) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await page.evaluate(async id => window.videoFactory.catalog.importStatus()
      .then(active => active?.operationId === id), operationId);
    if (status) return true;
    await delay(25);
  }
  return false;
}

async function mainWindowState() {
  return application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return {
      exists: Boolean(window),
      visible: window?.isVisible() ?? false,
      destroyed: window?.isDestroyed() ?? true
    };
  });
}

function generateRuntimeWorkbook(path) {
  const countries = ['France', 'Italy', 'Japan', 'Mexico', 'Morocco', 'Portugal', 'Thailand', 'Vietnam'];
  const cities = ['Paris', 'Rome', 'Kyoto', 'Oaxaca', 'Marrakesh', 'Lisbon', 'Chiang Mai', 'Da Nang'];
  const activities = ['Walking', 'Architecture', 'Street food', 'Aerial viewing', 'Museum visit'];
  const records = Array.from({ length: runtimeRows }, (_, index) => {
    const group = index % countries.length;
    const city = cities[group];
    const country = countries[group];
    const activity = activities[index % activities.length];
    return {
      ID: index + 1,
      Page: `https://elements.envato.com/windows-runtime-${String(index + 1).padStart(7, '0')}`,
      Author: `Windows Qualification Author ${index % 40}`,
      Attributes: 'travel; documentary; packaged Windows runtime qualification',
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
  return bytes.length;
}

try {
  let runtimeWorkbookSizeBytes = null;
  if (runtimeQualificationRequested) {
    mkdirSync(dataRoot, { recursive: true });
    runtimeWorkbookSizeBytes = generateRuntimeWorkbook(runtimeWorkbookPath);
  }

  application = await electron.launch({
    executablePath,
    args: [
      `--user-data-dir=${userDataRoot}`,
      '--disable-gpu'
    ],
    env: {
      ...process.env,
      VIDEOFACTORY_DEV_DATA_ROOT: dataRoot,
      VIDEOFACTORY_PACKAGE_RUNTIME_QUALIFICATION: runtimeQualificationRequested ? '1' : '0',
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
    },
    timeout: timeoutMs
  });

  const page = application.windows()[0] ?? await application.firstWindow({ timeout: timeoutMs });
  await page.getByRole('heading', { name: /Produce the next accurate video/i }).waitFor({
    state: 'visible',
    timeout: timeoutMs
  });
  const readyAt = new Date();
  const appMetadata = await application.evaluate(({ app }) => ({
    isPackaged: app.isPackaged,
    name: app.getName(),
    version: app.getVersion()
  }));
  if (!appMetadata.isPackaged) throw new Error('The smoke target is not running as a packaged Electron application.');
  if (appMetadata.version !== values['expected-version']) {
    throw new Error(`Packaged app version ${appMetadata.version} does not match ${values['expected-version']}.`);
  }

  const databasePath = join(dataRoot, 'data', 'videofactory.sqlite');
  const database = statSync(databasePath);
  if (!database.isFile() || database.size === 0) {
    throw new Error('The packaged application did not initialize its isolated SQLite database.');
  }
  const windowTitle = await page.title();

  let runtimeQualification = null;
  if (runtimeQualificationRequested) {
    const operationId = `windows-package-runtime-${Date.now()}`;
    await page.evaluate(({ filePath, id }) => {
      window.__videoFactoryPackageRuntimePreview = window.videoFactory.catalog.previewImport({
        filePath,
        operationId: id
      });
    }, { filePath: runtimeWorkbookPath, id: operationId });

    const catalogWorkerObservedActive = await waitForCatalogOperation(page, operationId);
    const powerStarted = await waitForRuntimeEvent('power_blocker_started');
    const powerBlockerObservedStarted = powerStarted.details?.started === true;

    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error('The installed package has no main window to close to its tray.');
      window.close();
    });
    const hiddenEvent = await waitForRuntimeEvent('window_hidden_to_tray');
    const hiddenStateDuringWork = await mainWindowState();
    const hiddenStatus = await page.evaluate(async id => ({
      active: (await window.videoFactory.catalog.importStatus())?.operationId === id,
      pingActive: (await window.videoFactory.catalog.ping()).activeOperation?.operationId === id
    }), operationId);

    const preview = await page.evaluate(() => window.__videoFactoryPackageRuntimePreview);
    const hiddenStateAfterWork = await mainWindowState();
    const powerStopped = await waitForRuntimeEvent('power_blocker_stopped');
    const eventsBeforeQuit = readRuntimeEvents();
    const startIndex = eventsBeforeQuit.findIndex(event => event.event === 'power_blocker_started');
    const hiddenIndex = eventsBeforeQuit.findIndex(event => event.event === 'window_hidden_to_tray');
    const stopIndex = eventsBeforeQuit.findIndex(event => event.event === 'power_blocker_stopped');

    runtimeQualification = {
      schemaVersion: 1,
      status: 'running',
      workload: {
        kind: 'catalog_preview',
        operationId,
        source: basename(runtimeWorkbookPath),
        sourceSizeBytes: runtimeWorkbookSizeBytes,
        requestedRows: runtimeRows,
        completedRows: preview?.rowCount ?? null
      },
      observations: {
        hiddenEventSequence: hiddenEvent.sequence,
        powerStartedEventSequence: powerStarted.sequence,
        powerStoppedEventSequence: powerStopped.sequence
      },
      checks: {
        trayReady: eventsBeforeQuit.some(event => event.event === 'tray_ready' && event.details?.available === true),
        catalogWorkerObservedActive,
        powerBlockerObservedStarted,
        windowCloseHiddenToTray: hiddenEvent.details?.visible === false
          && hiddenEvent.details?.destroyed === false
          && hiddenStateDuringWork.exists
          && !hiddenStateDuringWork.visible
          && !hiddenStateDuringWork.destroyed,
        processAliveAfterWindowClose: hiddenStateDuringWork.exists && !hiddenStateDuringWork.destroyed,
        catalogWorkerObservedActiveWhileHidden: hiddenStatus.active && hiddenStatus.pingActive,
        catalogWorkerCompletedWhileHidden: preview?.rowCount === runtimeRows
          && hiddenStateAfterWork.exists
          && !hiddenStateAfterWork.visible
          && !hiddenStateAfterWork.destroyed,
        powerBlockerObservedStopped: powerStopped.details?.wasStarted === true
          && powerStopped.details?.reason === 'operation_complete',
        powerBlockerCoveredWork: startIndex >= 0 && hiddenIndex > startIndex && stopIndex > hiddenIndex
      },
      events: []
    };
  }

  const closePromise = application.waitForEvent('close', { timeout: timeoutMs });
  quitRequestedAt = new Date();
  await application.evaluate(({ app }) => {
    setImmediate(() => app.quit());
    return true;
  });
  await closePromise;
  closedOrderly = true;
  const exitedAt = new Date();

  if (runtimeQualification) {
    const events = readRuntimeEvents();
    const qualificationIndex = events.findIndex(event => event.event === 'qualification_started');
    const trayIndex = events.findIndex(event => event.event === 'tray_ready');
    const startedIndex = events.findIndex(event => event.event === 'power_blocker_started');
    const hiddenIndex = events.findIndex(event => event.event === 'window_hidden_to_tray');
    const stoppedIndex = events.findIndex(event => event.event === 'power_blocker_stopped');
    const shutdownStartedIndex = events.findIndex(event => event.event === 'shutdown_started');
    const shutdownCompletedIndex = events.findIndex(event => event.event === 'shutdown_completed');
    Object.assign(runtimeQualification.checks, {
      shutdownStarted: shutdownStartedIndex > stoppedIndex,
      shutdownCompleted: shutdownCompletedIndex > shutdownStartedIndex,
      orderlyQuit: closedOrderly,
      eventSequenceValid: qualificationIndex === 0
        && trayIndex > qualificationIndex
        && startedIndex > trayIndex
        && hiddenIndex > startedIndex
        && stoppedIndex > hiddenIndex
        && shutdownStartedIndex > stoppedIndex
        && shutdownCompletedIndex > shutdownStartedIndex
    });
    runtimeQualification.events = events;
    runtimeQualification.status = Object.values(runtimeQualification.checks).every(Boolean) ? 'passed' : 'failed';
    if (runtimeQualification.status !== 'passed') {
      throw new Error(`Installed runtime qualification failed: ${JSON.stringify(runtimeQualification.checks)}`);
    }
  }

  writeFileSync(resultPath, `${JSON.stringify({
    status: 'passed',
    kind: values.kind,
    executable: basename(executablePath),
    app: {
      ...appMetadata,
      windowTitle,
      dashboardReady: true
    },
    database: {
      initialized: true,
      sizeBytes: database.size
    },
    runtimeQualification,
    lifecycle: {
      orderlyQuit: true,
      startedAt: startedAt.toISOString(),
      readyAt: readyAt.toISOString(),
      exitedAt: exitedAt.toISOString(),
      startupDurationMs: readyAt.getTime() - startedAt.getTime(),
      shutdownDurationMs: exitedAt.getTime() - quitRequestedAt.getTime()
    }
  }, null, 2)}\n`);
} finally {
  if (application && !closedOrderly) {
    await application.close().catch(() => undefined);
  }
}
