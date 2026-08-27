export const ELECTRON_PERFORMANCE_SCHEMA_VERSION = 2;
export const ELECTRON_PERFORMANCE_FFMPEG_RESOURCE_POLICY = 'interactive-reserve-v1';
export const ELECTRON_PERFORMANCE_GATE_IDS = Object.freeze([
  'CAT-001',
  'CAT-009',
  'PERF-001',
  'PERF-002',
  'PERF-003'
]);

export const ELECTRON_PERFORMANCE_THRESHOLDS = Object.freeze({
  qualificationRows: 26_000,
  startupUsableMs: 5_000,
  catalogSearchP95Ms: 300,
  uiInteractionP95Ms: 1_000,
  rendererHeartbeatP99Ms: 250,
  scrollFrameP99Ms: 250,
  maximumDomRows: 50,
  minimumBackgroundRenderMs: 1_000
});

export function percentile(samples, quantile) {
  const values = finiteSamples(samples, 'Percentile samples');
  if (values.length === 0) throw new Error('Percentile samples cannot be empty.');
  if (!Number.isFinite(quantile) || quantile <= 0 || quantile > 1) {
    throw new Error('Percentile quantile must be greater than zero and at most one.');
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(quantile * sorted.length) - 1);
  return rounded(sorted[index] ?? sorted[sorted.length - 1]);
}

export function assessElectronPerformanceEvidence(document) {
  const value = record(document, 'Electron performance evidence');
  if (value.schemaVersion !== ELECTRON_PERFORMANCE_SCHEMA_VERSION) {
    throw new Error(`Electron performance evidence must use schema version ${ELECTRON_PERFORMANCE_SCHEMA_VERSION}.`);
  }
  if (value.harness !== 'videofactory-electron-performance') {
    throw new Error('Electron performance evidence has an unknown harness identity.');
  }
  if (!['supporting', 'qualification'].includes(value.mode)) {
    throw new Error('Electron performance evidence mode must be supporting or qualification.');
  }
  if (!Number.isFinite(Date.parse(string(value.generatedAt, 'generatedAt')))) {
    throw new Error('Electron performance evidence generatedAt is not an ISO timestamp.');
  }

  const source = record(value.source, 'source');
  gitObjectId(source.commit, 'source commit');
  gitObjectId(source.tree, 'source tree');
  if (typeof source.dirty !== 'boolean') throw new Error('Electron performance source must record dirty state.');

  const environment = record(value.environment, 'environment');
  const platform = string(environment.platform, 'environment platform');
  const architecture = string(environment.architecture, 'environment architecture');
  const deviceClass = nullableString(environment.deviceClass, 'environment deviceClass');
  if (typeof environment.ci !== 'boolean') throw new Error('Electron performance environment must record CI state.');
  if (environment.productionBuild !== true) throw new Error('Electron performance evidence must exercise a production build.');
  positiveInteger(environment.logicalCpuCount, 'environment logicalCpuCount');
  positiveNumber(environment.totalMemoryBytes, 'environment totalMemoryBytes');

  const fixture = record(value.fixture, 'fixture');
  const requestedRows = positiveInteger(fixture.requestedRows, 'fixture requestedRows');
  sha256(fixture.xlsxSha256, 'fixture xlsxSha256');
  positiveNumber(fixture.xlsxBytes, 'fixture xlsxBytes');

  const measurements = record(value.measurements, 'measurements');
  const importRun = record(measurements.import, 'measurements import');
  const startup = record(measurements.startup, 'measurements startup');
  const catalog = record(measurements.catalog, 'measurements catalog');
  const background = record(measurements.backgroundRender, 'measurements backgroundRender');

  const previewRows = nonNegativeInteger(importRun.previewRows, 'import previewRows');
  const insertedRows = nonNegativeInteger(importRun.insertedRows, 'import insertedRows');
  const committedRows = nonNegativeInteger(importRun.committedRows, 'import committedRows');
  const importedCatalogRows = nonNegativeInteger(importRun.catalogRows, 'import catalogRows');
  const progressEvents = positiveInteger(importRun.progressEvents, 'import progressEvents');
  if (typeof importRun.previewObservedActive !== 'boolean' || typeof importRun.commitObservedActive !== 'boolean') {
    throw new Error('Import evidence must record active preview and commit observations.');
  }
  const previewHeartbeatP99Ms = percentile(requiredSamples(importRun.previewHeartbeatGapsMs, 3, 'preview heartbeat gaps'), 0.99);
  const commitHeartbeatP99Ms = percentile(requiredSamples(importRun.commitHeartbeatGapsMs, 3, 'commit heartbeat gaps'), 0.99);
  const previewNavigationP95Ms = percentile(requiredSamples(importRun.previewNavigationSamplesMs, 3, 'preview navigation samples'), 0.95);
  const commitNavigationP95Ms = percentile(requiredSamples(importRun.commitNavigationSamplesMs, 3, 'commit navigation samples'), 0.95);

  if (startup.warmupCompleted !== true) {
    throw new Error('Startup evidence must record a completed warm-up launch before the measured launch.');
  }
  const warmupUsableMs = nonNegativeNumber(startup.warmupUsableMs, 'startup warmupUsableMs');
  const startupUsableMs = nonNegativeNumber(startup.usableMs, 'startup usableMs');
  const electronLaunchMs = nonNegativeNumber(startup.electronLaunchMs, 'startup electronLaunchMs');
  const rendererReadyMs = nonNegativeNumber(startup.rendererReadyMs, 'startup rendererReadyMs');
  if (Math.abs((electronLaunchMs + rendererReadyMs) - startupUsableMs) > 5) {
    throw new Error('Startup evidence components must reconcile with usableMs.');
  }
  const catalogRows = nonNegativeInteger(catalog.totalRows, 'catalog totalRows');
  const domRows = nonNegativeInteger(catalog.domRows, 'catalog domRows');
  const catalogSearchP95Ms = percentile(requiredSamples(catalog.searchSamplesMs, 5, 'catalog search samples'), 0.95);
  const catalogUiInteractionP95Ms = percentile(requiredSamples(catalog.uiInteractionSamplesMs, 3, 'catalog UI interaction samples'), 0.95);
  const scrollFrameP99Ms = percentile(requiredSamples(catalog.scrollFrameSamplesMs, 10, 'catalog scroll frame samples'), 0.99);
  positiveNumber(catalog.rendererWorkingSetKb, 'catalog rendererWorkingSetKb');

  if (background.engine !== 'ffmpeg-static/libx264') {
    throw new Error('Background performance evidence must use the ffmpeg-static/libx264 load contract.');
  }
  if (background.workload !== 'draft-1080p30-veryfast') {
    throw new Error('Background performance evidence must use the draft-1080p30-veryfast workload.');
  }
  if (background.resourcePolicy !== ELECTRON_PERFORMANCE_FFMPEG_RESOURCE_POLICY) {
    throw new Error(`Background performance evidence must use ${ELECTRON_PERFORMANCE_FFMPEG_RESOURCE_POLICY}.`);
  }
  const backgroundThreadCount = positiveInteger(background.threadCount, 'background threadCount');
  const expectedThreadCount = Math.max(1, Math.min(8, Math.floor(environment.logicalCpuCount) - 2));
  if (backgroundThreadCount !== expectedThreadCount) {
    throw new Error(`Background performance evidence must use ${expectedThreadCount} FFmpeg threads on this host.`);
  }
  if (typeof background.observedRunning !== 'boolean' || typeof background.observedFrameProgress !== 'boolean') {
    throw new Error('Background performance evidence must record process and frame progress observations.');
  }
  const backgroundElapsedMs = nonNegativeNumber(background.elapsedMs, 'background elapsedMs');
  const backgroundHeartbeatP99Ms = percentile(requiredSamples(background.heartbeatGapsMs, 10, 'background heartbeat gaps'), 0.99);
  const backgroundNavigationP95Ms = percentile(requiredSamples(background.navigationSamplesMs, 3, 'background navigation samples'), 0.95);
  const backgroundSearchP95Ms = percentile(requiredSamples(background.searchSamplesMs, 5, 'background search samples'), 0.95);
  positiveNumber(background.rendererWorkingSetKb, 'background rendererWorkingSetKb');

  const countsMatch = previewRows === requestedRows
    && insertedRows === requestedRows
    && committedRows === requestedRows
    && importedCatalogRows === requestedRows
    && catalogRows === requestedRows;
  const fullDataset = requestedRows === ELECTRON_PERFORMANCE_THRESHOLDS.qualificationRows;
  const importResponsive = previewHeartbeatP99Ms < ELECTRON_PERFORMANCE_THRESHOLDS.rendererHeartbeatP99Ms
    && commitHeartbeatP99Ms < ELECTRON_PERFORMANCE_THRESHOLDS.rendererHeartbeatP99Ms
    && previewNavigationP95Ms < ELECTRON_PERFORMANCE_THRESHOLDS.uiInteractionP95Ms
    && commitNavigationP95Ms < ELECTRON_PERFORMANCE_THRESHOLDS.uiInteractionP95Ms;
  const catalogResponsive = catalogSearchP95Ms < ELECTRON_PERFORMANCE_THRESHOLDS.catalogSearchP95Ms
    && catalogUiInteractionP95Ms < ELECTRON_PERFORMANCE_THRESHOLDS.uiInteractionP95Ms;
  const boundedDom = domRows > 0
    && domRows <= ELECTRON_PERFORMANCE_THRESHOLDS.maximumDomRows
    && domRows < catalogRows;
  const scrollResponsive = scrollFrameP99Ms < ELECTRON_PERFORMANCE_THRESHOLDS.scrollFrameP99Ms;
  const backgroundResponsive = background.observedRunning
    && background.observedFrameProgress
    && backgroundElapsedMs >= ELECTRON_PERFORMANCE_THRESHOLDS.minimumBackgroundRenderMs
    && backgroundHeartbeatP99Ms < ELECTRON_PERFORMANCE_THRESHOLDS.rendererHeartbeatP99Ms
    && backgroundNavigationP95Ms < ELECTRON_PERFORMANCE_THRESHOLDS.uiInteractionP95Ms
    && backgroundSearchP95Ms < ELECTRON_PERFORMANCE_THRESHOLDS.catalogSearchP95Ms;

  const measured = {
    'CAT-001': countsMatch
      && importRun.integrity === 'ok'
      && importRun.previewObservedActive
      && importRun.commitObservedActive
      && importResponsive
      && progressEvents > 0,
    'CAT-009': countsMatch && catalogResponsive,
    'PERF-001': startupUsableMs < ELECTRON_PERFORMANCE_THRESHOLDS.startupUsableMs,
    'PERF-002': backgroundResponsive,
    'PERF-003': countsMatch && boundedDom && scrollResponsive
  };
  const smokeCriteriaPassed = Object.values(measured).every(Boolean);
  const fullDatasetCriteriaPassed = fullDataset && smokeCriteriaPassed;

  const targetChecks = {
    qualificationModeRequested: value.mode === 'qualification',
    windowsX64: platform === 'win32' && architecture === 'x64',
    nonCiTarget: environment.ci === false,
    cleanExactSource: source.dirty === false,
    deviceClassRecorded: Boolean(deviceClass && deviceClass.length >= 8),
    fullDataset
  };
  const targetEligible = Object.values(targetChecks).every(Boolean);
  const targetEligibility = {
    eligible: targetEligible,
    checks: targetChecks,
    reasons: Object.entries(targetChecks)
      .filter(([, passed]) => !passed)
      .map(([name]) => eligibilityReason(name))
  };
  const acceptance = Object.fromEntries(ELECTRON_PERFORMANCE_GATE_IDS.map(id => [
    id,
    measured[id]
      ? targetEligible ? 'qualified' : 'supporting'
      : 'failed'
  ]));

  return {
    ...value,
    thresholds: ELECTRON_PERFORMANCE_THRESHOLDS,
    derived: {
      previewHeartbeatP99Ms,
      commitHeartbeatP99Ms,
      previewNavigationP95Ms,
      commitNavigationP95Ms,
      warmupUsableMs: rounded(warmupUsableMs),
      startupUsableMs: rounded(startupUsableMs),
      electronLaunchMs: rounded(electronLaunchMs),
      rendererReadyMs: rounded(rendererReadyMs),
      catalogSearchP95Ms,
      catalogUiInteractionP95Ms,
      scrollFrameP99Ms,
      backgroundElapsedMs: rounded(backgroundElapsedMs),
      backgroundThreadCount,
      backgroundHeartbeatP99Ms,
      backgroundNavigationP95Ms,
      backgroundSearchP95Ms
    },
    targetEligibility,
    acceptance,
    smokeCriteriaPassed,
    fullDatasetCriteriaPassed,
    externalQualificationPassed: targetEligible && fullDatasetCriteriaPassed
  };
}

function eligibilityReason(name) {
  return ({
    qualificationModeRequested: 'Run with --mode=qualification.',
    windowsX64: 'Run on the supported Windows x64 target.',
    nonCiTarget: 'Run on representative operator hardware outside hosted CI.',
    cleanExactSource: 'Run from a clean exact source commit and tree.',
    deviceClassRecorded: 'Record a non-sensitive representative device class.',
    fullDataset: `Run the full ${ELECTRON_PERFORMANCE_THRESHOLDS.qualificationRows.toLocaleString()}-row fixture.`
  })[name] ?? `Unmet target condition: ${name}`;
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function string(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} must be a non-empty string.`);
  return value.trim();
}

function nullableString(value, label) {
  if (value === null || value === undefined) return null;
  return string(value, label);
}

function gitObjectId(value, label) {
  if (!/^[a-f0-9]{40}$/i.test(String(value ?? ''))) throw new Error(`${label} must be an exact Git object ID.`);
  return value;
}

function sha256(value, label) {
  if (!/^[a-f0-9]{64}$/i.test(String(value ?? ''))) throw new Error(`${label} must be a SHA-256 digest.`);
  return value;
}

function nonNegativeNumber(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative finite number.`);
  return value;
}

function positiveNumber(value, label) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive finite number.`);
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer.`);
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
  return value;
}

function finiteSamples(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value.map((sample, index) => nonNegativeNumber(sample, `${label}[${index}]`));
}

function requiredSamples(value, minimum, label) {
  const samples = finiteSamples(value, label);
  if (samples.length < minimum) throw new Error(`${label} must contain at least ${minimum} samples.`);
  return samples;
}

function rounded(value) {
  return Math.round(value * 1000) / 1000;
}
