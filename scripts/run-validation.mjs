import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { arch, platform, release as operatingSystemRelease } from 'node:os';
import { relative, resolve } from 'node:path';
import { validationInputDigests } from './validation-input.mjs';
import {
  admitValidationSource,
  assertValidationSourceStable,
  parseValidationQualification
} from './validation-source.mjs';

const root = process.cwd();
const qualification = parseValidationQualification();

// Admission and input capture deliberately happen before generated evidence is touched.
const admission = admitValidationSource({ root, qualification });
const input = validationInputDigests(root);

const resultsDirectory = resolve(root, 'validation', 'results');
const pipelinePath = resolve(resultsDirectory, 'pipeline.json');
const runtimeInputPath = resolve(resultsDirectory, 'runtime-input.json');
const claimsInputPath = resolve(resultsDirectory, 'claims-input.json');
const receiptPath = resolve(root, 'VALIDATION_ACCEPTANCE_RECEIPT.json');
const statusPath = resolve(root, 'VALIDATION_STATUS.json');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const environment = {
  platform: platform(),
  release: operatingSystemRelease(),
  architecture: arch(),
  node: process.version,
  npm: commandOutput(npmCommand, ['--version'])
};

mkdirSync(resultsDirectory, { recursive: true });
for (const name of [
  'pipeline.json',
  'runtime-input.json',
  'claims-input.json',
  'vitest.json',
  'playwright.json',
  'videofactory-sbom.cdx.json'
]) {
  rmSync(resolve(resultsDirectory, name), { force: true });
}
rmSync(receiptPath, { force: true });
rmSync(statusPath, { force: true });
rmSync(resolve(root, 'release', 'videofactory-sbom.cdx.json'), { force: true });

const stages = [
  { name: 'release_evidence', command: npmCommand, args: ['run', 'validate:release-evidence'] },
  { name: 'typecheck', command: npmCommand, args: ['run', 'typecheck'] },
  { name: 'vitest', command: npmCommand, args: ['run', 'test'] },
  { name: 'build', command: npmCommand, args: ['run', 'build'] },
  { name: 'electron_e2e', command: process.execPath, args: ['scripts/run-electron-e2e.mjs'] },
  { name: 'security_audit', command: npmCommand, args: ['run', 'security:audit'] },
  { name: 'sbom', command: npmCommand, args: ['run', 'security:sbom'] }
];
const startedAt = new Date().toISOString();
const results = [];
writeInputManifest(runtimeInputPath, 'runtime', input.runtime);
writeInputManifest(claimsInputPath, 'claims', input.claims);
writeStatus('running');

for (const stage of stages) {
  const stageStartedAt = new Date().toISOString();
  const result = spawnSync(stage.command, stage.args, { cwd: root, stdio: 'inherit' });
  results.push({
    name: stage.name,
    command: [stage.command, ...stage.args].join(' '),
    startedAt: stageStartedAt,
    completedAt: new Date().toISOString(),
    status: result.status === 0 && !result.error ? 'passed' : 'failed',
    exitCode: result.status ?? null,
    ...(result.error ? { error: result.error.message } : {})
  });
  if (result.status !== 0 || result.error) {
    writePipeline(false);
    writeStatus('failed', result.error?.message ?? `Stage ${stage.name} exited with ${result.status ?? 'no status'}.`);
    if (result.error) console.error(result.error.message);
    process.exit(result.status ?? 1);
  }
}

try {
  assertCompletionStable();
} catch (error) {
  recordStabilityFailure(error);
  process.exit(1);
}

writePipeline(true);
const receipt = spawnSync(process.execPath, [
  'scripts/validate-acceptance.mjs',
  '--record-validated'
], { cwd: root, stdio: 'inherit' });
if (receipt.error) console.error(receipt.error.message);
if (receipt.status !== 0 || receipt.error) {
  writeStatus(
    'failed',
    receipt.error?.message ?? `Acceptance receipt validation exited with ${receipt.status ?? 'no status'}.`
  );
  process.exit(receipt.status ?? 1);
}
try {
  assertCompletionStable();
} catch (error) {
  rmSync(receiptPath, { force: true });
  recordStabilityFailure(error);
  process.exit(1);
}
process.exit(0);

function writePipeline(completed) {
  const payload = {
    generatedAt: new Date().toISOString(),
    admittedAt: admission.admittedAt,
    qualification,
    runtimeInputSha256: input.runtime.sha256,
    runtimeInputFileCount: input.runtime.fileCount,
    claimsInputSha256: input.claims.sha256,
    claimsInputFileCount: input.claims.fileCount,
    inputManifests: {
      runtime: fileEvidence(runtimeInputPath),
      claims: fileEvidence(claimsInputPath)
    },
    startedAt,
    completed,
    source: admission.source,
    environment,
    stages: results
  };
  writeJsonAtomic(pipelinePath, payload);
}

function writeStatus(status, error) {
  const payload = {
    generatedAt: new Date().toISOString(),
    admittedAt: admission.admittedAt,
    release: packageJson.version,
    qualification,
    runtimeInputSha256: input.runtime.sha256,
    runtimeInputFileCount: input.runtime.fileCount,
    claimsInputSha256: input.claims.sha256,
    claimsInputFileCount: input.claims.fileCount,
    inputManifests: {
      runtime: fileEvidence(runtimeInputPath),
      claims: fileEvidence(claimsInputPath)
    },
    source: admission.source,
    environment,
    pipeline: {
      status,
      report: 'validation/results/pipeline.json',
      stages: results.map(stage => ({
        name: stage.name,
        status: stage.status,
        exitCode: stage.exitCode,
        completedAt: stage.completedAt
      })),
      ...(error ? { error } : {})
    },
    acceptance: {
      receipt: null,
      status: status === 'failed' ? 'not_recorded_due_to_failed_pipeline' : 'pending'
    },
    production_ready: false
  };
  writeJsonAtomic(statusPath, payload);
}

function writeInputManifest(path, kind, digest) {
  writeJsonAtomic(path, {
    manifestVersion: 1,
    generatedAt: startedAt,
    kind,
    qualification,
    source: admission.source,
    sha256: digest.sha256,
    fileCount: digest.fileCount,
    files: digest.files
  });
}

function assertDigestStable(label, admitted, completed) {
  if (completed.sha256 !== admitted.sha256 || completed.fileCount !== admitted.fileCount) {
    throw new Error(`Validation ${label} inputs changed while the pipeline was running.`);
  }
}

function assertCompletionStable() {
  const completedInput = validationInputDigests(root);
  assertDigestStable('runtime', input.runtime, completedInput.runtime);
  assertDigestStable('claims', input.claims, completedInput.claims);
  assertValidationSourceStable(admission, { root });
}

function recordStabilityFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  results.push({
    name: 'source_and_input_stability',
    command: 'validation source and input comparison',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    status: 'failed',
    exitCode: 1,
    error: message
  });
  writePipeline(false);
  writeStatus('failed', message);
  console.error(message);
}

function fileEvidence(path) {
  return {
    path: relative(root, path).replaceAll('\\', '/'),
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    sizeBytes: statSync(path).size
  };
}

function writeJsonAtomic(path, value) {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}
