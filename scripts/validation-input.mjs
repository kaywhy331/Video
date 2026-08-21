import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const INPUTS = [
  '.github',
  '.nvmrc',
  'VALIDATION_CATALOG_PERFORMANCE.json',
  'VALIDATION_CATALOG_RESPONSIVENESS.json',
  'docs/prd/06-ACCEPTANCE-TESTS.md',
  'electron.vite.config.mjs',
  'package-lock.json',
  'package.json',
  'playwright.config.ts',
  'resources',
  'scripts',
  'src',
  'tests',
  'tsconfig.json',
  'validation',
  'vitest.config.ts'
];

function filesUnder(root, path, output) {
  const relativePath = relative(root, path).replaceAll('\\', '/');
  if (relativePath === 'validation/results' || relativePath.startsWith('validation/results/')) return;
  const entries = readdirSync(path, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) filesUnder(root, child, output);
    else if (entry.isFile()) output.push(child);
  }
}

export function validationInputDigest(root = process.cwd()) {
  const files = [];
  for (const input of INPUTS) {
    const path = resolve(root, input);
    if (!existsSync(path)) continue;
    if (readdirSafe(path)) filesUnder(root, path, files);
    else files.push(path);
  }
  files.sort((left, right) => left.localeCompare(right));
  const hash = createHash('sha256');
  for (const path of files) {
    hash.update(relative(root, path).replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(readFileSync(path));
    hash.update('\0');
  }
  return { sha256: hash.digest('hex'), fileCount: files.length };
}

function readdirSafe(path) {
  try {
    readdirSync(path);
    return true;
  } catch {
    return false;
  }
}
