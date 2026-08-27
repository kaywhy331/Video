export const PRODUCTION_PILOT_SCHEMA_VERSION = 1;
export const PRODUCTION_PILOT_EVIDENCE_KIND = 'videofactory-production-pilot';
export const PRODUCTION_PILOT_HARNESS = 'videofactory-production-pilot';
export const PRODUCTION_PILOT_GATE_IDS = Object.freeze([
  'E2E-001',
  'E2E-002',
  'E2E-005',
  'UX-001'
]);

export const PRODUCTION_PILOT_THRESHOLDS = Object.freeze({
  catalogRows: 26_000,
  projectCount: 5,
  destinationClusters: 3,
  routineOnlyProjects: 4,
  minimumDurationMs: 4 * 60 * 1_000,
  maximumDurationMs: 6 * 60 * 1_000,
  minimumShortSidePixels: 1_080,
  targetFrameRate: 30,
  frameRateTolerance: 0.1
});

const ELIGIBLE_PROJECT_STATES = new Set([
  'WAITING_FINAL_APPROVAL',
  'SCHEDULED',
  'PUBLISHED',
  'ANALYTICS_ACTIVE',
  'AWAITING_MANUAL_STUDIO_ACTION'
]);
const LIVE_NARRATION_PROVIDERS = new Set(['windows_sapi', 'http_tts']);
const ROUTINE_OPERATOR_ACTIONS = new Set([
  'exception.ambiguous_mapping_resolved',
  'license.batch_attested',
  'youtube.keep_private'
]);

export function assessProductionPilotEvidence(document) {
  const value = record(document, 'Production pilot evidence');
  if (value.schemaVersion !== PRODUCTION_PILOT_SCHEMA_VERSION) {
    throw new Error(`Production pilot evidence must use schema version ${PRODUCTION_PILOT_SCHEMA_VERSION}.`);
  }
  if (value.evidenceKind !== PRODUCTION_PILOT_EVIDENCE_KIND) {
    throw new Error('Production pilot evidence has an unknown evidence identity.');
  }
  if (value.harness !== PRODUCTION_PILOT_HARNESS) {
    throw new Error('Production pilot evidence has an unknown harness identity.');
  }
  if (!['supporting', 'qualification'].includes(value.mode)) {
    throw new Error('Production pilot evidence mode must be supporting or qualification.');
  }
  canonicalTimestamp(value.generatedAt, 'generatedAt');
  string(value.appVersion, 'appVersion');
  sha256(value.runId, 'runId');

  const source = record(value.source, 'source');
  gitObjectId(source.commit, 'source commit');
  gitObjectId(source.tree, 'source tree');
  if (typeof source.dirty !== 'boolean') {
    throw new Error('Production pilot source must record dirty state.');
  }

  const environment = record(value.environment, 'environment');
  const platform = string(environment.platform, 'environment platform');
  const architecture = string(environment.architecture, 'environment architecture');
  string(environment.release, 'environment release');
  string(environment.node, 'environment node');
  const deviceClass = nullableString(environment.deviceClass, 'environment deviceClass');
  if (typeof environment.ci !== 'boolean') {
    throw new Error('Production pilot environment must record CI state.');
  }

  const database = record(value.database, 'database');
  const databaseSchemaVersion = positiveInteger(database.schemaVersion, 'database schemaVersion');
  if (database.integrity !== 'ok') throw new Error('Production pilot database integrity must be ok.');
  artifact(database.artifact, 'database artifact');

  const catalog = record(value.catalog, 'catalog');
  const catalogAssetCount = positiveInteger(catalog.assetCount, 'catalog assetCount');
  const completedImportCount = positiveInteger(catalog.completedImportCount, 'catalog completedImportCount');
  const largestCompletedImportRows = positiveInteger(
    catalog.largestCompletedImportRows,
    'catalog largestCompletedImportRows'
  );
  const catalogSourceDigests = uniqueDigests(catalog.sourceSha256s, 'catalog sourceSha256s');

  if (!Array.isArray(value.projects) || value.projects.length === 0) {
    throw new Error('Production pilot evidence must contain projects.');
  }
  const projects = value.projects.map((project, index) => assessProject(project, index));
  const projectIds = uniqueStrings(projects.map(project => project.projectIdHash), 'project hashes');
  const destinations = new Set(projects.map(project => project.destinationKeyHash));
  const videoIds = projects.map(project => project.videoIdHash);
  if (new Set(videoIds).size !== videoIds.length) {
    throw new Error('Production pilot projects must reference distinct remote videos.');
  }

  const completeProductionCount = projects.filter(project => project.completeProduction).length;
  const scheduledCount = projects.filter(project => project.scheduleCompleted).length;
  const routineOnlyCount = projects.filter(project => project.routineOnly && project.finalApprovalCompleted).length;
  const exactPilot = projects.length === PRODUCTION_PILOT_THRESHOLDS.projectCount
    && projectIds.length === PRODUCTION_PILOT_THRESHOLDS.projectCount;
  const representativeDestinations = destinations.size >= PRODUCTION_PILOT_THRESHOLDS.destinationClusters;
  const fullCatalog = catalogAssetCount >= PRODUCTION_PILOT_THRESHOLDS.catalogRows
    && largestCompletedImportRows >= PRODUCTION_PILOT_THRESHOLDS.catalogRows
    && completedImportCount > 0
    && catalogSourceDigests.length > 0;

  const measured = {
    'E2E-001': exactPilot
      && fullCatalog
      && completeProductionCount === PRODUCTION_PILOT_THRESHOLDS.projectCount,
    'E2E-002': scheduledCount >= 1,
    'E2E-005': exactPilot
      && representativeDestinations
      && completeProductionCount === PRODUCTION_PILOT_THRESHOLDS.projectCount
      && routineOnlyCount >= PRODUCTION_PILOT_THRESHOLDS.routineOnlyProjects,
    'UX-001': routineOnlyCount >= PRODUCTION_PILOT_THRESHOLDS.routineOnlyProjects
  };
  const fieldCriteriaPassed = Object.values(measured).every(Boolean);

  const targetChecks = {
    qualificationModeRequested: value.mode === 'qualification',
    windowsX64: platform === 'win32' && architecture === 'x64',
    nonCiTarget: environment.ci === false,
    cleanExactSource: source.dirty === false,
    deviceClassRecorded: Boolean(deviceClass && deviceClass.length >= 8),
    currentDatabaseSchema: databaseSchemaVersion === 24,
    fullCatalog,
    exactFiveProjectPilot: exactPilot,
    representativeDestinations
  };
  const targetEligible = Object.values(targetChecks).every(Boolean);
  const targetEligibility = {
    eligible: targetEligible,
    checks: targetChecks,
    reasons: Object.entries(targetChecks)
      .filter(([, passed]) => !passed)
      .map(([name]) => eligibilityReason(name))
  };
  const acceptance = Object.fromEntries(PRODUCTION_PILOT_GATE_IDS.map(id => [
    id,
    measured[id]
      ? targetEligible ? 'qualified' : 'supporting'
      : 'failed'
  ]));

  return {
    ...value,
    thresholds: PRODUCTION_PILOT_THRESHOLDS,
    derived: {
      catalogAssetCount,
      completedImportCount,
      largestCompletedImportRows,
      projectCount: projects.length,
      destinationClusterCount: destinations.size,
      completeProductionCount,
      scheduledCount,
      routineOnlyCount
    },
    projectAssessments: projects.map(project => ({
      projectIdHash: project.projectIdHash,
      completeProduction: project.completeProduction,
      scheduleCompleted: project.scheduleCompleted,
      finalApprovalCompleted: project.finalApprovalCompleted,
      routineOnly: project.routineOnly,
      checks: project.checks
    })),
    targetEligibility,
    acceptance,
    fieldCriteriaPassed,
    externalQualificationPassed: targetEligible && fieldCriteriaPassed
  };
}

function assessProject(document, index) {
  const label = `production pilot project ${index + 1}`;
  const project = record(document, label);
  const projectIdHash = sha256(project.projectIdHash, `${label} projectIdHash`);
  const destinationKeyHash = sha256(project.destinationKeyHash, `${label} destinationKeyHash`);
  const state = string(project.state, `${label} state`);
  canonicalTimestamp(project.createdAt, `${label} createdAt`);
  canonicalTimestamp(project.updatedAt, `${label} updatedAt`);

  const scheduler = record(project.scheduler, `${label} scheduler`);
  const schedulerRunCount = positiveInteger(scheduler.createdRunCount, `${label} scheduler createdRunCount`);
  uniqueStrings(scheduler.triggers, `${label} scheduler triggers`);
  sha256(scheduler.projectionSha256, `${label} scheduler projectionSha256`);

  const research = record(project.research, `${label} research`);
  const activeHttpSources = positiveInteger(research.activeHttpSourceCount, `${label} activeHttpSourceCount`);
  const acceptedMaterialClaims = positiveInteger(
    research.acceptedMaterialClaimCount,
    `${label} acceptedMaterialClaimCount`
  );
  const citedAcceptedMaterialClaims = positiveInteger(
    research.citedAcceptedMaterialClaimCount,
    `${label} citedAcceptedMaterialClaimCount`
  );
  const successfulTavilyCalls = positiveInteger(
    research.successfulTavilyCallCount,
    `${label} successfulTavilyCallCount`
  );
  const successfulLanguageCalls = positiveInteger(
    research.successfulLanguageCallCount,
    `${label} successfulLanguageCallCount`
  );
  const finalScriptProvider = string(research.finalScriptProvider, `${label} finalScriptProvider`);
  if (typeof research.finalScriptLocked !== 'boolean') {
    throw new Error(`${label} must record whether the final script is locked.`);
  }

  const acquisition = record(project.acquisition, `${label} acquisition`);
  const activeItems = positiveInteger(acquisition.activeItemCount, `${label} activeItemCount`);
  const completedItems = positiveInteger(acquisition.completedItemCount, `${label} completedItemCount`);
  const envatoItems = positiveInteger(acquisition.envatoItemCount, `${label} envatoItemCount`);
  const footageScenes = positiveInteger(
    acquisition.selectedFootageSceneCount,
    `${label} selectedFootageSceneCount`
  );
  const verifiedFootageScenes = positiveInteger(
    acquisition.verifiedFootageSceneCount,
    `${label} verifiedFootageSceneCount`
  );
  const graphicScenes = nonNegativeInteger(acquisition.graphicSceneCount, `${label} graphicSceneCount`);
  const sceneCount = positiveInteger(acquisition.sceneCount, `${label} sceneCount`);
  const licensedAssets = positiveInteger(acquisition.licensedAssetCount, `${label} licensedAssetCount`);
  const certificateArtifacts = artifactArray(acquisition.certificateArtifacts, `${label} certificateArtifacts`, {
    keyed: true,
    uniqueBytes: false
  });
  const sourceArtifacts = artifactArray(acquisition.sourceArtifacts, `${label} sourceArtifacts`, { keyed: true });

  const narration = record(project.narration, `${label} narration`);
  const narrationProvider = string(narration.provider, `${label} narration provider`);
  const narrationSections = positiveInteger(narration.sectionCount, `${label} narration sectionCount`);
  const readyNarrationSections = positiveInteger(
    narration.readySectionCount,
    `${label} narration readySectionCount`
  );
  const providerReceiptCount = positiveInteger(
    narration.providerReceiptCount,
    `${label} narration providerReceiptCount`
  );
  const timingMethods = uniqueStrings(narration.timingMethods, `${label} narration timingMethods`);
  const narrationArtifacts = artifactArray(narration.audioArtifacts, `${label} narration audioArtifacts`, {
    keyed: true
  });

  const render = record(project.render, `${label} render`);
  if (render.kind !== 'final' || render.state !== 'SUCCEEDED') {
    throw new Error(`${label} must reference a succeeded final render.`);
  }
  sha256(render.renderIdHash, `${label} renderIdHash`);
  const renderArtifact = artifact(render.artifact, `${label} render artifact`);
  const storedRenderSha256 = sha256(render.storedSha256, `${label} stored render sha256`);
  const manifestArtifact = artifact(render.manifestArtifact, `${label} manifest artifact`);
  const storedManifestSha256 = sha256(render.storedManifestSha256, `${label} stored manifest sha256`);
  const captionArtifacts = artifactArray(render.captionArtifacts, `${label} captionArtifacts`, { keyed: true });
  const probe = record(render.probe, `${label} render probe`);
  const durationMs = positiveNumber(probe.durationMs, `${label} render durationMs`);
  const width = positiveInteger(probe.width, `${label} render width`);
  const height = positiveInteger(probe.height, `${label} render height`);
  const frameRate = positiveNumber(probe.frameRate, `${label} render frameRate`);
  const videoCodec = string(probe.videoCodec, `${label} render videoCodec`);
  const audioCodec = string(probe.audioCodec, `${label} render audioCodec`);

  const qc = record(project.qc, `${label} QC`);
  const qcResultCount = positiveInteger(qc.resultCount, `${label} QC resultCount`);
  const passedQcResults = positiveInteger(qc.passedCount, `${label} QC passedCount`);
  const failedQcResults = nonNegativeInteger(qc.failedCount, `${label} QC failedCount`);
  const failedBlockerHigh = nonNegativeInteger(
    qc.failedBlockerHighCount,
    `${label} QC failedBlockerHighCount`
  );

  const publication = record(project.publication, `${label} publication`);
  const publicationRecords = positiveInteger(publication.recordCount, `${label} publication recordCount`);
  const currentPublicationRecords = positiveInteger(
    publication.currentRecordCount,
    `${label} publication currentRecordCount`
  );
  const remoteVideos = positiveInteger(publication.remoteVideoCount, `${label} publication remoteVideoCount`);
  const videoIdHash = sha256(publication.videoIdHash, `${label} publication videoIdHash`);
  sha256(publication.channelIdHash, `${label} publication channelIdHash`);
  if (publication.channelBindingConfirmed !== true) {
    throw new Error(`${label} publication must record a confirmed channel binding.`);
  }
  const privacyStatus = string(publication.privacyStatus, `${label} publication privacyStatus`);
  const processingStatus = string(publication.processingStatus, `${label} publication processingStatus`);
  const snapshotStatus = string(publication.snapshotStatus, `${label} publication snapshotStatus`);
  if (typeof publication.captionPresent !== 'boolean'
    || typeof publication.thumbnailUploaded !== 'boolean'
    || typeof publication.packageSelected !== 'boolean'
    || typeof publication.approvalHashPresent !== 'boolean'
    || typeof publication.requestedScheduleFallback !== 'boolean') {
    throw new Error(`${label} publication must record every Boolean prerequisite.`);
  }
  const approvedAt = nullableTimestamp(publication.approvedAt, `${label} publication approvedAt`);
  const scheduledAt = nullableTimestamp(publication.scheduledAt, `${label} publication scheduledAt`);
  nullableTimestamp(publication.publishedAt, `${label} publication publishedAt`);
  const thumbnailArtifact = artifact(publication.thumbnailArtifact, `${label} thumbnail artifact`);

  const openBlockerHigh = nonNegativeInteger(
    record(project.exceptions, `${label} exceptions`).openBlockerHighCount,
    `${label} openBlockerHighCount`
  );
  const audit = record(project.audit, `${label} audit`);
  positiveInteger(audit.entryCount, `${label} audit entryCount`);
  sha256(audit.projectionSha256, `${label} audit projectionSha256`);
  const operatorActions = stringArray(audit.operatorActions, `${label} operatorActions`);
  const unexpectedOperatorActions = operatorActions.filter(action => !ROUTINE_OPERATOR_ACTIONS.has(action));

  const checks = {
    eligibleState: ELIGIBLE_PROJECT_STATES.has(state),
    schedulerCreated: schedulerRunCount > 0,
    liveResearch: activeHttpSources > 0
      && acceptedMaterialClaims > 0
      && citedAcceptedMaterialClaims === acceptedMaterialClaims
      && successfulTavilyCalls > 0
      && successfulLanguageCalls > 0
      && research.finalScriptLocked === true
      && finalScriptProvider === 'openai_compatible',
    completeAcquisition: activeItems > 0
      && completedItems === activeItems
      && envatoItems === activeItems
      && footageScenes + graphicScenes === sceneCount
      && verifiedFootageScenes === footageScenes
      && licensedAssets > 0
      && certificateArtifacts.length === licensedAssets
      && sourceArtifacts.length === licensedAssets,
    liveNarration: LIVE_NARRATION_PROVIDERS.has(narrationProvider)
      && narrationSections > 0
      && readyNarrationSections === narrationSections
      && providerReceiptCount === narrationSections
      && timingMethods.every(method => method === 'provider_word')
      && narrationArtifacts.length === narrationSections,
    verifiedFinalArtifact: renderArtifact.sha256 === storedRenderSha256
      && manifestArtifact.contentSha256 === storedManifestSha256
      && captionArtifacts.length === 2
      && durationMs >= PRODUCTION_PILOT_THRESHOLDS.minimumDurationMs
      && durationMs <= PRODUCTION_PILOT_THRESHOLDS.maximumDurationMs
      && Math.min(width, height) >= PRODUCTION_PILOT_THRESHOLDS.minimumShortSidePixels
      && Math.abs(frameRate - PRODUCTION_PILOT_THRESHOLDS.targetFrameRate)
        <= PRODUCTION_PILOT_THRESHOLDS.frameRateTolerance
      && videoCodec === 'h264'
      && audioCodec === 'aac',
    cleanQc: qcResultCount > 0
      && passedQcResults > 0
      && passedQcResults + failedQcResults === qcResultCount
      && failedQcResults === 0
      && failedBlockerHigh === 0,
    noOpenBlockers: openBlockerHigh === 0,
    synchronizedPublication: publicationRecords === 1
      && currentPublicationRecords === 1
      && remoteVideos === 1
      && (
        (['WAITING_FINAL_APPROVAL', 'SCHEDULED', 'AWAITING_MANUAL_STUDIO_ACTION'].includes(state)
          && privacyStatus === 'private')
        || (['PUBLISHED', 'ANALYTICS_ACTIVE'].includes(state) && privacyStatus === 'public')
      )
      && processingStatus === 'succeeded'
      && snapshotStatus === 'current'
      && publication.captionPresent
      && publication.thumbnailUploaded
      && publication.packageSelected
      && publication.approvalHashPresent
      && thumbnailArtifact.sizeBytes > 0,
    noUnexpectedOperatorActions: unexpectedOperatorActions.length === 0
  };
  const completeProduction = Object.entries(checks)
    .filter(([name]) => name !== 'noUnexpectedOperatorActions')
    .every(([, passed]) => passed);
  const finalApprovalCompleted = approvedAt !== null;
  const scheduleCompleted = Boolean(
    (scheduledAt !== null
      && ['SCHEDULED', 'PUBLISHED', 'ANALYTICS_ACTIVE'].includes(state))
    || (publication.requestedScheduleFallback && state === 'AWAITING_MANUAL_STUDIO_ACTION')
  );

  return {
    projectIdHash,
    destinationKeyHash,
    videoIdHash,
    completeProduction,
    finalApprovalCompleted,
    scheduleCompleted,
    routineOnly: checks.noUnexpectedOperatorActions,
    checks
  };
}

function eligibilityReason(name) {
  return ({
    qualificationModeRequested: 'Run with --mode=qualification.',
    windowsX64: 'Run on a supported Windows x64 operator workstation.',
    nonCiTarget: 'Run on representative operator hardware outside hosted CI.',
    cleanExactSource: 'Run from a clean exact source commit and tree.',
    deviceClassRecorded: 'Record a non-sensitive representative device class.',
    currentDatabaseSchema: 'Use a database at the current application schema.',
    fullCatalog: `Use a real catalog with at least ${PRODUCTION_PILOT_THRESHOLDS.catalogRows.toLocaleString()} assets.`,
    exactFiveProjectPilot: 'Select exactly five distinct production projects.',
    representativeDestinations: `Select projects across at least ${PRODUCTION_PILOT_THRESHOLDS.destinationClusters} destination clusters.`
  })[name] ?? `Unmet production-pilot target condition: ${name}`;
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function string(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty trimmed string.`);
  }
  return value;
}

function nullableString(value, label) {
  if (value === null || value === undefined) return null;
  return string(value, label);
}

function stringArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value.map((entry, index) => string(entry, `${label}[${index}]`));
}

function uniqueStrings(value, label) {
  const values = stringArray(value, label);
  if (new Set(values).size !== values.length) throw new Error(`${label} must not contain duplicates.`);
  return values;
}

function uniqueDigests(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  const values = value.map((entry, index) => sha256(entry, `${label}[${index}]`));
  if (new Set(values).size !== values.length) throw new Error(`${label} must not contain duplicate digests.`);
  return values;
}

function artifact(value, label) {
  const item = record(value, label);
  const result = {
    sha256: sha256(item.sha256, `${label} sha256`),
    sizeBytes: positiveInteger(item.sizeBytes, `${label} sizeBytes`),
    ...(item.contentSha256 === undefined
      ? {}
      : { contentSha256: sha256(item.contentSha256, `${label} contentSha256`) })
  };
  return result;
}

function artifactArray(value, label, { keyed = false, uniqueBytes = true } = {}) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  const values = value.map((entry, index) => {
    const item = artifact(entry, `${label}[${index}]`);
    return keyed
      ? { keyHash: sha256(entry.keyHash, `${label}[${index}] keyHash`), ...item }
      : item;
  });
  const keys = keyed ? values.map(item => item.keyHash) : [];
  const hashes = values.map(item => item.sha256);
  if ((keyed && new Set(keys).size !== keys.length)
    || (uniqueBytes && new Set(hashes).size !== hashes.length)) {
    throw new Error(`${label} must contain unique keys and byte digests.`);
  }
  return values;
}

function positiveNumber(value, label) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive finite number.`);
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

function gitObjectId(value, label) {
  if (!/^[a-f0-9]{40}$/i.test(String(value ?? ''))) {
    throw new Error(`${label} must be an exact Git object ID.`);
  }
  return value;
}

function sha256(value, label) {
  if (!/^[a-f0-9]{64}$/.test(String(value ?? ''))) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function canonicalTimestamp(value, label) {
  const timestamp = string(value, label);
  if (!Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) {
    throw new Error(`${label} must be a canonical ISO timestamp.`);
  }
  return timestamp;
}

function nullableTimestamp(value, label) {
  if (value === null || value === undefined) return null;
  return canonicalTimestamp(value, label);
}
