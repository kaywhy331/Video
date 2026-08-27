import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { arch } from 'node:os';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  admitValidationSource,
  assertValidationSourceStable
} from './validation-source.mjs';
import {
  ELECTRON_PERFORMANCE_THRESHOLDS,
  assessElectronPerformanceEvidence
} from './electron-performance-evidence.mjs';
import {
  ELECTRON_PERFORMANCE_RECEIPT_PATH,
  writeElectronPerformanceQualificationIndex
} from './external-qualification-evidence.mjs';

const args = process.argv.slice(2);
const mode = option('mode', 'supporting');
if (!['supporting', 'qualification'].includes(mode)) {
  throw new Error('Electron performance mode must be supporting or qualification.');
}

const defaultRows = mode === 'qualification'
  ? ELECTRON_PERFORMANCE_THRESHOLDS.qualificationRows
  : 2_000;
const rows = Number(option('rows', process.env.ELECTRON_PERFORMANCE_ROWS ?? String(defaultRows)));
if (!Number.isSafeInteger(rows) || rows < 100 || rows > ELECTRON_PERFORMANCE_THRESHOLDS.qualificationRows) {
  throw new Error(`Electron performance rows must be an integer between 100 and ${ELECTRON_PERFORMANCE_THRESHOLDS.qualificationRows}.`);
}
if (mode === 'qualification' && rows !== ELECTRON_PERFORMANCE_THRESHOLDS.qualificationRows) {
  throw new Error(`Qualification mode requires exactly ${ELECTRON_PERFORMANCE_THRESHOLDS.qualificationRows} rows.`);
}

const deviceClass = option('device-class', process.env.ELECTRON_PERFORMANCE_DEVICE_CLASS ?? '').trim();
const output = resolve(option('output', 'validation/results/electron-performance.json'));
const ci = truthy(process.env.CI);
if (mode === 'qualification') {
  if (process.platform !== 'win32' || arch() !== 'x64') {
    throw new Error('Qualification mode requires the supported Windows x64 target.');
  }
  if (ci) throw new Error('Qualification mode must run on representative operator hardware outside CI.');
  if (deviceClass.length < 8) {
    throw new Error('Qualification mode requires --device-class with a non-sensitive representative hardware description.');
  }
  if (output !== resolve(ELECTRON_PERFORMANCE_RECEIPT_PATH)) {
    throw new Error(`Qualification mode must write ${ELECTRON_PERFORMANCE_RECEIPT_PATH}.`);
  }
}

if (!existsSync(resolve('out', 'main', 'index.js'))) {
  throw new Error('Build the production Electron application before running performance qualification.');
}

const admission = admitValidationSource({
  root: process.cwd(),
  qualification: mode === 'qualification' ? 'release' : 'development'
});
mkdirSync(dirname(output), { recursive: true });
rmSync(output, { force: true });

const playwrightCli = resolve('node_modules', 'playwright', 'cli.js');
if (!existsSync(playwrightCli)) {
  throw new Error('The local Playwright CLI is unavailable. Run npm ci before performance qualification.');
}
const playwrightArgs = [playwrightCli, 'test', '--config=playwright.performance.config.ts'];
const environment = {
  ...process.env,
  VIDEOFACTORY_PERFORMANCE_MODE: mode,
  VIDEOFACTORY_PERFORMANCE_ROWS: String(rows),
  VIDEOFACTORY_PERFORMANCE_OUTPUT: output,
  VIDEOFACTORY_PERFORMANCE_SOURCE: JSON.stringify(admission.source),
  VIDEOFACTORY_PERFORMANCE_DEVICE_CLASS: deviceClass,
  VIDEOFACTORY_PERFORMANCE_CI: ci ? 'true' : 'false'
};
const result = process.platform === 'linux'
  ? spawnSync('xvfb-run', ['-a', process.execPath, ...playwrightArgs], { stdio: 'inherit', env: environment })
  : spawnSync(process.execPath, playwrightArgs, { stdio: 'inherit', env: environment });

if (result.error) throw result.error;
assertValidationSourceStable(admission);
if (!existsSync(output)) {
  throw new Error(
    result.status === 0
      ? 'Electron performance run completed without its evidence receipt.'
      : `Electron performance run failed with status ${result.status ?? 'unknown'} before writing an evidence receipt.`
  );
}

const assessed = assessElectronPerformanceEvidence(JSON.parse(readFileSync(output, 'utf8')));
if (assessed.source.commit !== admission.source.commit || assessed.source.tree !== admission.source.tree) {
  throw new Error('Electron performance receipt source does not match admitted source.');
}
if (assessed.mode !== mode || assessed.fixture.requestedRows !== rows) {
  throw new Error('Electron performance receipt does not match the requested run mode and fixture size.');
}
writeFileSync(output, `${JSON.stringify(assessed, null, 2)}\n`, 'utf8');

if (result.status !== 0) {
  throw new Error(`Electron performance Playwright run failed with status ${result.status ?? 'unknown'}; the assessed receipt was retained.`);
}

if (!assessed.smokeCriteriaPassed) {
  throw new Error('Electron performance measured criteria failed. Inspect the generated receipt and Playwright artifacts.');
}
if (mode === 'qualification' && !assessed.externalQualificationPassed) {
  throw new Error('Electron performance target run did not satisfy every external qualification condition.');
}
const externalAdmission = mode === 'qualification'
  ? writeElectronPerformanceQualificationIndex({ root: process.cwd(), source: admission.source })
  : null;

process.stdout.write(
  `Electron performance ${mode} run passed for ${rows.toLocaleString()} rows; `
  + `external qualification: ${assessed.externalQualificationPassed ? 'passed' : 'not claimed'}.\n`
  + `Receipt: ${output}\n`
  + (externalAdmission?.index ? `Index: ${resolve(externalAdmission.index.path)}\n` : '')
);

function option(name, fallback) {
  const inline = args.find(argument => argument.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] ?? '' : fallback;
}

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}
