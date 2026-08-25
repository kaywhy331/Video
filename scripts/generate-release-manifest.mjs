import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { arch, platform, release as operatingSystemRelease } from 'node:os';
import { basename, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validationInputDigests } from './validation-input.mjs';
import {
  assertCompletedValidationPipeline,
  assertInputManifest,
  assertMatchingValidationEvidence,
  assertValidationEvidenceDocument
} from './validation-evidence.mjs';
import { admitValidationSource, assertValidationSource } from './validation-source.mjs';

const root = process.cwd();
const releaseDirectory = resolve(root, 'release');
const manifestPath = resolve(releaseDirectory, 'RELEASE_PROVENANCE.json');
const checksumsPath = resolve(releaseDirectory, 'SHA256SUMS.txt');
const signaturePath = resolve(releaseDirectory, 'WINDOWS_SIGNATURES.json');
const smokePath = resolve(releaseDirectory, 'WINDOWS_PACKAGE_SMOKE.json');
const statusPath = resolve(releaseDirectory, 'VALIDATION_STATUS.json');
const receiptPath = resolve(releaseDirectory, 'VALIDATION_ACCEPTANCE_RECEIPT.json');
const pipelinePath = resolve(releaseDirectory, 'VALIDATION_PIPELINE.json');
const runtimeInputPath = resolve(releaseDirectory, 'RUNTIME_INPUTS.json');
const claimsInputPath = resolve(releaseDirectory, 'CLAIMS_INPUTS.json');
const vitestPath = resolve(releaseDirectory, 'VITEST_RESULTS.json');
const playwrightPath = resolve(releaseDirectory, 'PLAYWRIGHT_RESULTS.json');
const sbomPath = resolve(releaseDirectory, 'videofactory-sbom.cdx.json');
const verify = process.argv.includes('--verify');
const requirePackageSmoke = process.argv.includes('--require-package-smoke');

const requiredValidationPaths = [
  statusPath,
  receiptPath,
  pipelinePath,
  runtimeInputPath,
  claimsInputPath,
  vitestPath,
  playwrightPath,
  sbomPath
];

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
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
    .sort((left, right) => compareNames(basename(left), basename(right)));
}

function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
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

function copyAvailableValidationEvidence() {
  const copies = [
    [resolve(root, 'VALIDATION_STATUS.json'), statusPath],
    [resolve(root, 'VALIDATION_ACCEPTANCE_RECEIPT.json'), receiptPath],
    [resolve(root, 'validation', 'results', 'pipeline.json'), pipelinePath],
    [resolve(root, 'validation', 'results', 'runtime-input.json'), runtimeInputPath],
    [resolve(root, 'validation', 'results', 'claims-input.json'), claimsInputPath],
    [resolve(root, 'validation', 'results', 'vitest.json'), vitestPath],
    [resolve(root, 'validation', 'results', 'playwright.json'), playwrightPath],
    [resolve(root, 'validation', 'results', 'videofactory-sbom.cdx.json'), sbomPath]
  ];
  for (const [source, destination] of copies) {
    if (!existsSync(destination) && existsSync(source)) copyFileSync(source, destination);
  }
}

function loadAndValidateEvidence(packageJson, admission) {
  const missing = requiredValidationPaths
    .filter(path => !existsSync(path))
    .map(path => basename(path));
  if (missing.length > 0) {
    throw new Error(`Release provenance requires validation evidence: ${missing.join(', ')}.`);
  }

  const validation = readJson(statusPath);
  const acceptanceReceipt = readJson(receiptPath);
  const pipeline = readJson(pipelinePath);
  const runtimeInputManifest = readJson(runtimeInputPath);
  const claimsInputManifest = readJson(claimsInputPath);
  const vitest = readJson(vitestPath);
  const playwright = readJson(playwrightPath);
  const sbom = readJson(sbomPath);

  assertValidationEvidenceDocument(validation, 'Attached validation status', { requireRelease: true });
  assertValidationEvidenceDocument(acceptanceReceipt, 'Attached acceptance receipt', { requireRelease: true });
  assertValidationEvidenceDocument(pipeline, 'Attached validation pipeline', { requireRelease: true });
  assertCompletedValidationPipeline(pipeline, 'Attached validation pipeline');
  assertMatchingValidationEvidence(validation, acceptanceReceipt, 'Validation status', 'acceptance receipt');
  assertMatchingValidationEvidence(validation, pipeline, 'Validation status', 'validation pipeline');

  if (validation.release !== packageJson.version || validation.pipeline?.status !== 'passed') {
    throw new Error('Attached validation status is stale or did not pass.');
  }
  if (acceptanceReceipt.appVersion !== packageJson.version) {
    throw new Error('Attached acceptance receipt does not match the package version.');
  }
  if (vitest.success !== true) {
    throw new Error('Attached Vitest result is not globally successful.');
  }
  if (sbom.bomFormat !== 'CycloneDX' || sbom.metadata?.component?.version !== packageJson.version) {
    throw new Error('Attached SBOM is invalid or does not match the package version.');
  }
  if (validation.production_ready !== false) {
    throw new Error('Attached validation status makes an invalid production-ready claim.');
  }

  const currentInput = validationInputDigests(root);
  const currentEvidence = {
    qualification: 'release',
    source: admission.source,
    runtimeInputSha256: currentInput.runtime.sha256,
    runtimeInputFileCount: currentInput.runtime.fileCount,
    claimsInputSha256: currentInput.claims.sha256,
    claimsInputFileCount: currentInput.claims.fileCount
  };
  assertValidationEvidenceDocument(currentEvidence, 'Current release checkout', { requireRelease: true });
  assertMatchingValidationEvidence(validation, currentEvidence, 'Validation status', 'current release checkout');
  assertInputManifest(runtimeInputManifest, 'runtime', validation, 'Attached runtime input manifest');
  assertInputManifest(claimsInputManifest, 'claims', validation, 'Attached claims input manifest');
  if (JSON.stringify(runtimeInputManifest.files) !== JSON.stringify(currentInput.runtime.files)) {
    throw new Error('Attached runtime input manifest does not match the current release checkout.');
  }
  if (JSON.stringify(claimsInputManifest.files) !== JSON.stringify(currentInput.claims.files)) {
    throw new Error('Attached claims input manifest does not match the current release checkout.');
  }

  for (const document of [validation, acceptanceReceipt, pipeline]) {
    assertEvidenceFile(document.inputManifests?.runtime, runtimeInputPath, 'runtime input manifest');
    assertEvidenceFile(document.inputManifests?.claims, claimsInputPath, 'claims input manifest');
  }
  for (const document of [validation, acceptanceReceipt]) {
    assertEvidenceFile(document.evidence?.pipeline, pipelinePath, 'validation pipeline');
    assertEvidenceFile(document.evidence?.sbom, sbomPath, 'SBOM status evidence');
    assertEvidenceFile(document.evidence?.runtimeInput, runtimeInputPath, 'runtime input evidence');
    assertEvidenceFile(document.evidence?.claimsInput, claimsInputPath, 'claims input evidence');
  }
  assertEvidenceFile(acceptanceReceipt.testReports?.vitest, vitestPath, 'Vitest report');
  assertEvidenceFile(acceptanceReceipt.testReports?.playwright, playwrightPath, 'Playwright report');

  return {
    validation,
    acceptanceReceipt,
    pipeline,
    runtimeInputManifest,
    claimsInputManifest,
    vitest,
    playwright,
    sbom
  };
}

function assertPackageSmokeEvidence(smoke, packageJson, source, artifacts) {
  if (smoke?.status !== 'passed') {
    throw new Error('The installed Windows package smoke test did not pass.');
  }
  if (smoke.receiptVersion !== 2) {
    throw new Error('The installed Windows package smoke receipt version is invalid.');
  }
  if (smoke.appVersion !== packageJson.version) {
    throw new Error('The installed Windows package smoke receipt does not match the package version.');
  }
  assertValidationSource(smoke.source, 'release', 'Installed Windows package smoke source');
  if (
    smoke.source.commit !== source.commit
    || smoke.source.tree !== source.tree
    || smoke.source.ref !== source.ref
    || smoke.source.repository !== source.repository
    || smoke.source.workflowCommit !== source.workflowCommit
    || smoke.source.runId !== source.runId
    || smoke.source.runAttempt !== source.runAttempt
  ) {
    throw new Error('The installed Windows package smoke receipt was produced for a different source identity.');
  }
  if (smoke.runner?.platform !== 'win32') {
    throw new Error('The installed Windows package smoke receipt was not produced on Windows.');
  }
  if (smoke.qualification?.validation !== 'release') {
    throw new Error('The installed Windows package smoke receipt is not release-qualified evidence.');
  }

  const requiredChecks = ['archiveLaunch', 'installerInstall', 'installedLaunch', 'uninstall'];
  const failedChecks = requiredChecks.filter(name => smoke.checks?.[name]?.status !== 'passed');
  if (failedChecks.length > 0) {
    throw new Error(`The installed Windows package smoke receipt is missing passing checks: ${failedChecks.join(', ')}.`);
  }

  for (const [label, extension] of [['installer', '.exe'], ['archive', '.zip']]) {
    const evidence = smoke.packages?.[label];
    const artifact = artifacts.find(item => item.name.toLowerCase().endsWith(extension));
    if (
      !artifact
      || evidence?.name !== artifact.name
      || evidence?.sizeBytes !== artifact.sizeBytes
      || evidence?.sha256 !== artifact.sha256
    ) {
      throw new Error(`The installed Windows package smoke receipt does not match the ${label} artifact.`);
    }
  }
}

function assertManifestInputs(manifest, validation) {
  const projection = {
    qualification: manifest.qualification,
    source: manifest.source,
    runtimeInputSha256: manifest.inputs?.runtime?.sha256,
    runtimeInputFileCount: manifest.inputs?.runtime?.fileCount,
    claimsInputSha256: manifest.inputs?.claims?.sha256,
    claimsInputFileCount: manifest.inputs?.claims?.fileCount
  };
  assertValidationEvidenceDocument(projection, 'Release manifest', { requireRelease: true });
  assertMatchingValidationEvidence(projection, validation, 'Release manifest', 'validation status');
  if (
    manifest.inputs?.runtime?.sourceCommit !== manifest.source.commit
    || manifest.inputs?.claims?.sourceCommit !== manifest.source.commit
  ) {
    throw new Error('Release manifest input digests do not identify their source commit.');
  }
}

function verifyManifest() {
  if (!existsSync(manifestPath) || !existsSync(checksumsPath)) {
    throw new Error('RELEASE_PROVENANCE.json and SHA256SUMS.txt are required.');
  }
  const manifest = readJson(manifestPath);
  const packageJson = readJson(resolve(root, 'package.json'));
  const admission = admitValidationSource({ root, qualification: 'release' });
  const evidence = loadAndValidateEvidence(packageJson, admission);
  if (manifest.manifestVersion !== 2) {
    throw new Error('Release manifest version is invalid.');
  }
  if (manifest.appVersion !== packageJson.version) {
    throw new Error(`Manifest version ${manifest.appVersion} does not match package version ${packageJson.version}.`);
  }
  assertManifestInputs(manifest, evidence.validation);
  if (JSON.stringify(manifest.validation) !== JSON.stringify(evidence.validation)) {
    throw new Error('Release manifest validation projection does not match the attached validation status.');
  }
  const expectedTag = `v${packageJson.version}`;
  if (manifest.tag !== null && manifest.tag !== expectedTag) {
    throw new Error(`Release manifest tag does not match package version ${expectedTag}.`);
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
  if ([...listedNames].sort(compareNames).join('\n') !== currentNames.join('\n')) {
    throw new Error('Release directory inventory does not exactly match the release manifest.');
  }
  for (const artifact of manifest.artifacts) {
    const path = resolve(releaseDirectory, artifact.name);
    if (!existsSync(path)) throw new Error(`Manifest artifact is missing: ${artifact.name}`);
    if (statSync(path).size !== artifact.sizeBytes || sha256File(path) !== artifact.sha256) {
      throw new Error(`Manifest artifact failed integrity verification: ${artifact.name}`);
    }
  }
  if (manifest.windowsPackageSmoke) {
    assertPackageSmokeEvidence(manifest.windowsPackageSmoke, packageJson, manifest.source, manifest.artifacts);
  }
  const attachedSmoke = existsSync(smokePath) ? readJson(smokePath) : null;
  if (JSON.stringify(manifest.windowsPackageSmoke) !== JSON.stringify(attachedSmoke)) {
    throw new Error('Release manifest package-smoke projection does not match the attached receipt.');
  }
  if (!packageJson.version.includes('-') && manifest.signing?.status !== 'signed') {
    throw new Error('Stable releases require a valid Authenticode signature report.');
  }
  const expected = [...manifest.artifacts, record(manifestPath)]
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

copyAvailableValidationEvidence();
const admission = admitValidationSource({ root, qualification: 'release' });
const evidence = loadAndValidateEvidence(packageJson, admission);
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

const smoke = existsSync(smokePath) ? readJson(smokePath) : null;
if (smoke) assertPackageSmokeEvidence(smoke, packageJson, admission.source, artifacts);
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const manifest = {
  manifestVersion: 2,
  generatedAt: new Date().toISOString(),
  appVersion: packageJson.version,
  tag,
  qualification: 'release',
  source: admission.source,
  inputs: {
    runtime: {
      sha256: evidence.validation.runtimeInputSha256,
      fileCount: evidence.validation.runtimeInputFileCount,
      sourceCommit: evidence.validation.source.commit
    },
    claims: {
      sha256: evidence.validation.claimsInputSha256,
      fileCount: evidence.validation.claimsInputFileCount,
      sourceCommit: evidence.validation.source.commit
    }
  },
  environment: {
    platform: platform(),
    release: operatingSystemRelease(),
    architecture: arch(),
    node: process.version,
    npm: commandOutput(npmCommand, ['--version'])
  },
  signing: existsSync(signaturePath) ? readJson(signaturePath) : { status: 'not_checked' },
  windowsPackageSmoke: smoke,
  validation: evidence.validation,
  artifacts
};
if (!packageJson.version.includes('-') && manifest.signing?.status !== 'signed') {
  throw new Error('Stable releases require a valid Authenticode signature report.');
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
const checksums = [...artifacts, record(manifestPath)]
  .map(artifact => `${artifact.sha256}  ${artifact.name}`)
  .join('\n') + '\n';
writeFileSync(checksumsPath, checksums);
console.log(`Release manifest written for ${artifacts.length} artifacts: ${manifestPath}`);
