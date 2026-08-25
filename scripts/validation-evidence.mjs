import { assertValidationSource } from './validation-source.mjs';

export const REQUIRED_VALIDATION_STAGES = Object.freeze([
  'release_evidence',
  'typecheck',
  'vitest',
  'build',
  'electron_e2e',
  'security_audit',
  'sbom'
]);

export function assertValidationEvidenceDocument(document, label, { requireRelease = false } = {}) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error(`${label} is not a JSON object.`);
  }
  assertValidationSource(document.source, document.qualification, `${label} source`);
  if (requireRelease && document.qualification !== 'release') {
    throw new Error(`${label} is development evidence and cannot qualify a release.`);
  }
  assertDigest(document.runtimeInputSha256, `${label} runtime input`);
  assertDigest(document.claimsInputSha256, `${label} claims input`);
  assertFileCount(document.runtimeInputFileCount, `${label} runtime input`);
  assertFileCount(document.claimsInputFileCount, `${label} claims input`);
  return document;
}

export function assertMatchingValidationEvidence(left, right, leftLabel, rightLabel) {
  const comparisons = [
    ['qualification', left.qualification, right.qualification],
    ['source commit', left.source?.commit, right.source?.commit],
    ['source tree', left.source?.tree, right.source?.tree],
    ['source ref', left.source?.ref, right.source?.ref],
    ['source repository', left.source?.repository, right.source?.repository],
    ['workflow source commit', left.source?.workflowCommit, right.source?.workflowCommit],
    ['workflow run ID', left.source?.runId, right.source?.runId],
    ['workflow run attempt', left.source?.runAttempt, right.source?.runAttempt],
    ['source dirty state', left.source?.dirty, right.source?.dirty],
    ['runtime input digest', left.runtimeInputSha256, right.runtimeInputSha256],
    ['runtime input file count', left.runtimeInputFileCount, right.runtimeInputFileCount],
    ['claims input digest', left.claimsInputSha256, right.claimsInputSha256],
    ['claims input file count', left.claimsInputFileCount, right.claimsInputFileCount]
  ];
  const mismatch = comparisons.find(([, leftValue, rightValue]) => leftValue !== rightValue);
  if (mismatch) {
    throw new Error(`${leftLabel} and ${rightLabel} have different ${mismatch[0]}.`);
  }
}

export function assertCompletedValidationPipeline(pipeline, label = 'Validation pipeline') {
  if (pipeline?.completed !== true) throw new Error(`${label} is not marked complete.`);
  if (!Array.isArray(pipeline.stages) || pipeline.stages.some(stage => stage?.status !== 'passed' || stage?.exitCode !== 0)) {
    throw new Error(`${label} contains a failed or invalid stage.`);
  }
  for (const name of REQUIRED_VALIDATION_STAGES) {
    const matches = pipeline.stages.filter(stage => stage?.name === name);
    if (matches.length !== 1) {
      throw new Error(`${label} does not uniquely record passing stage ${name}.`);
    }
  }
  if (
    !pipeline.environment?.platform
    || !pipeline.environment?.architecture
    || !pipeline.environment?.node
    || !pipeline.environment?.npm
  ) {
    throw new Error(`${label} is missing runner/toolchain provenance.`);
  }
  return pipeline;
}

export function assertInputManifest(manifest, kind, evidenceDocument, label) {
  if (manifest?.manifestVersion !== 1 || manifest?.kind !== kind) {
    throw new Error(`${label} is not a version 1 ${kind} input manifest.`);
  }
  const prefix = kind === 'runtime' ? 'runtimeInput' : 'claimsInput';
  const projected = {
    qualification: manifest.qualification,
    source: manifest.source,
    runtimeInputSha256: kind === 'runtime' ? manifest.sha256 : evidenceDocument.runtimeInputSha256,
    runtimeInputFileCount: kind === 'runtime' ? manifest.fileCount : evidenceDocument.runtimeInputFileCount,
    claimsInputSha256: kind === 'claims' ? manifest.sha256 : evidenceDocument.claimsInputSha256,
    claimsInputFileCount: kind === 'claims' ? manifest.fileCount : evidenceDocument.claimsInputFileCount
  };
  assertValidationEvidenceDocument(projected, label);
  assertMatchingValidationEvidence(projected, evidenceDocument, label, 'validation evidence');
  if (manifest.sha256 !== evidenceDocument[`${prefix}Sha256`]) {
    throw new Error(`${label} digest does not match validation evidence.`);
  }
  if (manifest.fileCount !== evidenceDocument[`${prefix}FileCount`]) {
    throw new Error(`${label} file count does not match validation evidence.`);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length !== manifest.fileCount) {
    throw new Error(`${label} does not contain exactly its declared files.`);
  }
  let previousPath = null;
  for (const file of manifest.files) {
    if (
      !file
      || typeof file.path !== 'string'
      || file.path.length === 0
      || file.path.startsWith('/')
      || file.path === '..'
      || file.path.startsWith('../')
      || file.path.includes('/../')
      || file.path.includes('\\')
      || !Number.isSafeInteger(file.sizeBytes)
      || file.sizeBytes < 0
      || !isSha256(file.sha256)
    ) {
      throw new Error(`${label} contains an invalid file record.`);
    }
    if (previousPath !== null && file.path <= previousPath) {
      throw new Error(`${label} file records are not uniquely sorted by normalized path.`);
    }
    previousPath = file.path;
  }
  return manifest;
}

function assertDigest(value, label) {
  if (!isSha256(value)) throw new Error(`${label} digest is missing or invalid.`);
}

function assertFileCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} file count is missing or invalid.`);
  }
}

function isSha256(value) {
  return /^[a-f0-9]{64}$/i.test(String(value ?? ''));
}
