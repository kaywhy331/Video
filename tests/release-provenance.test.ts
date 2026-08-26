import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { validationInputDigests } from '../scripts/validation-input.mjs';

const repositoryRoot = process.cwd();
const script = resolve(repositoryRoot, 'scripts', 'generate-release-manifest.mjs');
const roots: string[] = [];

type EvidenceOptions = {
  qualification?: 'development' | 'release';
  commit?: string;
  tree?: string;
  dirty?: boolean;
  ref?: string;
};

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'videofactory-release-manifest-'));
  roots.push(root);
  mkdirSync(resolve(root, 'release'));
  mkdirSync(resolve(root, 'validation', 'results'), { recursive: true });
  writeFileSync(resolve(root, '.gitignore'), [
    '/release/',
    '/validation/results/',
    '/VALIDATION_STATUS.json',
    '/VALIDATION_ACCEPTANCE_RECEIPT.json',
    ''
  ].join('\n'));
  writeFileSync(resolve(root, 'package.json'), JSON.stringify({ version: '9.8.7-alpha.1' }));
  runGit(root, ['init', '--initial-branch=main']);
  runGit(root, ['config', 'user.email', 'release@example.invalid']);
  runGit(root, ['config', 'user.name', 'Release Fixture']);
  runGit(root, ['add', '.gitignore', 'package.json']);
  runGit(root, ['commit', '-m', 'fixture']);
  writeFileSync(resolve(root, 'release', 'VideoFactory-Desktop-9.8.7-alpha.1-x64.exe'), 'installer');
  writeFileSync(resolve(root, 'release', 'VideoFactory-Desktop-9.8.7-alpha.1-x64.zip'), 'archive');
  return root;
}

function runGit(root: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function gitIdentity(root: string) {
  return {
    commit: runGit(root, ['rev-parse', 'HEAD^{commit}']),
    tree: runGit(root, ['rev-parse', 'HEAD^{tree}'])
  };
}

function run(root: string, args: string[] = [], environment: Record<string, string> = {}) {
  const identity = gitIdentity(root);
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    env: {
      ...process.env,
      GITHUB_REF_TYPE: 'tag',
      GITHUB_REF_NAME: 'v9.8.7-alpha.1',
      GITHUB_REF: 'refs/tags/v9.8.7-alpha.1',
      GITHUB_REPOSITORY: 'fixture/video',
      GITHUB_RUN_ID: '1',
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_SHA: identity.commit,
      ...environment
    },
    encoding: 'utf8'
  });
}

function writeValidationEvidence(root: string, options: EvidenceOptions = {}): void {
  const identity = gitIdentity(root);
  const qualification = options.qualification ?? 'release';
  const source = {
    commit: options.commit ?? identity.commit,
    tree: options.tree ?? identity.tree,
    ref: options.ref ?? 'refs/tags/v9.8.7-alpha.1',
    repository: 'fixture/video',
    workflowCommit: options.commit ?? identity.commit,
    runId: '1',
    runAttempt: '1',
    dirty: options.dirty ?? false
  };
  const inputs = validationInputDigests(root);
  const results = resolve(root, 'validation', 'results');
  const runtimePath = resolve(results, 'runtime-input.json');
  const claimsPath = resolve(results, 'claims-input.json');
  const pipelinePath = resolve(results, 'pipeline.json');
  const vitestPath = resolve(results, 'vitest.json');
  const playwrightPath = resolve(results, 'playwright.json');
  const sbomPath = resolve(results, 'videofactory-sbom.cdx.json');

  writeFileSync(runtimePath, JSON.stringify(inputManifest('runtime', inputs.runtime, qualification, source)));
  writeFileSync(claimsPath, JSON.stringify(inputManifest('claims', inputs.claims, qualification, source)));
  const inputManifests = {
    runtime: evidence(runtimePath),
    claims: evidence(claimsPath)
  };
  const common = {
    qualification,
    runtimeInputSha256: inputs.runtime.sha256,
    runtimeInputFileCount: inputs.runtime.fileCount,
    claimsInputSha256: inputs.claims.sha256,
    claimsInputFileCount: inputs.claims.fileCount,
    inputManifests,
    source
  };
  writeFileSync(pipelinePath, JSON.stringify({
    ...common,
    completed: true,
    environment: { platform: 'linux', architecture: 'x64', node: process.version, npm: '10.0.0' },
    stages: [
      'release_evidence',
      'typecheck',
      'vitest',
      'build',
      'electron_e2e',
      'security_audit',
      'sbom'
    ].map(name => ({ name, status: 'passed', exitCode: 0 }))
  }));
  writeFileSync(vitestPath, JSON.stringify({ success: true }));
  writeFileSync(playwrightPath, JSON.stringify({ stats: { expected: 1 } }));
  writeFileSync(sbomPath, JSON.stringify({
    bomFormat: 'CycloneDX',
    metadata: { component: { version: '9.8.7-alpha.1' } }
  }));

  const evidenceFiles = {
    pipeline: evidence(pipelinePath),
    sbom: evidence(sbomPath),
    runtimeInput: evidence(runtimePath),
    claimsInput: evidence(claimsPath)
  };
  writeFileSync(resolve(root, 'VALIDATION_STATUS.json'), JSON.stringify({
    ...common,
    release: '9.8.7-alpha.1',
    pipeline: { status: 'passed' },
    evidence: evidenceFiles,
    production_ready: false
  }));
  writeFileSync(resolve(root, 'VALIDATION_ACCEPTANCE_RECEIPT.json'), JSON.stringify({
    ...common,
    appVersion: '9.8.7-alpha.1',
    evidence: evidenceFiles,
    testReports: { vitest: evidence(vitestPath), playwright: evidence(playwrightPath) }
  }));
}

function inputManifest(
  kind: 'claims' | 'runtime',
  digest: ReturnType<typeof validationInputDigests>['runtime'],
  qualification: 'development' | 'release',
  source: Record<string, unknown>
) {
  return {
    manifestVersion: 1,
    kind,
    qualification,
    source,
    sha256: digest.sha256,
    fileCount: digest.fileCount,
    files: digest.files
  };
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
  const identity = gitIdentity(root);
  writeFileSync(resolve(root, 'release', 'WINDOWS_PACKAGE_SMOKE.json'), JSON.stringify({
    receiptVersion: 2,
    status,
    appVersion: '9.8.7-alpha.1',
    source: {
      commit: identity.commit,
      tree: identity.tree,
      ref: 'refs/tags/v9.8.7-alpha.1',
      repository: 'fixture/video',
      workflowCommit: identity.commit,
      runId: '1',
      runAttempt: '1',
      dirty: false
    },
    runner: { platform: 'win32' },
    qualification: { validation: 'release' },
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

  it('requires release-qualified validation evidence for every manifest', () => {
    const root = fixtureRoot();
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('requires validation evidence');
  });

  it('[REL-004] writes and verifies exact hashes plus runtime and claims provenance', () => {
    const root = fixtureRoot();
    writeValidationEvidence(root);
    expect(run(root).status).toBe(0);
    expect(run(root, ['--verify']).status).toBe(0);
    const manifest = JSON.parse(readFileSync(resolve(root, 'release', 'RELEASE_PROVENANCE.json'), 'utf8'));
    expect(manifest.manifestVersion).toBe(2);
    expect(manifest.appVersion).toBe('9.8.7-alpha.1');
    expect(manifest.qualification).toBe('release');
    expect(manifest.source.dirty).toBe(false);
    expect(manifest.source.tree).toMatch(/^[a-f0-9]{40}$/);
    expect(manifest.inputs.runtime.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.inputs.claims.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.inputs.runtime.sourceCommit).toBe(manifest.source.commit);
    expect(manifest.inputs.claims.sourceCommit).toBe(manifest.source.commit);
  });

  it('fails verification after a published artifact changes', () => {
    const root = fixtureRoot();
    writeValidationEvidence(root);
    expect(run(root).status).toBe(0);
    writeFileSync(resolve(root, 'release', 'VideoFactory-Desktop-9.8.7-alpha.1-x64.zip'), 'tampered');
    const result = run(root, ['--verify']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('failed integrity verification');
  });

  it('rejects an unlisted artifact added after manifest generation', () => {
    const root = fixtureRoot();
    writeValidationEvidence(root);
    expect(run(root).status).toBe(0);
    writeFileSync(resolve(root, 'release', 'unexpected.json'), '{}');
    const result = run(root, ['--verify']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('inventory does not exactly match');
  });

  it('rejects missing packaged Windows smoke evidence when requested', () => {
    const root = fixtureRoot();
    writeValidationEvidence(root);
    const result = run(root, ['--require-package-smoke']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('requires WINDOWS_PACKAGE_SMOKE.json');
  });

  it('rejects a failed packaged Windows smoke receipt', () => {
    const root = fixtureRoot();
    writeValidationEvidence(root);
    writePackageSmokeEvidence(root, 'failed');
    const result = run(root, ['--require-package-smoke']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('package smoke test did not pass');
  });

  it('records exact source- and artifact-bound packaged Windows smoke evidence', () => {
    const root = fixtureRoot();
    writeValidationEvidence(root);
    writePackageSmokeEvidence(root);
    expect(run(root, ['--require-package-smoke']).status).toBe(0);
    expect(run(root, ['--verify']).status).toBe(0);
    const manifest = JSON.parse(readFileSync(resolve(root, 'release', 'RELEASE_PROVENANCE.json'), 'utf8'));
    expect(manifest.windowsPackageSmoke.receiptVersion).toBe(2);
    expect(manifest.windowsPackageSmoke.source.tree).toBe(manifest.source.tree);
    expect(manifest.windowsPackageSmoke.checks.uninstall.status).toBe('passed');
  });

  it('records branch builds without claiming a release tag', () => {
    const root = fixtureRoot();
    writeValidationEvidence(root, { ref: 'refs/heads/main' });
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
    writeValidationEvidence(root);
    const result = run(root, [], { GITHUB_REF_NAME: 'v9.8.7-alpha.2' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not match package version');
  });

  it('rejects package filenames that hosted release uploads would normalize', () => {
    const root = fixtureRoot();
    writeValidationEvidence(root);
    renameSync(
      resolve(root, 'release', 'VideoFactory-Desktop-9.8.7-alpha.1-x64.zip'),
      resolve(root, 'release', 'VideoFactory Desktop-9.8.7-alpha.1-x64.zip')
    );
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('filename is not upload-safe');
  });

  it('[REL-002] rejects stale commit, tree, dirty, development, and mismatched-digest evidence', () => {
    const staleCommit = fixtureRoot();
    writeValidationEvidence(staleCommit, { commit: 'c'.repeat(40) });
    expect(run(staleCommit).stderr).toContain('different source commit');

    const staleTree = fixtureRoot();
    writeValidationEvidence(staleTree, { tree: 'd'.repeat(40) });
    expect(run(staleTree).stderr).toContain('different source tree');

    const dirty = fixtureRoot();
    writeValidationEvidence(dirty, { dirty: true });
    expect(run(dirty).stderr).toContain('requires a clean source worktree');

    const development = fixtureRoot();
    writeValidationEvidence(development, { qualification: 'development' });
    expect(run(development).stderr).toContain('development evidence');

    const mismatched = fixtureRoot();
    writeValidationEvidence(mismatched);
    const receiptPath = resolve(mismatched, 'VALIDATION_ACCEPTANCE_RECEIPT.json');
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    receipt.claimsInputSha256 = 'e'.repeat(64);
    writeFileSync(receiptPath, JSON.stringify(receipt));
    expect(run(mismatched).stderr).toContain('different claims input digest');
  });

  it('rejects package filenames from a stale application version', () => {
    const root = fixtureRoot();
    writeValidationEvidence(root);
    renameSync(
      resolve(root, 'release', 'VideoFactory-Desktop-9.8.7-alpha.1-x64.zip'),
      resolve(root, 'release', 'VideoFactory-Desktop-9.8.7-alpha.0-x64.zip')
    );
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('filename does not match version');
  });
});
