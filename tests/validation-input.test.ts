import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RELEASE_CLAIM_DOCUMENTS,
  RUNTIME_NORMATIVE_DOCUMENTS,
  validationInputDigests
} from '../scripts/validation-input.mjs';

const repositoryRoot = process.cwd();
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('validation input digests and generated evidence lifecycle', () => {
  it('[REL-004] separates deterministic runtime inputs from non-circular release claims', () => {
    const root = mkdtempSync(join(tmpdir(), 'videofactory-validation-input-'));
    roots.push(root);
    mkdirSync(resolve(root, 'validation', 'results'), { recursive: true });
    mkdirSync(resolve(root, 'validation', 'external-qualification'), { recursive: true });
    mkdirSync(resolve(root, 'docs', 'release-evidence'), { recursive: true });
    writeFileSync(resolve(root, 'package.json'), '{"version":"1.0.0"}\n');
    writeFileSync(resolve(root, 'README.md'), 'claim one\n');
    writeFileSync(resolve(root, 'docs', 'release-evidence', 'v1.json'), '{"historical":true}\n');
    writeFileSync(resolve(root, 'validation', 'results', 'pipeline.json'), '{"generated":true}\n');
    writeFileSync(resolve(root, 'validation', 'external-qualification', 'index.json'), '{"generated":true}\n');

    const first = validationInputDigests(root);
    expect(first.runtime.files.map(file => file.path)).toEqual(['package.json']);
    expect(first.claims.files.map(file => file.path)).toEqual([
      'README.md',
      'docs/release-evidence/v1.json'
    ]);

    writeFileSync(resolve(root, 'README.md'), 'claim two\n');
    const claimsChanged = validationInputDigests(root);
    expect(claimsChanged.runtime.sha256).toBe(first.runtime.sha256);
    expect(claimsChanged.claims.sha256).not.toBe(first.claims.sha256);

    writeFileSync(resolve(root, 'package.json'), '{"version":"1.0.1"}\n');
    const runtimeChanged = validationInputDigests(root);
    expect(runtimeChanged.runtime.sha256).not.toBe(claimsChanged.runtime.sha256);
    expect(runtimeChanged.claims.sha256).toBe(claimsChanged.claims.sha256);

    writeFileSync(resolve(root, 'validation', 'results', 'pipeline.json'), '{"generated":false}\n');
    writeFileSync(resolve(root, 'validation', 'external-qualification', 'index.json'), '{"generated":false}\n');
    expect(validationInputDigests(root)).toEqual(runtimeChanged);
  });

  it('[REL-004] covers every normative and claim document with deterministic raw-byte manifests', () => {
    const first = validationInputDigests(repositoryRoot);
    const runtimePaths = new Set(first.runtime.files.map(file => file.path));
    const claimsPaths = new Set(first.claims.files.map(file => file.path));
    for (const path of RUNTIME_NORMATIVE_DOCUMENTS) expect(runtimePaths.has(path), path).toBe(true);
    expect(runtimePaths.has('playwright.performance.config.ts')).toBe(true);
    for (const path of RELEASE_CLAIM_DOCUMENTS) expect(claimsPaths.has(path), path).toBe(true);
    expect(claimsPaths.has('docs/release-evidence/v0.1.0-alpha.7.json')).toBe(true);
    expect(claimsPaths.has('docs/release-evidence/v0.1.0-alpha.8.json')).toBe(true);
    expect(claimsPaths.has('docs/release-evidence/v0.1.0-alpha.9.json')).toBe(true);
    expect(first.runtime.files.map(file => file.path)).toEqual(
      [...first.runtime.files.map(file => file.path)].sort()
    );
    expect(first.claims.files.map(file => file.path)).toEqual(
      [...first.claims.files.map(file => file.path)].sort()
    );
    expect(validationInputDigests(repositoryRoot)).toEqual(first);
  });

  it('[REL-004] produces identical manifests regardless of filesystem creation order', () => {
    const left = mkdtempSync(join(tmpdir(), 'videofactory-input-order-left-'));
    const right = mkdtempSync(join(tmpdir(), 'videofactory-input-order-right-'));
    roots.push(left, right);
    const files: Array<[string, string]> = [
      ['package.json', '{"version":"1.0.0"}\n'],
      ['docs/prd/01-PRD.md', 'normative product bytes\n'],
      ['README.md', 'release claim bytes\n'],
      ['docs/release-evidence/v1.json', '{"historical":true}\n']
    ];
    const write = (root: string, entries: Array<[string, string]>) => {
      for (const [path, contents] of entries) {
        mkdirSync(resolve(root, path, '..'), { recursive: true });
        writeFileSync(resolve(root, path), contents);
      }
    };
    write(left, files);
    write(right, [...files].reverse());

    expect(validationInputDigests(left)).toEqual(validationInputDigests(right));
  });

  it('[REL-003] keeps generated receipts untracked and transfers release evidence by the exact workflow SHA', () => {
    for (const path of [
      'VALIDATION_ACCEPTANCE_RECEIPT.json',
      'VALIDATION_STATUS.json',
      'validation/results/pipeline.json',
      'validation/results/electron-performance.json',
      'validation/results/electron-performance-playwright.json',
      'validation/external-qualification/index.json'
    ]) {
      const ignored = spawnSync('git', ['check-ignore', '--quiet', path], { cwd: repositoryRoot });
      expect(ignored.status).toBe(0);
    }
    for (const path of ['VALIDATION_ACCEPTANCE_RECEIPT.json', 'VALIDATION_STATUS.json']) {
      const tracked = spawnSync('git', ['ls-files', '--error-unmatch', path], {
        cwd: repositoryRoot,
        encoding: 'utf8'
      });
      expect(tracked.status).not.toBe(0);
    }

    const workflow = readFileSync(resolve(repositoryRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
    const exactArtifactName = 'VideoFactory-Desktop-${{ github.sha }}-validation-evidence';
    expect(workflow.split(exactArtifactName)).toHaveLength(3);
    expect(workflow).toContain('run: npm run validate:release');
    expect(workflow).toContain("$pipeline.source.commit -ne '${{ github.sha }}'");
    expect(workflow).toContain('validation/results/runtime-input.json');
    expect(workflow).toContain('validation/results/claims-input.json');
  });

  it('[REL-003] pins raw validation input bytes to LF across Linux and Windows checkouts', () => {
    expect(readFileSync(resolve(repositoryRoot, '.gitattributes'), 'utf8')).toBe('* text=auto eol=lf\n');

    const representativeInputs = [
      '.github/workflows/ci.yml',
      'scripts/validation-input.mjs',
      'src/main/app-context.ts',
      'README.md',
      'docs/release-evidence/v0.1.0-alpha.7.json',
      'docs/release-evidence/v0.1.0-alpha.8.json',
      'docs/release-evidence/v0.1.0-alpha.9.json'
    ];
    const attributes = spawnSync(
      'git',
      ['check-attr', 'text', 'eol', '--', ...representativeInputs],
      { cwd: repositoryRoot, encoding: 'utf8' }
    );
    expect(attributes.status).toBe(0);
    for (const path of representativeInputs) {
      expect(attributes.stdout).toContain(`${path}: text: auto`);
      expect(attributes.stdout).toContain(`${path}: eol: lf`);
    }
  });
});
