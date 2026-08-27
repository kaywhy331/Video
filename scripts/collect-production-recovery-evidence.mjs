import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PRODUCTION_RECOVERY_DRILL_KINDS,
  PRODUCTION_RECOVERY_EVIDENCE_KIND,
  PRODUCTION_RECOVERY_GATE_IDS,
  PRODUCTION_RECOVERY_HARNESS,
  PRODUCTION_RECOVERY_SCHEMA_VERSION,
  assessProductionRecoveryEvidence
} from './production-recovery-evidence.mjs';
import { assertValidationSource } from './validation-source.mjs';

export const PRODUCTION_RECOVERY_OBSERVATION_VERSION = 1;
export const PRODUCTION_RECOVERY_OBSERVATION_KIND = 'videofactory-production-recovery-observation';

const sha256Pattern = /^[a-f0-9]{64}$/u;

export function collectProductionRecoveryEvidence({
  observationPaths,
  source,
  appVersion,
  mode = 'qualification',
  now = new Date()
}) {
  if (!Array.isArray(observationPaths) || observationPaths.length !== PRODUCTION_RECOVERY_DRILL_KINDS.length) {
    throw new Error(`Production recovery collection requires exactly ${PRODUCTION_RECOVERY_DRILL_KINDS.length} observation files.`);
  }
  if (!['supporting', 'qualification'].includes(mode)) {
    throw new Error('Production recovery collection mode must be supporting or qualification.');
  }
  assertValidationSource(source, mode === 'qualification' ? 'release' : 'development', 'Production recovery collection source');
  nonEmptyString(appVersion, 'Production recovery collection appVersion');
  const uniquePaths = new Set(observationPaths.map(path => resolve(path)));
  if (uniquePaths.size !== observationPaths.length) {
    throw new Error('Production recovery observation paths must be unique.');
  }

  let commonEnvironment = null;
  let commonApplication = null;
  const observations = observationPaths.map((path, index) => {
    const resolvedPath = resolve(path);
    const bytes = readFileSync(resolvedPath);
    const raw = parseJson(bytes, `Production recovery raw observation ${index + 1}`);
    exactKeys(raw, [
      'observationVersion',
      'evidenceKind',
      'capturedAt',
      'appVersion',
      'mode',
      'source',
      'environment',
      'application',
      'kind',
      'startedAt',
      'killedAt',
      'restartedAt',
      'completedAt',
      'process',
      'database',
      'work',
      'evidence'
    ], `Production recovery raw observation ${index + 1}`);
    if (raw.observationVersion !== PRODUCTION_RECOVERY_OBSERVATION_VERSION) {
      throw new Error(`Production recovery raw observation ${index + 1} has an unsupported version.`);
    }
    if (raw.evidenceKind !== PRODUCTION_RECOVERY_OBSERVATION_KIND) {
      throw new Error(`Production recovery raw observation ${index + 1} has an unknown evidence identity.`);
    }
    canonicalTimestamp(raw.capturedAt, `Production recovery raw observation ${index + 1} capturedAt`);
    if (raw.appVersion !== appVersion) {
      throw new Error(`Production recovery raw observation ${index + 1} has the wrong app version.`);
    }
    if (raw.mode !== mode) {
      throw new Error(`Production recovery raw observation ${index + 1} has the wrong collection mode.`);
    }
    assertValidationSource(
      raw.source,
      mode === 'qualification' ? 'release' : 'development',
      `Production recovery raw observation ${index + 1} source`
    );
    assertSameSource(raw.source, source, `Production recovery raw observation ${index + 1}`);

    const environment = exactRecord(raw.environment, [
      'platform',
      'architecture',
      'release',
      'node',
      'ci',
      'deviceClass',
      'machineFingerprintSha256'
    ], `Production recovery raw observation ${index + 1} environment`);
    nonEmptyString(environment.platform, 'Production recovery raw platform');
    nonEmptyString(environment.architecture, 'Production recovery raw architecture');
    nonEmptyString(environment.release, 'Production recovery raw operating-system release');
    nonEmptyString(environment.node, 'Production recovery raw Node version');
    if (typeof environment.ci !== 'boolean') throw new Error('Production recovery raw CI state must be Boolean.');
    const deviceClass = nonEmptyString(environment.deviceClass, 'Production recovery raw device class');
    if (deviceClass.length < 8 || deviceClass.length > 120) {
      throw new Error('Production recovery raw device class must be a non-sensitive label of 8 to 120 characters.');
    }
    sha256(environment.machineFingerprintSha256, 'Production recovery raw machine fingerprint');

    const application = exactRecord(raw.application, [
      'packaged',
      'executableSha256',
      'releaseProvenanceSha256',
      'releaseCommit',
      'releaseTree'
    ], `Production recovery raw observation ${index + 1} application`);
    if (typeof application.packaged !== 'boolean') {
      throw new Error('Production recovery raw packaged state must be Boolean.');
    }
    sha256(application.executableSha256, 'Production recovery raw executable digest');
    sha256(application.releaseProvenanceSha256, 'Production recovery raw release-provenance digest');
    gitObjectId(application.releaseCommit, 'Production recovery raw release commit');
    gitObjectId(application.releaseTree, 'Production recovery raw release tree');
    if (application.releaseCommit !== raw.source.commit || application.releaseTree !== raw.source.tree) {
      throw new Error('Production recovery raw packaged release commit/tree does not match its operator source.');
    }
    if (commonEnvironment === null) commonEnvironment = environment;
    if (commonApplication === null) commonApplication = application;
    if (JSON.stringify(environment) !== JSON.stringify(commonEnvironment)) {
      throw new Error('Production recovery observations must come from one identical representative machine environment.');
    }
    if (JSON.stringify(application) !== JSON.stringify(commonApplication)) {
      throw new Error('Production recovery observations must exercise one identical packaged application and provenance document.');
    }

    const process = exactRecord(raw.process, [
      'terminationMethod',
      'forced',
      'processTree',
      'exitObserved',
      'initialPid',
      'restartedPid'
    ], `Production recovery raw observation ${index + 1} process`);
    positiveInteger(process.initialPid, 'Production recovery raw initial PID');
    positiveInteger(process.restartedPid, 'Production recovery raw restarted PID');
    const work = exactRecord(raw.work, [
      'identity',
      'inputSha256',
      'stateBefore',
      'stateAfter',
      'attemptBefore',
      'attemptAfter',
      'recoveredFromCheckpoint',
      'completed'
    ], `Production recovery raw observation ${index + 1} work`);
    const workIdentity = nonEmptyString(work.identity, 'Production recovery raw work identity');
    if (workIdentity.length > 512) throw new Error('Production recovery raw work identity is too long.');
    const kind = nonEmptyString(raw.kind, `Production recovery raw observation ${index + 1} kind`);
    return {
      kind,
      observationSha256: digest(bytes),
      observationSizeBytes: statSync(resolvedPath).size,
      startedAt: raw.startedAt,
      killedAt: raw.killedAt,
      restartedAt: raw.restartedAt,
      completedAt: raw.completedAt,
      process: {
        terminationMethod: process.terminationMethod,
        forced: process.forced,
        processTree: process.processTree,
        exitObserved: process.exitObserved,
        initialPidSha256: privacyDigest(environment.machineFingerprintSha256, kind, `pid:${process.initialPid}`),
        restartedPidSha256: privacyDigest(environment.machineFingerprintSha256, kind, `pid:${process.restartedPid}`)
      },
      database: structuredClone(raw.database),
      work: {
        identitySha256: privacyDigest(environment.machineFingerprintSha256, kind, `work:${workIdentity}`),
        inputSha256: work.inputSha256,
        stateBefore: work.stateBefore,
        stateAfter: work.stateAfter,
        attemptBefore: work.attemptBefore,
        attemptAfter: work.attemptAfter,
        recoveredFromCheckpoint: work.recoveredFromCheckpoint,
        completed: work.completed
      },
      evidence: structuredClone(raw.evidence)
    };
  });

  const environment = {
    platform: commonEnvironment.platform,
    architecture: commonEnvironment.architecture,
    release: commonEnvironment.release,
    node: commonEnvironment.node,
    ci: commonEnvironment.ci,
    deviceClassSha256: privacyDigest(
      commonEnvironment.machineFingerprintSha256,
      'environment',
      `device-class:${commonEnvironment.deviceClass}`
    ),
    machineFingerprintSha256: commonEnvironment.machineFingerprintSha256
  };
  const order = new Map(PRODUCTION_RECOVERY_DRILL_KINDS.map((kind, index) => [kind, index]));
  observations.sort((left, right) => (order.get(left.kind) ?? 999) - (order.get(right.kind) ?? 999));
  const receipt = {
    schemaVersion: PRODUCTION_RECOVERY_SCHEMA_VERSION,
    evidenceKind: PRODUCTION_RECOVERY_EVIDENCE_KIND,
    harness: PRODUCTION_RECOVERY_HARNESS,
    generatedAt: now.toISOString(),
    appVersion,
    mode,
    source,
    environment,
    application: structuredClone(commonApplication),
    observations,
    claimedGateIds: [...PRODUCTION_RECOVERY_GATE_IDS],
    result: 'passed'
  };
  const assessment = assessProductionRecoveryEvidence(receipt);
  if (!assessment.fieldCriteriaPassed) {
    const failed = Object.entries(assessment.fieldCriteria)
      .filter(([, passed]) => !passed)
      .map(([kind]) => kind);
    throw new Error(`Production recovery observations failed drill criteria: ${failed.join(', ')}.`);
  }
  if (mode === 'qualification' && !assessment.externalQualificationPassed) {
    throw new Error('Production recovery observations are not eligible external qualification evidence.');
  }
  return { receipt, assessment };
}

function assertSameSource(actual, expected, label) {
  const keys = ['commit', 'tree', 'ref', 'repository', 'workflowCommit', 'runId', 'runAttempt', 'dirty'];
  if (keys.some(key => actual[key] !== expected[key])) {
    throw new Error(`${label} does not match the exact admitted source.`);
  }
}

function exactRecord(value, keys, label) {
  exactKeys(value, keys, label);
  return value;
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} fields must be exactly: ${[...keys].sort().join(', ')}.`);
  }
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty trimmed string.`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
  return value;
}

function sha256(value, label) {
  if (!sha256Pattern.test(String(value ?? ''))) throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  return value;
}

function gitObjectId(value, label) {
  if (!/^[a-f0-9]{40}$/u.test(String(value ?? ''))) {
    throw new Error(`${label} must be a lowercase 40-character Git object ID.`);
  }
  return value;
}

function canonicalTimestamp(value, label) {
  const timestamp = nonEmptyString(value, label);
  if (!Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) {
    throw new Error(`${label} must be a canonical ISO timestamp.`);
  }
  return timestamp;
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function privacyDigest(machineFingerprintSha256, kind, value) {
  return digest(`videofactory-production-recovery:v1:${machineFingerprintSha256}:${kind}:${value}`);
}
