import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { arch, platform, release as operatingSystemRelease } from 'node:os';
import { basename, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const releaseDirectory = resolve(root, 'release');
const manifestPath = resolve(releaseDirectory, 'RELEASE_PROVENANCE.json');
const checksumsPath = resolve(releaseDirectory, 'SHA256SUMS.txt');
const verify = process.argv.includes('--verify');
const requirePackageSmoke = process.argv.includes('--require-package-smoke');
const requireValidation = process.argv.includes('--require-validation');

function sha256File(path) {
  const hash = createHash('sha256');
  hash.update(readFileSync(path));
  return hash.digest('hex');
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

function relevantFiles() {
  if (!existsSync(releaseDirectory)) throw new Error('The release directory does not exist.');
  return readdirSync(releaseDirectory, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => resolve(releaseDirectory, entry.name))
    .filter(path => path !== manifestPath && path !== checksumsPath)
    .filter(path => /\.(?:exe|zip|json)$/i.test(path))
    .sort((left, right) => basename(left).localeCompare(basename(right)));
}

function assertUploadSafeArtifactName(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new Error(`Release artifact filename is not upload-safe: ${name}`);
  }
}

function record(path) {
  const name = basename(path);
  assertUploadSafeArtifactName(name);
  return { name, sizeBytes: statSync(path).size, sha256: sha256File(path) };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function assertArtifactRecord(artifact) {
  if (!artifact || typeof artifact.name !== 'string' || artifact.name !== basename(artifact.name)) {
    throw new Error('Release manifest contains an invalid artifact name.');
  }
  assertUploadSafeArtifactName(artifact.name);
  if (!Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 0) {
    throw new Error(`Release manifest contains an invalid size for ${artifact.name}.`);
  }
  if (!/^[a-f0-9]{64}$/i.test(String(artifact.sha256 ?? ''))) {
    throw new Error(`Release manifest contains an invalid SHA-256 for ${artifact.name}.`);
  }
}

function assertEvidenceFile(evidence, path, label) {
  if (!evidence || !existsSync(path)) {
    throw new Error(`Attached validation evidence is missing ${label}.`);
  }
  if (evidence.sizeBytes !== statSync(path).size || evidence.sha256 !== sha256File(path)) {
    throw new Error(`Attached validation evidence failed integrity verification: ${label}.`);
  }
}

function verifyManifest() {
  if (!existsSync(manifestPath) || !existsSync(checksumsPath)) {
    throw new Error('RELEASE_PROVENANCE.json and SHA256SUMS.txt are required.');
  }
  const manifest = readJson(manifestPath);
  const packageJson = readJson(resolve(root, 'package.json'));
  if (manifest.appVersion !== packageJson.version) {
    throw new Error(`Manifest version ${manifest.appVersion} does not match package version ${packageJson.version}.`);
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    throw new Error('Release manifest contains no artifacts.');
  }
  for (const artifact of manifest.artifacts) assertArtifactRecord(artifact);
  const listedNames = manifest.artifacts.map(artifact => artifact.name);
  if (new Set(listedNames).size !== listedNames.length) {
    throw new Error('Release manifest contains duplicate artifact names.');
  }
  const currentNames = relevantFiles().map(path => basename(path));
  if ([...listedNames].sort((left, right) => left.localeCompare(right)).join('\n') !== currentNames.join('\n')) {
    throw new Error('Release directory inventory does not exactly match the release manifest.');
  }
  for (const artifact of manifest.artifacts) {
    const path = resolve(releaseDirectory, artifact.name);
    if (!existsSync(path)) throw new Error(`Manifest artifact is missing: ${artifact.name}`);
    if (statSync(path).size !== artifact.sizeBytes || sha256File(path) !== artifact.sha256) {
      throw new Error(`Manifest artifact failed integrity verification: ${artifact.name}`);
    }
  }
  const expected = [...(manifest.artifacts ?? []), record(manifestPath)]
    .map(artifact => `${artifact.sha256}  ${artifact.name}`)
    .join('\n') + '\n';
  if (readFileSync(checksumsPath, 'utf8') !== expected) {
    throw new Error('SHA256SUMS.txt does not exactly match the release manifest.');
  }
  console.log(`Verified ${manifest.artifacts.length} release artifacts for ${manifest.appVersion}.`);
}

if (verify) {
  verifyManifest();
  process.exit(0);
}

const packageJson = readJson(resolve(root, 'package.json'));
const expectedTag = `v${packageJson.version}`;
const githubRefType = process.env.GITHUB_REF_TYPE ?? null;
const githubRefName = process.env.GITHUB_REF_NAME ?? null;
const tag = githubRefType === 'tag'
  ? githubRefName
  : githubRefType
    ? null
    : process.env.RELEASE_TAG ?? expectedTag;
if (githubRefType === 'tag' && !tag) {
  throw new Error('A tag-triggered release requires GITHUB_REF_NAME.');
}
if (tag && tag !== expectedTag) {
  throw new Error(`Release tag ${tag} does not match package version v${packageJson.version}.`);
}

const signaturePath = resolve(releaseDirectory, 'WINDOWS_SIGNATURES.json');
const smokePath = resolve(releaseDirectory, 'WINDOWS_PACKAGE_SMOKE.json');
const statusPath = resolve(releaseDirectory, 'VALIDATION_STATUS.json');
const receiptPath = resolve(releaseDirectory, 'VALIDATION_ACCEPTANCE_RECEIPT.json');
const sbomPath = resolve(releaseDirectory, 'videofactory-sbom.cdx.json');
const sourceCommit = process.env.GITHUB_SHA ?? commandOutput('git', ['rev-parse', 'HEAD']);
if (!/^[a-f0-9]{40}$/i.test(sourceCommit)) {
  throw new Error('Release provenance requires an exact 40-character source commit.');
}
const requiredEvidence = [statusPath, receiptPath, sbomPath];
if (requireValidation) {
  const evidenceCopies = [
    [resolve(root, 'VALIDATION_STATUS.json'), statusPath],
    [resolve(root, 'VALIDATION_ACCEPTANCE_RECEIPT.json'), receiptPath],
    [resolve(root, 'validation', 'results', 'pipeline.json'), resolve(releaseDirectory, 'VALIDATION_PIPELINE.json')],
    [resolve(root, 'validation', 'results', 'vitest.json'), resolve(releaseDirectory, 'VITEST_RESULTS.json')],
    [resolve(root, 'validation', 'results', 'playwright.json'), resolve(releaseDirectory, 'PLAYWRIGHT_RESULTS.json')],
    [resolve(root, 'validation', 'results', 'videofactory-sbom.cdx.json'), sbomPath]
  ];
  for (const [source, destination] of evidenceCopies) {
    if (!existsSync(destination) && existsSync(source)) copyFileSync(source, destination);
  }
  const missing = requiredEvidence.filter(path => !existsSync(path)).map(path => basename(path));
  if (missing.length > 0) {
    throw new Error(`Release provenance requires validation evidence: ${missing.join(', ')}.`);
  }
}
const validation = existsSync(statusPath) ? readJson(statusPath) : null;
const acceptanceReceipt = existsSync(receiptPath) ? readJson(receiptPath) : null;
const sbom = existsSync(sbomPath) ? readJson(sbomPath) : null;
if (validation && (validation.release !== packageJson.version || validation.pipeline?.status !== 'passed')) {
  throw new Error('Attached validation status is stale or did not pass.');
}
if (acceptanceReceipt && acceptanceReceipt.appVersion !== packageJson.version) {
  throw new Error('Attached acceptance receipt does not match the package version.');
}
if (sbom && (sbom.bomFormat !== 'CycloneDX' || sbom.metadata?.component?.version !== packageJson.version)) {
  throw new Error('Attached SBOM is invalid or does not match the package version.');
}
if (validation && validation.source?.commit !== sourceCommit) {
  throw new Error('Attached validation status was produced for a different source commit.');
}
if (acceptanceReceipt && acceptanceReceipt.source?.commit !== sourceCommit) {
  throw new Error('Attached acceptance receipt was produced for a different source commit.');
}
if (validation && acceptanceReceipt && validation.validationInputSha256 !== acceptanceReceipt.validationInputSha256) {
  throw new Error('Attached validation status and acceptance receipt describe different validation inputs.');
}
if (requireValidation) {
  const pipelineEvidencePath = resolve(releaseDirectory, 'VALIDATION_PIPELINE.json');
  const vitestEvidencePath = resolve(releaseDirectory, 'VITEST_RESULTS.json');
  const playwrightEvidencePath = resolve(releaseDirectory, 'PLAYWRIGHT_RESULTS.json');
  assertEvidenceFile(validation.evidence?.pipeline, pipelineEvidencePath, 'validation pipeline');
  assertEvidenceFile(validation.evidence?.sbom, sbomPath, 'SBOM status evidence');
  assertEvidenceFile(acceptanceReceipt.evidence?.pipeline, pipelineEvidencePath, 'acceptance pipeline evidence');
  assertEvidenceFile(acceptanceReceipt.evidence?.sbom, sbomPath, 'acceptance SBOM evidence');
  assertEvidenceFile(acceptanceReceipt.testReports?.vitest, vitestEvidencePath, 'Vitest report');
  assertEvidenceFile(acceptanceReceipt.testReports?.playwright, playwrightEvidencePath, 'Playwright report');
}
if (requirePackageSmoke && !existsSync(smokePath)) {
  throw new Error('Release provenance requires WINDOWS_PACKAGE_SMOKE.json.');
}
const artifacts = relevantFiles().map(record);
if (!artifacts.some(artifact => artifact.name.endsWith('.exe')) || !artifacts.some(artifact => artifact.name.endsWith('.zip'))) {
  throw new Error('Release provenance requires both a Windows installer and ZIP archive.');
}
for (const artifact of artifacts.filter(item => /\.(?:exe|zip)$/i.test(item.name))) {
  if (!artifact.name.includes(`-${packageJson.version}-`)) {
    throw new Error(`Release package filename does not match version ${packageJson.version}: ${artifact.name}`);
  }
}
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const manifest = {
  manifestVersion: 1,
  generatedAt: new Date().toISOString(),
  appVersion: packageJson.version,
  tag,
  source: {
    commit: sourceCommit,
    ref: process.env.GITHUB_REF ?? githubRefName ?? null,
    repository: process.env.GITHUB_REPOSITORY ?? null,
    workflow: process.env.GITHUB_WORKFLOW_REF ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    dirty: commandOutput('git', ['status', '--porcelain']).length > 0
  },
  environment: {
    platform: platform(),
    release: operatingSystemRelease(),
    architecture: arch(),
    node: process.version,
    npm: commandOutput(npmCommand, ['--version'])
  },
  signing: existsSync(signaturePath) ? readJson(signaturePath) : { status: 'not_checked' },
  windowsPackageSmoke: existsSync(smokePath) ? readJson(smokePath) : null,
  validation,
  artifacts
};
if (requirePackageSmoke && manifest.windowsPackageSmoke?.status !== 'passed') {
  throw new Error('The installed Windows package smoke test did not pass.');
}
if (!packageJson.version.includes('-') && manifest.signing?.status !== 'signed') {
  throw new Error('Stable releases require a valid Authenticode signature report.');
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
const checksums = [...artifacts, record(manifestPath)]
  .map(artifact => `${artifact.sha256}  ${artifact.name}`)
  .join('\n') + '\n';
writeFileSync(checksumsPath, checksums);
console.log(`Release manifest written for ${artifacts.length} artifacts: ${manifestPath}`);
