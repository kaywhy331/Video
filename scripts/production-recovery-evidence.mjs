import { assertValidationSource } from './validation-source.mjs';

export const PRODUCTION_RECOVERY_SCHEMA_VERSION = 1;
export const PRODUCTION_RECOVERY_EVIDENCE_KIND = 'videofactory-production-recovery';
export const PRODUCTION_RECOVERY_HARNESS = 'videofactory-production-recovery';
export const PRODUCTION_RECOVERY_GATE_IDS = Object.freeze(['E2E-004']);
export const PRODUCTION_RECOVERY_DRILL_KINDS = Object.freeze([
  'provider',
  'ingest',
  'render',
  'upload_session',
  'upload_commit',
  'restore'
]);

const sha256Pattern = /^[a-f0-9]{64}$/u;
const MAXIMUM_DRILL_DURATION_MS = 4 * 60 * 60 * 1_000;

export function assessProductionRecoveryEvidence(document) {
  const receipt = exactRecord(document, [
    'schemaVersion',
    'evidenceKind',
    'harness',
    'generatedAt',
    'appVersion',
    'mode',
    'source',
    'environment',
    'application',
    'observations',
    'claimedGateIds',
    'result'
  ], 'Production recovery evidence');
  if (receipt.schemaVersion !== PRODUCTION_RECOVERY_SCHEMA_VERSION) {
    throw new Error(`Production recovery evidence must use schema version ${PRODUCTION_RECOVERY_SCHEMA_VERSION}.`);
  }
  if (receipt.evidenceKind !== PRODUCTION_RECOVERY_EVIDENCE_KIND) {
    throw new Error('Production recovery evidence has an unknown evidence identity.');
  }
  if (receipt.harness !== PRODUCTION_RECOVERY_HARNESS) {
    throw new Error('Production recovery evidence has an unknown harness identity.');
  }
  canonicalTimestamp(receipt.generatedAt, 'Production recovery generatedAt');
  nonEmptyString(receipt.appVersion, 'Production recovery appVersion');
  if (!['supporting', 'qualification'].includes(receipt.mode)) {
    throw new Error('Production recovery mode must be supporting or qualification.');
  }
  assertValidationSource(
    receipt.source,
    receipt.mode === 'qualification' ? 'release' : 'development',
    'Production recovery source'
  );

  const environment = exactRecord(receipt.environment, [
    'platform',
    'architecture',
    'release',
    'node',
    'ci',
    'deviceClassSha256',
    'machineFingerprintSha256'
  ], 'Production recovery environment');
  const platform = nonEmptyString(environment.platform, 'Production recovery platform');
  const architecture = nonEmptyString(environment.architecture, 'Production recovery architecture');
  nonEmptyString(environment.release, 'Production recovery operating-system release');
  nonEmptyString(environment.node, 'Production recovery Node version');
  boolean(environment.ci, 'Production recovery CI state');
  sha256(environment.deviceClassSha256, 'Production recovery device-class digest');
  sha256(environment.machineFingerprintSha256, 'Production recovery machine-fingerprint digest');

  const application = exactRecord(receipt.application, [
    'packaged',
    'executableSha256',
    'releaseProvenanceSha256',
    'releaseCommit',
    'releaseTree'
  ], 'Production recovery application');
  boolean(application.packaged, 'Production recovery packaged state');
  sha256(application.executableSha256, 'Production recovery executable digest');
  sha256(application.releaseProvenanceSha256, 'Production recovery release-provenance digest');
  gitObjectId(application.releaseCommit, 'Production recovery release commit');
  gitObjectId(application.releaseTree, 'Production recovery release tree');

  const claimedGateIds = uniqueStrings(receipt.claimedGateIds, 'Production recovery claimed gate IDs');
  if (JSON.stringify(claimedGateIds) !== JSON.stringify([...PRODUCTION_RECOVERY_GATE_IDS])) {
    throw new Error('Production recovery evidence may qualify only E2E-004.');
  }
  if (receipt.result !== 'passed') {
    throw new Error('Production recovery result must be passed.');
  }
  if (!Array.isArray(receipt.observations)) {
    throw new Error('Production recovery observations must be an array.');
  }
  if (receipt.observations.length !== PRODUCTION_RECOVERY_DRILL_KINDS.length) {
    throw new Error(`Production recovery evidence requires exactly ${PRODUCTION_RECOVERY_DRILL_KINDS.length} drills.`);
  }

  const observations = receipt.observations.map((observation, index) => assessObservation(observation, index));
  uniqueStrings(observations.map(value => value.observationSha256), 'Production recovery observation digests');
  const kinds = observations.map(value => value.kind).sort();
  const requiredKinds = [...PRODUCTION_RECOVERY_DRILL_KINDS].sort();
  if (JSON.stringify(kinds) !== JSON.stringify(requiredKinds)) {
    throw new Error(`Production recovery evidence requires exactly these drill kinds: ${requiredKinds.join(', ')}.`);
  }

  const fieldCriteria = Object.fromEntries(observations.map(observation => [
    observation.kind,
    observation.commonPassed && observation.stagePassed
  ]));
  const fieldCriteriaPassed = Object.values(fieldCriteria).every(Boolean);
  const targetChecks = {
    qualificationModeRequested: receipt.mode === 'qualification',
    windowsX64: platform === 'win32' && architecture === 'x64',
    nonCiTarget: environment.ci === false,
    cleanExactSource: receipt.source.dirty === false
      && application.releaseCommit === receipt.source.commit
      && application.releaseTree === receipt.source.tree,
    packagedApplication: application.packaged === true,
    completeRepresentativeDrillSet: observations.length === PRODUCTION_RECOVERY_DRILL_KINDS.length
  };
  const targetEligible = Object.values(targetChecks).every(Boolean);
  const externalQualificationPassed = targetEligible && fieldCriteriaPassed;

  return {
    schemaVersion: receipt.schemaVersion,
    generatedAt: receipt.generatedAt,
    appVersion: receipt.appVersion,
    mode: receipt.mode,
    source: receipt.source,
    environment,
    application,
    qualifiedGateIds: [...PRODUCTION_RECOVERY_GATE_IDS],
    observationCount: observations.length,
    fieldCriteria,
    observationAssessments: observations.map(value => ({
      kind: value.kind,
      commonPassed: value.commonPassed,
      stagePassed: value.stagePassed,
      checks: value.checks
    })),
    targetEligibility: {
      eligible: targetEligible,
      checks: targetChecks,
      reasons: Object.entries(targetChecks)
        .filter(([, passed]) => !passed)
        .map(([name]) => eligibilityReason(name))
    },
    fieldCriteriaPassed,
    acceptance: {
      'E2E-004': fieldCriteriaPassed
        ? targetEligible ? 'qualified' : 'supporting'
        : 'failed'
    },
    externalQualificationPassed
  };
}

export function assessProductionRecoveryObservation(document) {
  const assessed = assessObservation(document, 0);
  return {
    kind: assessed.kind,
    commonPassed: assessed.commonPassed,
    stagePassed: assessed.stagePassed,
    checks: assessed.checks
  };
}

function assessObservation(document, index) {
  const label = `Production recovery observation ${index + 1}`;
  const observation = exactRecord(document, [
    'kind',
    'observationSha256',
    'observationSizeBytes',
    'startedAt',
    'killedAt',
    'restartedAt',
    'completedAt',
    'process',
    'database',
    'work',
    'evidence'
  ], label);
  const kind = nonEmptyString(observation.kind, `${label} kind`);
  if (!PRODUCTION_RECOVERY_DRILL_KINDS.includes(kind)) {
    throw new Error(`${label} has an unsupported drill kind: ${kind}.`);
  }
  const observationSha256 = sha256(observation.observationSha256, `${label} digest`);
  positiveInteger(observation.observationSizeBytes, `${label} byte size`);
  const startedAt = canonicalTimestamp(observation.startedAt, `${label} startedAt`);
  const killedAt = canonicalTimestamp(observation.killedAt, `${label} killedAt`);
  const restartedAt = canonicalTimestamp(observation.restartedAt, `${label} restartedAt`);
  const completedAt = canonicalTimestamp(observation.completedAt, `${label} completedAt`);
  const timestamps = [startedAt, killedAt, restartedAt, completedAt].map(value => Date.parse(value));
  if (!(timestamps[0] < timestamps[1] && timestamps[1] < timestamps[2] && timestamps[2] < timestamps[3])) {
    throw new Error(`${label} timestamps must prove start, forced termination, restart, and completion order.`);
  }
  if (timestamps[3] - timestamps[0] > MAXIMUM_DRILL_DURATION_MS) {
    throw new Error(`${label} exceeds the bounded four-hour drill duration.`);
  }

  const process = exactRecord(observation.process, [
    'terminationMethod',
    'forced',
    'processTree',
    'exitObserved',
    'initialPidSha256',
    'restartedPidSha256'
  ], `${label} process`);
  const terminationMethod = nonEmptyString(process.terminationMethod, `${label} termination method`);
  boolean(process.forced, `${label} forced termination`);
  boolean(process.processTree, `${label} process-tree termination`);
  boolean(process.exitObserved, `${label} process exit observation`);
  const initialPidSha256 = sha256(process.initialPidSha256, `${label} initial PID digest`);
  const restartedPidSha256 = sha256(process.restartedPidSha256, `${label} restarted PID digest`);

  const database = exactRecord(observation.database, [
    'schemaVersionBefore',
    'schemaVersionAfter',
    'integrityBefore',
    'integrityAfter',
    'foreignKeyViolationsBefore',
    'foreignKeyViolationsAfter'
  ], `${label} database`);
  positiveInteger(database.schemaVersionBefore, `${label} schemaVersionBefore`);
  positiveInteger(database.schemaVersionAfter, `${label} schemaVersionAfter`);
  nonEmptyString(database.integrityBefore, `${label} integrityBefore`);
  nonEmptyString(database.integrityAfter, `${label} integrityAfter`);
  nonNegativeInteger(database.foreignKeyViolationsBefore, `${label} foreignKeyViolationsBefore`);
  nonNegativeInteger(database.foreignKeyViolationsAfter, `${label} foreignKeyViolationsAfter`);

  const work = exactRecord(observation.work, [
    'identitySha256',
    'inputSha256',
    'stateBefore',
    'stateAfter',
    'attemptBefore',
    'attemptAfter',
    'recoveredFromCheckpoint',
    'completed'
  ], `${label} work`);
  sha256(work.identitySha256, `${label} work identity digest`);
  sha256(work.inputSha256, `${label} work input digest`);
  nonEmptyString(work.stateBefore, `${label} work stateBefore`);
  nonEmptyString(work.stateAfter, `${label} work stateAfter`);
  nonNegativeInteger(work.attemptBefore, `${label} work attemptBefore`);
  nonNegativeInteger(work.attemptAfter, `${label} work attemptAfter`);
  boolean(work.recoveredFromCheckpoint, `${label} recoveredFromCheckpoint`);
  boolean(work.completed, `${label} completed`);

  const commonChecks = {
    windowsForcedTermination: terminationMethod === 'windows_terminate_process'
      && process.forced === true
      && process.processTree === true
      && process.exitObserved === true,
    distinctRestartedProcess: initialPidSha256 !== restartedPidSha256,
    currentSchemaPreserved: database.schemaVersionBefore === 24 && database.schemaVersionAfter === 24,
    databaseIntegrityPreserved: database.integrityBefore === 'ok' && database.integrityAfter === 'ok',
    foreignKeysPreserved: database.foreignKeyViolationsBefore === 0
      && database.foreignKeyViolationsAfter === 0,
    durableCheckpointRecovered: work.recoveredFromCheckpoint === true,
    workCompleted: work.completed === true,
    retryRecorded: work.attemptAfter === work.attemptBefore + 1
  };
  const stageChecks = assessStageEvidence(kind, observation.evidence, label);
  return {
    kind,
    observationSha256,
    commonPassed: Object.values(commonChecks).every(Boolean),
    stagePassed: Object.values(stageChecks).every(Boolean),
    checks: { ...commonChecks, ...stageChecks }
  };
}

function assessStageEvidence(kind, document, label) {
  if (kind === 'provider') return assessProvider(document, label);
  if (kind === 'ingest') return assessIngest(document, label);
  if (kind === 'render') return assessRender(document, label);
  if (kind === 'upload_session') return assessUpload(document, label, 'remote_session_reused', false);
  if (kind === 'upload_commit') return assessUpload(document, label, 'remote_effect_reused', true);
  return assessRestore(document, label);
}

function assessProvider(document, label) {
  const evidence = exactRecord(document, [
    'productionProviders',
    'completedCallSha256sBefore',
    'completedCallSha256sAfter',
    'replayedCompletedCallSha256s',
    'paidCallCountBefore',
    'paidCallCountAfter',
    'estimatedCostMicrosBefore',
    'estimatedCostMicrosAfter',
    'repeatedEstimatedCostMicros'
  ], `${label} provider evidence`);
  boolean(evidence.productionProviders, `${label} productionProviders`);
  const before = uniqueDigests(evidence.completedCallSha256sBefore, `${label} completed calls before`);
  const after = uniqueDigests(evidence.completedCallSha256sAfter, `${label} completed calls after`);
  const replayed = uniqueDigests(evidence.replayedCompletedCallSha256s, `${label} replayed completed calls`);
  positiveInteger(evidence.paidCallCountBefore, `${label} paidCallCountBefore`);
  positiveInteger(evidence.paidCallCountAfter, `${label} paidCallCountAfter`);
  nonNegativeInteger(evidence.estimatedCostMicrosBefore, `${label} estimatedCostMicrosBefore`);
  nonNegativeInteger(evidence.estimatedCostMicrosAfter, `${label} estimatedCostMicrosAfter`);
  nonNegativeInteger(evidence.repeatedEstimatedCostMicros, `${label} repeatedEstimatedCostMicros`);
  const afterSet = new Set(after);
  return {
    productionProviders: evidence.productionProviders === true,
    completedPaidCallsObserved: before.length > 0,
    completedCallReceiptsPreserved: before.every(value => afterSet.has(value)),
    noCompletedCallReplay: replayed.length === 0,
    paidCallAccountingMonotonic: evidence.paidCallCountAfter >= evidence.paidCallCountBefore
      && evidence.estimatedCostMicrosAfter >= evidence.estimatedCostMicrosBefore,
    noRepeatedCost: evidence.repeatedEstimatedCostMicros === 0
  };
}

function assessIngest(document, label) {
  const evidence = exactRecord(document, [
    'licensedSource',
    'sourceSha256',
    'checkpointPhaseBefore',
    'checkpointPhaseAfter',
    'assetStateBefore',
    'assetStateAfter',
    'sourceHashVerified',
    'derivativesVerified',
    'managedPartialCountAfter',
    'unmanagedPathTouched'
  ], `${label} ingest evidence`);
  boolean(evidence.licensedSource, `${label} licensedSource`);
  sha256(evidence.sourceSha256, `${label} source digest`);
  nonEmptyString(evidence.checkpointPhaseBefore, `${label} checkpointPhaseBefore`);
  nonEmptyString(evidence.checkpointPhaseAfter, `${label} checkpointPhaseAfter`);
  nonEmptyString(evidence.assetStateBefore, `${label} assetStateBefore`);
  nonEmptyString(evidence.assetStateAfter, `${label} assetStateAfter`);
  boolean(evidence.sourceHashVerified, `${label} sourceHashVerified`);
  boolean(evidence.derivativesVerified, `${label} derivativesVerified`);
  nonNegativeInteger(evidence.managedPartialCountAfter, `${label} managedPartialCountAfter`);
  boolean(evidence.unmanagedPathTouched, `${label} unmanagedPathTouched`);
  return {
    licensedRepresentativeSource: evidence.licensedSource === true,
    durableOriginalCheckpoint: evidence.checkpointPhaseBefore === 'original_preserved'
      && evidence.assetStateBefore === 'FILE_STABLE',
    ingestCompleted: evidence.checkpointPhaseAfter === 'complete' && evidence.assetStateAfter === 'COMPLETE',
    sourceHashVerified: evidence.sourceHashVerified === true,
    derivativesVerified: evidence.derivativesVerified === true,
    partialsHandledSafely: evidence.managedPartialCountAfter === 0 && evidence.unmanagedPathTouched === false
  };
}

function assessRender(document, label) {
  const evidence = exactRecord(document, [
    'licensedInputs',
    'jobType',
    'phaseBefore',
    'renderStateBefore',
    'renderStateAfter',
    'outputSha256',
    'manifestSha256',
    'mediaProbePassed',
    'managedPartialCountAfter',
    'unmanagedPathTouched'
  ], `${label} render evidence`);
  boolean(evidence.licensedInputs, `${label} licensedInputs`);
  const jobType = nonEmptyString(evidence.jobType, `${label} jobType`);
  nonEmptyString(evidence.phaseBefore, `${label} phaseBefore`);
  nonEmptyString(evidence.renderStateBefore, `${label} renderStateBefore`);
  nonEmptyString(evidence.renderStateAfter, `${label} renderStateAfter`);
  sha256(evidence.outputSha256, `${label} output digest`);
  sha256(evidence.manifestSha256, `${label} manifest digest`);
  boolean(evidence.mediaProbePassed, `${label} mediaProbePassed`);
  nonNegativeInteger(evidence.managedPartialCountAfter, `${label} managedPartialCountAfter`);
  boolean(evidence.unmanagedPathTouched, `${label} unmanagedPathTouched`);
  return {
    licensedRepresentativeInputs: evidence.licensedInputs === true,
    productionRenderJob: ['render_draft', 'render_final'].includes(jobType),
    killedAtAssemblyBoundary: evidence.phaseBefore === 'Assembling timeline'
      && evidence.renderStateBefore === 'RUNNING',
    renderCompleted: evidence.renderStateAfter === 'SUCCEEDED',
    finalMediaVerified: evidence.mediaProbePassed === true,
    partialsHandledSafely: evidence.managedPartialCountAfter === 0 && evidence.unmanagedPathTouched === false
  };
}

function assessUpload(document, label, requiredOutcome, videoPresentBefore) {
  const evidence = exactRecord(document, [
    'liveGoogleApi',
    'oauthAuthorized',
    'uploadSessionSha256Before',
    'uploadSessionSha256After',
    'videoIdSha256Before',
    'videoIdSha256After',
    'publicationCountBefore',
    'publicationCountAfter',
    'reconciliationOutcome',
    'attachmentsComplete',
    'processingSucceeded'
  ], `${label} upload evidence`);
  boolean(evidence.liveGoogleApi, `${label} liveGoogleApi`);
  boolean(evidence.oauthAuthorized, `${label} oauthAuthorized`);
  const sessionBefore = sha256(evidence.uploadSessionSha256Before, `${label} upload session before`);
  const sessionAfter = sha256(evidence.uploadSessionSha256After, `${label} upload session after`);
  const videoBefore = nullableSha256(evidence.videoIdSha256Before, `${label} video ID before`);
  const videoAfter = sha256(evidence.videoIdSha256After, `${label} video ID after`);
  positiveInteger(evidence.publicationCountBefore, `${label} publicationCountBefore`);
  positiveInteger(evidence.publicationCountAfter, `${label} publicationCountAfter`);
  const reconciliationOutcome = nonEmptyString(evidence.reconciliationOutcome, `${label} reconciliationOutcome`);
  boolean(evidence.attachmentsComplete, `${label} attachmentsComplete`);
  boolean(evidence.processingSucceeded, `${label} processingSucceeded`);
  return {
    liveAuthorizedYouTube: evidence.liveGoogleApi === true && evidence.oauthAuthorized === true,
    expectedCommitBoundary: videoPresentBefore ? videoBefore !== null : videoBefore === null,
    uploadSessionReused: sessionAfter === sessionBefore,
    remoteEffectReused: videoPresentBefore ? videoAfter === videoBefore : videoBefore === null,
    oneDurablePublication: evidence.publicationCountBefore === 1 && evidence.publicationCountAfter === 1,
    expectedReconciliation: reconciliationOutcome === requiredOutcome,
    completedRemotePackage: evidence.attachmentsComplete === true && evidence.processingSucceeded === true
  };
}

function assessRestore(document, label) {
  const evidence = exactRecord(document, [
    'representativeData',
    'backupSha256',
    'stagedSha256',
    'restoredSourceSha256',
    'safetyBackupSha256',
    'safetyBackupIntegrity',
    'pendingMarkerBefore',
    'completionMarkerAfter',
    'artifactRebuildStatus',
    'missingOriginalsCount'
  ], `${label} restore evidence`);
  boolean(evidence.representativeData, `${label} representativeData`);
  const backupSha256 = sha256(evidence.backupSha256, `${label} backup digest`);
  const stagedSha256 = sha256(evidence.stagedSha256, `${label} staged digest`);
  const restoredSourceSha256 = sha256(evidence.restoredSourceSha256, `${label} restored source digest`);
  sha256(evidence.safetyBackupSha256, `${label} safety-backup digest`);
  nonEmptyString(evidence.safetyBackupIntegrity, `${label} safetyBackupIntegrity`);
  boolean(evidence.pendingMarkerBefore, `${label} pendingMarkerBefore`);
  boolean(evidence.completionMarkerAfter, `${label} completionMarkerAfter`);
  nonEmptyString(evidence.artifactRebuildStatus, `${label} artifactRebuildStatus`);
  nonNegativeInteger(evidence.missingOriginalsCount, `${label} missingOriginalsCount`);
  return {
    representativeProductionData: evidence.representativeData === true,
    stagedBytesVerified: stagedSha256 === backupSha256,
    restoredSourceVerified: restoredSourceSha256 === backupSha256,
    safetyBackupVerified: evidence.safetyBackupIntegrity === 'ok',
    pendingRestoreObserved: evidence.pendingMarkerBefore === true,
    restoreFullyAcknowledged: evidence.completionMarkerAfter === false,
    artifactsRebuilt: evidence.artifactRebuildStatus === 'passed',
    allOriginalsAvailable: evidence.missingOriginalsCount === 0
  };
}

function eligibilityReason(name) {
  return ({
    qualificationModeRequested: 'Run with --mode=qualification.',
    windowsX64: 'Run on a supported Windows x64 operator workstation.',
    nonCiTarget: 'Run on representative operator hardware outside hosted CI.',
    cleanExactSource: 'Run from a clean exact source commit and tree.',
    packagedApplication: 'Exercise the packaged application, not a development process.',
    completeRepresentativeDrillSet: 'Run every required representative recovery drill.'
  })[name] ?? `Unmet production-recovery target condition: ${name}`;
}

function exactRecord(value, expectedKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} fields must be exactly: ${expected.join(', ')}.`);
  }
  return value;
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty trimmed string.`);
  }
  return value;
}

function boolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be Boolean.`);
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer.`);
  return value;
}

function uniqueStrings(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  const values = value.map((entry, index) => nonEmptyString(entry, `${label}[${index}]`));
  if (new Set(values).size !== values.length) throw new Error(`${label} must not contain duplicates.`);
  return values;
}

function uniqueDigests(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  const values = value.map((entry, index) => sha256(entry, `${label}[${index}]`));
  if (new Set(values).size !== values.length) throw new Error(`${label} must not contain duplicates.`);
  return values;
}

function sha256(value, label) {
  if (!sha256Pattern.test(String(value ?? ''))) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function nullableSha256(value, label) {
  if (value === null) return null;
  return sha256(value, label);
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
