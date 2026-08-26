import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { validationInputDigests } from '../scripts/validation-input.mjs';
import {
  ELECTRON_PERFORMANCE_RECEIPT_PATH,
  EXTERNAL_QUALIFICATION_INDEX_PATH,
  WINDOWS_PACKAGE_RUNTIME_RECEIPT_PATH,
  writeElectronPerformanceQualificationIndex,
  writeWindowsPackageRuntimeQualificationIndex
} from '../scripts/external-qualification-evidence.mjs';

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
    '/validation/external-qualification/',
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
  const externalQualificationEvidence = { index: null, receipts: [], qualifiedIds: [] };
  const summary = {
    total: 2,
    passedLocalValidation: 1,
    qualifiedExternal: 0,
    externalPending: 1,
    productionQualified: false
  };
  const cases = [{
    id: 'AUTO-001',
    classification: 'automated',
    result: 'passed_local_validation',
    artifacts: ['tests/fixture.test.ts']
  }, {
    id: 'E2E-001',
    classification: 'external',
    result: 'external_pending',
    pendingReason: 'Representative operator evidence is required.',
    artifacts: ['docs/prd/06-ACCEPTANCE-TESTS.md']
  }];
  writeFileSync(resolve(root, 'VALIDATION_STATUS.json'), JSON.stringify({
    ...common,
    release: '9.8.7-alpha.1',
    pipeline: { status: 'passed' },
    evidence: evidenceFiles,
    externalQualificationEvidence,
    acceptance: { receipt: 'VALIDATION_ACCEPTANCE_RECEIPT.json', ...summary },
    externalQualification: [{
      id: 'E2E-001',
      status: 'pending',
      reason: 'Representative operator evidence is required.',
      artifacts: ['docs/prd/06-ACCEPTANCE-TESTS.md']
    }],
    production_ready: false
  }));
  writeFileSync(resolve(root, 'VALIDATION_ACCEPTANCE_RECEIPT.json'), JSON.stringify({
    ...common,
    appVersion: '9.8.7-alpha.1',
    evidence: evidenceFiles,
    testReports: { vitest: evidence(vitestPath), playwright: evidence(playwrightPath) },
    externalQualificationEvidence,
    summary,
    cases
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

function writeQualifiedElectronEvidence(root: string): void {
  const identity = gitIdentity(root);
  const source = {
    commit: identity.commit,
    tree: identity.tree,
    ref: 'refs/tags/v9.8.7-alpha.1',
    repository: 'fixture/video',
    workflowCommit: identity.commit,
    runId: '1',
    runAttempt: '1',
    dirty: false
  };
  const fast = [20, 22, 24, 26, 28, 30, 32, 34, 36, 38];
  const receipt = {
    schemaVersion: 1,
    generatedAt: '2026-08-26T12:00:00.000Z',
    harness: 'videofactory-electron-performance',
    mode: 'qualification',
    source,
    environment: {
      platform: 'win32', release: '10.0.26100', architecture: 'x64', node: 'v22.22.0',
      electron: '43.2.0', cpuModel: 'Qualification CPU', logicalCpuCount: 16,
      totalMemoryBytes: 32 * 1024 ** 3, ci: false, productionBuild: true,
      deviceClass: 'Windows 11 production workstation'
    },
    fixture: { requestedRows: 26_000, xlsxSha256: 'c'.repeat(64), xlsxBytes: 4_000_000 },
    measurements: {
      import: {
        previewRows: 26_000, insertedRows: 26_000, committedRows: 26_000, catalogRows: 26_000,
        integrity: 'ok', progressEvents: 20, previewObservedActive: true, commitObservedActive: true,
        previewHeartbeatGapsMs: fast, commitHeartbeatGapsMs: fast,
        previewNavigationSamplesMs: fast, commitNavigationSamplesMs: fast
      },
      startup: { usableMs: 1_900, electronLaunchMs: 1_000, rendererReadyMs: 900 },
      catalog: {
        totalRows: 26_000, domRows: 50, searchSamplesMs: fast,
        uiInteractionSamplesMs: fast, scrollFrameSamplesMs: fast,
        rendererWorkingSetKb: 180_000
      },
      backgroundRender: {
        engine: 'ffmpeg-static/libx264', workload: 'draft-1080p30-veryfast',
        resourcePolicy: 'interactive-reserve-v1', threadCount: 8,
        observedRunning: true, observedFrameProgress: true,
        elapsedMs: 8_000, heartbeatGapsMs: fast, navigationSamplesMs: fast,
        searchSamplesMs: fast, rendererWorkingSetKb: 220_000
      }
    }
  };
  mkdirSync(resolve(root, 'validation', 'results'), { recursive: true });
  writeFileSync(resolve(root, ELECTRON_PERFORMANCE_RECEIPT_PATH), `${JSON.stringify(receipt, null, 2)}\n`);
  const admitted = writeElectronPerformanceQualificationIndex({
    root,
    source,
    now: new Date('2026-08-26T12:01:00.000Z')
  });
  const projection = {
    index: admitted.index,
    receipts: admitted.receipts.map(item => ({
      kind: item.kind,
      evidence: item.evidence,
      qualifiedIds: item.qualifiedIds
    })),
    qualifiedIds: admitted.qualifiedIds
  };
  const receiptPath = resolve(root, 'VALIDATION_ACCEPTANCE_RECEIPT.json');
  const acceptance = JSON.parse(readFileSync(receiptPath, 'utf8'));
  const qualifiedCases = admitted.qualifiedIds.map(id => ({
    id,
    classification: 'external',
    result: 'passed_external_qualification',
    artifacts: [EXTERNAL_QUALIFICATION_INDEX_PATH, ELECTRON_PERFORMANCE_RECEIPT_PATH],
    externalEvidence: {
      kind: 'electron_performance',
      index: admitted.index,
      receipt: admitted.qualifiedById[id]!.evidence
    }
  }));
  const summary = {
    total: 6,
    passedLocalValidation: 1,
    qualifiedExternal: 5,
    externalPending: 0,
    productionQualified: true
  };
  acceptance.cases = [acceptance.cases[0], ...qualifiedCases];
  acceptance.summary = summary;
  acceptance.externalQualificationEvidence = projection;
  writeFileSync(receiptPath, JSON.stringify(acceptance));

  const statusPath = resolve(root, 'VALIDATION_STATUS.json');
  const status = JSON.parse(readFileSync(statusPath, 'utf8'));
  status.acceptance = { receipt: 'VALIDATION_ACCEPTANCE_RECEIPT.json', ...summary };
  status.externalQualificationEvidence = projection;
  status.externalQualification = qualifiedCases.map(item => ({
    id: item.id,
    status: 'qualified',
    artifacts: item.artifacts,
    evidence: item.externalEvidence
  }));
  status.production_ready = true;
  writeFileSync(statusPath, JSON.stringify(status));
}

function writePackageSmokeEvidence(root: string, status: 'passed' | 'failed' = 'passed'): void {
  const installerPath = resolve(root, 'release', 'VideoFactory-Desktop-9.8.7-alpha.1-x64.exe');
  const archivePath = resolve(root, 'release', 'VideoFactory-Desktop-9.8.7-alpha.1-x64.zip');
  const packageEvidence = (path: string) => ({ name: basename(path), ...evidence(path) });
  const identity = gitIdentity(root);
  const runtimeCheckNames = [
    'trayReady', 'catalogWorkerObservedActive', 'powerBlockerObservedStarted',
    'windowCloseHiddenToTray', 'processAliveAfterWindowClose',
    'catalogWorkerObservedActiveWhileHidden', 'catalogWorkerCompletedWhileHidden',
    'powerBlockerObservedStopped', 'powerBlockerCoveredWork', 'shutdownStarted',
    'shutdownCompleted', 'orderlyQuit', 'eventSequenceValid'
  ];
  const runtimeEvents = [
    ['qualification_started', { packaged: true }],
    ['tray_ready', { available: true }],
    ['power_blocker_started', { blockerId: 9, started: true, mode: 'prevent-app-suspension' }],
    ['window_hidden_to_tray', { visible: false, destroyed: false }],
    ['power_blocker_stopped', { blockerId: 9, wasStarted: true, reason: 'operation_complete' }],
    ['shutdown_started', {}],
    ['shutdown_completed', {}]
  ];
  writeFileSync(resolve(root, 'release', 'WINDOWS_PACKAGE_SMOKE.json'), JSON.stringify({
    receiptVersion: 3,
    status,
    generatedAt: '2026-08-26T12:00:00.000Z',
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
    runner: { platform: 'win32', architecture: 'x64' },
    qualification: {
      validation: 'release',
      scope: 'hosted_windows_package_smoke',
      cleanMachine: false,
      developerToolingPresent: true,
      productionQualification: false,
      windowsRuntimeLifecycle: { status: 'passed', qualifiedGateIds: ['SYS-005', 'SYS-006'] }
    },
    packages: {
      installer: packageEvidence(installerPath),
      archive: packageEvidence(archivePath)
    },
    checks: {
      archiveLaunch: { status },
      installerInstall: { status },
      installedLaunch: {
        status,
        kind: 'installed',
        app: { isPackaged: true },
        lifecycle: { orderlyQuit: true },
        runtimeQualification: {
          schemaVersion: 1,
          status: 'passed',
          workload: {
            kind: 'catalog_preview', operationId: 'runtime', source: 'catalog.xlsx',
            sourceSizeBytes: 100, requestedRows: 26_000, completedRows: 26_000
          },
          checks: Object.fromEntries(runtimeCheckNames.map(name => [name, true])),
          events: runtimeEvents.map(([event, details], index) => ({
            schemaVersion: 1, sequence: index + 1,
            at: new Date(Date.parse('2026-08-26T12:00:01.000Z') + index * 100).toISOString(),
            event, pid: 10, details
          }))
        }
      },
      uninstall: { status }
    }
  }));
}

function writeQualifiedWindowsEvidence(root: string): void {
  const identity = gitIdentity(root);
  const source = {
    commit: identity.commit,
    tree: identity.tree,
    ref: 'refs/tags/v9.8.7-alpha.1',
    repository: 'fixture/video',
    workflowCommit: identity.commit,
    runId: '1',
    runAttempt: '1',
    dirty: false
  };
  const admitted = writeWindowsPackageRuntimeQualificationIndex({
    root,
    source,
    now: new Date('2026-08-26T12:02:00.000Z')
  });
  const projection = {
    index: admitted.index,
    receipts: admitted.receipts.map(item => ({
      kind: item.kind,
      evidence: item.evidence,
      qualifiedIds: item.qualifiedIds
    })),
    qualifiedIds: admitted.qualifiedIds
  };
  const acceptancePath = resolve(root, 'VALIDATION_ACCEPTANCE_RECEIPT.json');
  const acceptance = JSON.parse(readFileSync(acceptancePath, 'utf8'));
  const windowsCases = ['SYS-005', 'SYS-006'].map(id => ({
    id,
    classification: 'external',
    result: 'passed_external_qualification',
    artifacts: [EXTERNAL_QUALIFICATION_INDEX_PATH, WINDOWS_PACKAGE_RUNTIME_RECEIPT_PATH],
    externalEvidence: {
      kind: 'windows_package_runtime',
      index: admitted.index,
      receipt: admitted.qualifiedById[id]!.evidence
    }
  }));
  const summary = {
    total: acceptance.cases.length + windowsCases.length,
    passedLocalValidation: 1,
    qualifiedExternal: admitted.qualifiedIds.length,
    externalPending: 0,
    productionQualified: true
  };
  acceptance.cases.push(...windowsCases);
  acceptance.summary = summary;
  acceptance.externalQualificationEvidence = projection;
  writeFileSync(acceptancePath, JSON.stringify(acceptance));

  const statusPath = resolve(root, 'VALIDATION_STATUS.json');
  const status = JSON.parse(readFileSync(statusPath, 'utf8'));
  status.acceptance = { receipt: 'VALIDATION_ACCEPTANCE_RECEIPT.json', ...summary };
  status.externalQualificationEvidence = projection;
  status.externalQualification.push(...windowsCases.map(item => ({
    id: item.id,
    status: 'qualified',
    artifacts: item.artifacts,
    evidence: item.externalEvidence
  })));
  writeFileSync(statusPath, JSON.stringify(status));
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

  it('rejects a production-ready boolean that does not reconcile with pending acceptance gates', () => {
    const root = fixtureRoot();
    writeValidationEvidence(root);
    const statusPath = resolve(root, 'VALIDATION_STATUS.json');
    const status = JSON.parse(readFileSync(statusPath, 'utf8'));
    status.production_ready = true;
    writeFileSync(statusPath, JSON.stringify(status));
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not reconcile with pending acceptance gates');
  });

  it('admits a production-ready claim only with re-verifiable exact-source external attachments', () => {
    const root = fixtureRoot();
    writeValidationEvidence(root);
    writeQualifiedElectronEvidence(root);
    expect(run(root).status).toBe(0);
    expect(run(root, ['--verify']).status).toBe(0);
    const manifest = JSON.parse(readFileSync(resolve(root, 'release', 'RELEASE_PROVENANCE.json'), 'utf8'));
    expect(manifest.validation.production_ready).toBe(true);
    expect(manifest.artifacts.map((item: { name: string }) => item.name)).toEqual(expect.arrayContaining([
      'EXTERNAL_QUALIFICATION_INDEX.json',
      'EXTERNAL_ELECTRON_PERFORMANCE.json'
    ]));
  });

  it('re-admits independent Electron and Windows runtime receipts in one release', () => {
    const root = fixtureRoot();
    writeValidationEvidence(root);
    writeQualifiedElectronEvidence(root);
    writePackageSmokeEvidence(root);
    writeQualifiedWindowsEvidence(root);
    expect(run(root, ['--require-package-smoke']).status).toBe(0);
    expect(run(root, ['--verify']).status).toBe(0);
    const manifest = JSON.parse(readFileSync(resolve(root, 'release', 'RELEASE_PROVENANCE.json'), 'utf8'));
    expect(manifest.validation.externalQualificationEvidence.receipts.map(
      (item: { kind: string }) => item.kind
    )).toEqual(['electron_performance', 'windows_package_runtime']);
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
    expect(manifest.windowsPackageSmoke.receiptVersion).toBe(3);
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
