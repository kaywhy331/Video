import { statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { _electron as electron } from '@playwright/test';

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

try {
  application = await electron.launch({
    executablePath,
    args: [
      `--user-data-dir=${userDataRoot}`,
      '--disable-gpu'
    ],
    env: {
      ...process.env,
      VIDEOFACTORY_DEV_DATA_ROOT: dataRoot,
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

  const closePromise = application.waitForEvent('close', { timeout: timeoutMs });
  await application.evaluate(({ app }) => {
    setImmediate(() => app.quit());
    return true;
  });
  await closePromise;
  closedOrderly = true;
  const exitedAt = new Date();

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
    lifecycle: {
      orderlyQuit: true,
      startedAt: startedAt.toISOString(),
      readyAt: readyAt.toISOString(),
      exitedAt: exitedAt.toISOString(),
      startupDurationMs: readyAt.getTime() - startedAt.getTime(),
      shutdownDurationMs: exitedAt.getTime() - readyAt.getTime()
    }
  }, null, 2)}\n`);
} finally {
  if (application && !closedOrderly) {
    await application.close().catch(() => undefined);
  }
}
