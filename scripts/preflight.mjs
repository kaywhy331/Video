import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = process.cwd();
const packagePath = resolve(root, 'package.json');
const beforeInstall = process.argv.includes('--before-install');

function fail(message) {
  console.error(`PRECHECK FAILED: ${message}`);
  process.exitCode = 1;
}

function checkBundledSqlite() {
  let database;
  try {
    database = new DatabaseSync(':memory:');
    database.exec("CREATE VIRTUAL TABLE test_fts USING fts5(value); INSERT INTO test_fts(value) VALUES ('ready');");
    const result = database.prepare("SELECT value FROM test_fts WHERE test_fts MATCH 'ready'").get();
    if (!result || result.value !== 'ready') fail('The Node.js SQLite/FTS5 runtime did not return the expected result.');
  } catch (error) {
    fail(`Node.js SQLite/FTS5 is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    database?.close();
  }
}

function migrationInventory(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .map(name => {
      const match = /^(\d{3})_.+\.sql$/.exec(name);
      return match ? { name, version: Number(match[1]) } : null;
    })
    .filter(Boolean)
    .sort((left, right) => left.version - right.version || left.name.localeCompare(right.name));
}

function checkMigrationParity() {
  const source = migrationInventory(resolve(root, 'src', 'main', 'database'));
  const packaged = migrationInventory(resolve(root, 'resources'));
  if (!source.length) {
    fail('No source SQLite migrations were found.');
    return;
  }
  if (!packaged.length) {
    fail('No packaged SQLite migrations were found.');
    return;
  }

  for (const [label, inventory] of [['source', source], ['packaged', packaged]]) {
    const versions = inventory.map(item => item.version);
    if (new Set(versions).size !== versions.length) {
      fail(`The ${label} SQLite migration inventory contains duplicate versions.`);
    }
    const expected = Array.from({ length: versions.at(-1) ?? 0 }, (_, index) => index + 1);
    if (versions.join(',') !== expected.join(',')) {
      fail(`The ${label} SQLite migration inventory is not contiguous from 001.`);
    }
  }

  const sourceNames = source.map(item => item.name);
  const packagedNames = packaged.map(item => item.name);
  if (sourceNames.join('\n') !== packagedNames.join('\n')) {
    fail(
      'Source and packaged SQLite migration inventories differ. '
      + `Source latest: ${sourceNames.at(-1) ?? 'none'}; packaged latest: ${packagedNames.at(-1) ?? 'none'}.`
    );
  }
}

if (!existsSync(packagePath)) {
  fail('package.json is missing. Fully extract the corrected ZIP before running it.');
} else {
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  const requiredRuntime = [
    '@electron-toolkit/utils',
    'chokidar',
    'ffmpeg-static',
    'ffprobe-static',
    'googleapis',
    'lucide-react',
    'react',
    'react-dom',
    'xlsx',
    'zod'
  ];
  const requiredDev = [
    '@playwright/test',
    '@types/node',
    '@types/react',
    '@types/react-dom',
    '@vitejs/plugin-react',
    'electron',
    'electron-builder',
    'electron-vite',
    'axe-core',
    'typescript',
    'vite',
    'vitest'
  ];

  for (const name of requiredRuntime) {
    if (!pkg.dependencies?.[name]) fail(`Missing runtime dependency declaration: ${name}`);
  }
  for (const name of requiredDev) {
    if (!pkg.devDependencies?.[name]) fail(`Missing development dependency declaration: ${name}`);
  }

  if (pkg.type === 'module') {
    fail('package.json must not force ESM output because the packaged Electron preload path is CommonJS.');
  }
  if (pkg.main !== './out/main/index.js') {
    fail(`Unexpected Electron entry point: ${String(pkg.main)}`);
  }
  if (!existsSync(resolve(root, 'electron.vite.config.mjs'))) {
    fail('electron.vite.config.mjs is missing.');
  }
  checkMigrationParity();
  if (!existsSync(resolve(root, 'validation', 'acceptance-map.json'))) {
    fail('The acceptance traceability map is missing.');
  }

  checkBundledSqlite();

  if (!beforeInstall) {
    const requiredInstalled = [
      'electron',
      'electron-vite',
      'electron-builder',
      'react',
      'vite',
      'vitest'
    ];
    for (const name of requiredInstalled) {
      if (!existsSync(resolve(root, 'node_modules', name, 'package.json'))) {
        fail(`Installed dependency is unavailable: ${name}`);
      }
    }
  }
}

if (!process.exitCode) {
  console.log(beforeInstall
    ? 'Preflight passed: package declaration, module format, SQLite/FTS5, and source resources are usable.'
    : 'Doctor passed: required dependencies are installed and the local runtime is usable.');
}
