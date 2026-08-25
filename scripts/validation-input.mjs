import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';

export const RUNTIME_INPUTS = Object.freeze([
  '.github',
  '.gitignore',
  '.nvmrc',
  'VALIDATION_CATALOG_PERFORMANCE.json',
  'VALIDATION_CATALOG_RESPONSIVENESS.json',
  'docs/prd',
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
]);

export const CLAIMS_INPUTS = Object.freeze([
  'ALPHA-OPERATING-GUIDE.md',
  'README.md',
  'VALIDATION_REPORT.md',
  'docs/DEPENDENCY-SECURITY.md',
  'docs/IMPLEMENTATION-COVERAGE.md',
  'docs/PRODUCTION-HARDENING.md',
  'docs/release-evidence'
]);

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
  return runtimeInputDigest(root);
}

export function runtimeInputDigest(root = process.cwd()) {
  return inputDigest(root, RUNTIME_INPUTS);
}

export function claimsInputDigest(root = process.cwd()) {
  return inputDigest(root, CLAIMS_INPUTS);
}

export function validationInputDigests(root = process.cwd()) {
  return {
    runtime: runtimeInputDigest(root),
    claims: claimsInputDigest(root)
  };
}

function inputDigest(root, inputs) {
  const files = [];
  for (const input of inputs) {
    const path = resolve(root, input);
    if (!existsSync(path)) continue;
    if (readdirSafe(path)) filesUnder(root, path, files);
    else files.push(path);
  }
  files.sort((left, right) => comparePaths(normalizedPath(root, left), normalizedPath(root, right)));
  const hash = createHash('sha256');
  const manifest = [];
  for (const path of files) {
    const name = normalizedPath(root, path);
    const bytes = readFileSync(path);
    const fileSha256 = createHash('sha256').update(bytes).digest('hex');
    hash.update(name);
    hash.update('\0');
    hash.update(bytes);
    hash.update('\0');
    manifest.push({ path: name, sizeBytes: bytes.length, sha256: fileSha256 });
  }
  return { sha256: hash.digest('hex'), fileCount: files.length, files: manifest };
}

function normalizedPath(root, path) {
  return relative(root, path).replaceAll('\\', '/');
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function readdirSafe(path) {
  try {
    readdirSync(path);
    return true;
  } catch {
    return false;
  }
}
