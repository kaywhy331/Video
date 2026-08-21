import { readFileSync, existsSync } from 'node:fs';
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
  if (!existsSync(resolve(root, 'resources', '001_initial.sql'))) {
    fail('The packaged SQLite migration is missing.');
  }
  if (!existsSync(resolve(root, 'resources', '017_deferred_lifecycle.sql'))) {
    fail('The latest packaged SQLite migration is missing.');
  }
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
