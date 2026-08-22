import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = process.cwd();
const script = resolve(repositoryRoot, 'scripts', 'generate-release-manifest.mjs');
const roots: string[] = [];

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'videofactory-release-manifest-'));
  roots.push(root);
  mkdirSync(resolve(root, 'release'));
  writeFileSync(resolve(root, 'package.json'), JSON.stringify({ version: '9.8.7-alpha.1' }));
  writeFileSync(resolve(root, 'release', 'VideoFactory-Desktop-9.8.7-alpha.1-x64.exe'), 'installer');
  writeFileSync(resolve(root, 'release', 'VideoFactory-Desktop-9.8.7-alpha.1-x64.zip'), 'archive');
  return root;
}

function run(root: string, args: string[] = [], environment: Record<string, string> = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    env: {
      ...process.env,
      GITHUB_REF_TYPE: 'tag',
      GITHUB_REF_NAME: 'v9.8.7-alpha.1',
      GITHUB_REF: 'refs/tags/v9.8.7-alpha.1',
      GITHUB_SHA: 'a'.repeat(40),
      ...environment
    },
    encoding: 'utf8'
  });
}

function writeValidationEvidence(root: string): void {
  mkdirSync(resolve(root, 'validation', 'results'), { recursive: true });
  const pipelinePath = resolve(root, 'validation', 'results', 'pipeline.json');
  const vitestPath = resolve(root, 'validation', 'results', 'vitest.json');
  const playwrightPath = resolve(root, 'validation', 'results', 'playwright.json');
  const sbomPath = resolve(root, 'validation', 'results', 'videofactory-sbom.cdx.json');
  writeFileSync(pipelinePath, JSON.stringify({ completed: true }));
  writeFileSync(vitestPath, JSON.stringify({ success: true }));
  writeFileSync(playwrightPath, JSON.stringify({ stats: { expected: 1 } }));
  writeFileSync(sbomPath, JSON.stringify({
    bomFormat: 'CycloneDX',
    metadata: { component: { version: '9.8.7-alpha.1' } }
  }));
  const pipelineEvidence = evidence(pipelinePath);
  const sbomEvidence = evidence(sbomPath);
  writeFileSync(resolve(root, 'VALIDATION_STATUS.json'), JSON.stringify({
    release: '9.8.7-alpha.1',
    validationInputSha256: 'b'.repeat(64),
    source: { commit: 'a'.repeat(40) },
    pipeline: { status: 'passed' },
    evidence: { pipeline: pipelineEvidence, sbom: sbomEvidence }
  }));
  writeFileSync(resolve(root, 'VALIDATION_ACCEPTANCE_RECEIPT.json'), JSON.stringify({
    appVersion: '9.8.7-alpha.1',
    validationInputSha256: 'b'.repeat(64),
    source: { commit: 'a'.repeat(40) },
    evidence: { pipeline: pipelineEvidence, sbom: sbomEvidence },
    testReports: { vitest: evidence(vitestPath), playwright: evidence(playwrightPath) }
  }));
}

function evidence(path: string) {
  return {
    sizeBytes: statSync(path).size,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex')
  };
}

function writePackageSmokeEvidence(root: string, status: 'passed' | 'failed' = 'passed'): void {
  const installerPath = resolve(root, 'release', 'VideoFactory-Desktop-9.8.7-alpha.1-x64.exe');
  const archivePath = resolve(root, 'release', 'VideoFactory-Desktop-9.8.7-alpha.1-x64.zip');
  const packageEvidence = (path: string) => ({ name: basename(path), ...evidence(path) });
  writeFileSync(resolve(root, 'release', 'WINDOWS_PACKAGE_SMOKE.json'), JSON.stringify({
    receiptVersion: 1,
    status,
    appVersion: '9.8.7-alpha.1',
    source: { commit: 'a'.repeat(40) },
    runner: { platform: 'win32' },
    packages: {
      installer: packageEvidence(installerPath),
      archive: packageEvidence(archivePath)
    },
    checks: {
      archiveLaunch: { status },
      installerInstall: { status },
      installedLaunch: { status },
      uninstall: { status }
    }
  }));
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('release artifact provenance', () => {
  it('uses a canonical upload-safe Windows artifact template', () => {
    const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'));
    const artifactName = packageJson.build?.win?.artifactName;
    expect(artifactName).toBe('VideoFactory-Desktop-${version}-${arch}.${ext}');

    const renderedName = artifactName
      .replace('${version}', '9.8.7-alpha.1')
      .replace('${arch}', 'x64')
      .replace('${ext}', 'exe');
    expect(renderedName).toBe('VideoFactory-Desktop-9.8.7-alpha.1-x64.exe');
    expect(renderedName).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  });

  it('writes and verifies exact hashes for every release artifact', () => {
    const root = fixtureRoot();
    expect(run(root).status).toBe(0);
    expect(run(root, ['--verify']).status).toBe(0);
    const manifest = JSON.parse(readFileSync(resolve(root, 'release', 'RELEASE_PROVENANCE.json'), 'utf8'));
    expect(manifest.appVersion).toBe('9.8.7-alpha.1');
    expect(manifest.artifacts).toHaveLength(2);
  });

  it('fails verification after a published artifact changes', () => {
    const root = fixtureRoot();
    expect(run(root).status).toBe(0);
    writeFileSync(resolve(root, 'release', 'VideoFactory-Desktop-9.8.7-alpha.1-x64.zip'), 'tampered');
    const result = run(root, ['--verify']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('failed integrity verification');
  });

  it('rejects an unlisted artifact added after manifest generation', () => {
    const root = fixtureRoot();
    expect(run(root).status).toBe(0);
    writeFileSync(resolve(root, 'release', 'unexpected.json'), '{}');
    const result = run(root, ['--verify']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('inventory does not exactly match');
  });

  it('requires matching validation evidence when requested', () => {
    const root = fixtureRoot();
    expect(run(root, ['--require-validation']).stderr).toContain('requires validation evidence');
    writeValidationEvidence(root);
    expect(run(root, ['--require-validation']).status).toBe(0);
    expect(run(root, ['--verify']).status).toBe(0);
    expect(readFileSync(resolve(root, 'release', 'VALIDATION_STATUS.json'), 'utf8')).toContain('9.8.7-alpha.1');
  });

  it('rejects missing packaged Windows smoke evidence when requested', () => {
    const root = fixtureRoot();
    const result = run(root, ['--require-package-smoke']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('requires WINDOWS_PACKAGE_SMOKE.json');
  });

  it('rejects a failed packaged Windows smoke receipt', () => {
    const root = fixtureRoot();
    writePackageSmokeEvidence(root, 'failed');
    const result = run(root, ['--require-package-smoke']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('package smoke test did not pass');
  });

  it('records artifact-bound packaged Windows smoke evidence after it passes', () => {
    const root = fixtureRoot();
    writePackageSmokeEvidence(root);
    expect(run(root, ['--require-package-smoke']).status).toBe(0);
    expect(run(root, ['--verify']).status).toBe(0);
    const manifest = JSON.parse(readFileSync(resolve(root, 'release', 'RELEASE_PROVENANCE.json'), 'utf8'));
    expect(manifest.windowsPackageSmoke.status).toBe('passed');
    expect(manifest.windowsPackageSmoke.checks.uninstall.status).toBe('passed');
  });

  it('records branch builds without claiming a release tag', () => {
    const root = fixtureRoot();
    expect(run(root, [], {
      GITHUB_REF_TYPE: 'branch',
      GITHUB_REF_NAME: 'main',
      GITHUB_REF: 'refs/heads/main'
    }).status).toBe(0);
    const manifest = JSON.parse(readFileSync(resolve(root, 'release', 'RELEASE_PROVENANCE.json'), 'utf8'));
    expect(manifest.tag).toBeNull();
    expect(manifest.source.ref).toBe('refs/heads/main');
  });

  it('rejects a tag that does not exactly match the package version', () => {
    const root = fixtureRoot();
    const result = run(root, [], { GITHUB_REF_NAME: 'v9.8.7-alpha.2' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not match package version');
  });

  it('rejects package filenames that hosted release uploads would normalize', () => {
    const root = fixtureRoot();
    renameSync(
      resolve(root, 'release', 'VideoFactory-Desktop-9.8.7-alpha.1-x64.zip'),
      resolve(root, 'release', 'VideoFactory Desktop-9.8.7-alpha.1-x64.zip')
    );
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('filename is not upload-safe');
  });

  it('rejects validation evidence produced for another commit', () => {
    const root = fixtureRoot();
    writeValidationEvidence(root);
    const statusPath = resolve(root, 'VALIDATION_STATUS.json');
    const status = JSON.parse(readFileSync(statusPath, 'utf8'));
    status.source.commit = 'c'.repeat(40);
    writeFileSync(statusPath, JSON.stringify(status));
    const result = run(root, ['--require-validation']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('different source commit');
  });

  it('rejects package filenames from a stale application version', () => {
    const root = fixtureRoot();
    renameSync(
      resolve(root, 'release', 'VideoFactory-Desktop-9.8.7-alpha.1-x64.zip'),
      resolve(root, 'release', 'VideoFactory-Desktop-9.8.7-alpha.0-x64.zip')
    );
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('filename does not match version');
  });
});
