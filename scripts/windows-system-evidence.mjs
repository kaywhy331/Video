import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertValidationSource } from './validation-source.mjs';

export const WINDOWS_SYSTEM_EVIDENCE_SCHEMA_VERSION = 1;
export const WINDOWS_SYSTEM_OBSERVATION_VERSION = 1;
export const WINDOWS_SYSTEM_EVIDENCE_KIND = 'videofactory-windows-system-matrix';
export const WINDOWS_SYSTEM_OBSERVATION_KIND = 'videofactory-windows-system-observation';
export const WINDOWS_SYSTEM_HARNESS = 'videofactory-windows-system-matrix';
export const WINDOWS_SYSTEM_GATE_IDS = Object.freeze(['SYS-001', 'SYS-003', 'SYS-004']);
export const WINDOWS_SYSTEM_HARDWARE_CLASSES = Object.freeze(['nvidia', 'intel', 'amd', 'software']);
export const WINDOWS_SYSTEM_REQUIRED_HARDWARE = Object.freeze(['nvidia', 'intel', 'amd']);
export const WINDOWS_SYSTEM_STORAGE_KINDS = Object.freeze([
  'read_only',
  'missing',
  'offline_nas',
  'insufficient_space'
]);
export const WINDOWS_SYSTEM_MINIMUM_FREE_BYTES = 25 * 1024 ** 3;

const sha256Pattern = /^[a-f0-9]{64}$/u;
const deviceClassPattern = /^[A-Za-z0-9][A-Za-z0-9._ -]{2,79}$/u;

export function collectWindowsSystemEvidence({
  observationPaths,
  source,
  appVersion,
  qualifierPath = 'scripts/windows/qualify-windows-system.ps1',
  now = new Date()
}) {
  if (!Array.isArray(observationPaths) || observationPaths.length < 3 || observationPaths.length > 10) {
    throw new Error('Windows system qualification requires three to ten observation files.');
  }
  assertValidationSource(source, 'release', 'Windows system collection source');
  nonEmptyString(appVersion, 'Windows system appVersion');
  const qualifierBytes = readFileSync(resolve(qualifierPath));
  const qualifierSha256 = sha256(qualifierBytes);
  const seenPaths = new Set();
  const observations = observationPaths.map((path, index) => {
    const resolvedPath = resolve(path);
    if (seenPaths.has(resolvedPath)) throw new Error('Windows system observation paths must be unique.');
    seenPaths.add(resolvedPath);
    const bytes = readFileSync(resolvedPath);
    const raw = parseJson(bytes, `Windows system observation ${index + 1}`);
    exactKeys(raw, [
      'observationVersion', 'evidenceKind', 'capturedAt', 'appVersion', 'source',
      'runner', 'environment', 'artifacts', 'installation', 'eventStream',
      'diagnostics', 'renderer', 'storage', 'storageIntegrity'
    ], `Windows system observation ${index + 1}`);
    if (raw.observationVersion !== WINDOWS_SYSTEM_OBSERVATION_VERSION) {
      throw new Error(`Windows system observation ${index + 1} has an unsupported version.`);
    }
    if (raw.evidenceKind !== WINDOWS_SYSTEM_OBSERVATION_KIND) {
      throw new Error(`Windows system observation ${index + 1} has an unknown evidence identity.`);
    }
    isoTimestamp(raw.capturedAt, `Windows system observation ${index + 1} capturedAt`);
    if (raw.appVersion !== appVersion) {
      throw new Error(`Windows system observation ${index + 1} has the wrong app version.`);
    }
    assertValidationSource(raw.source, 'release', `Windows system observation ${index + 1} source`);
    assertSameSource(raw.source, source, `Windows system observation ${index + 1}`);
    const runner = record(raw.runner, `Windows system observation ${index + 1} runner`);
    exactKeys(runner, [
      'platform', 'architecture', 'osVersion', 'ci', 'deviceClass',
      'machineFingerprintSha256', 'hardwareClass'
    ], `Windows system observation ${index + 1} runner`);
    const deviceClass = nonEmptyString(runner.deviceClass, `Windows system observation ${index + 1} deviceClass`);
    if (!deviceClassPattern.test(deviceClass)) {
      throw new Error(`Windows system observation ${index + 1} deviceClass is not a bounded non-sensitive label.`);
    }
    const artifacts = record(raw.artifacts, `Windows system observation ${index + 1} artifacts`);
    if (artifacts.qualifierSha256 !== qualifierSha256) {
      throw new Error(`Windows system observation ${index + 1} was produced by a different qualifier script.`);
    }
    return {
      observationSha256: sha256(bytes),
      observationSizeBytes: statSync(resolvedPath).size,
      capturedAt: raw.capturedAt,
      runner: {
        platform: runner.platform,
        architecture: runner.architecture,
        osVersion: runner.osVersion,
        ci: runner.ci,
        hardwareClass: runner.hardwareClass,
        machineFingerprintSha256: runner.machineFingerprintSha256,
        deviceClassSha256: sha256(`videofactory-windows-device-class:v1:${deviceClass}`)
      },
      environment: raw.environment,
      artifacts: raw.artifacts,
      installation: raw.installation,
      eventStream: raw.eventStream,
      diagnostics: raw.diagnostics,
      renderer: raw.renderer,
      storage: raw.storage,
      storageIntegrity: raw.storageIntegrity
    };
  }).sort((left, right) => (
    String(left.runner.hardwareClass).localeCompare(String(right.runner.hardwareClass))
    || left.runner.deviceClassSha256.localeCompare(right.runner.deviceClassSha256)
  ));

  const receipt = {
    schemaVersion: WINDOWS_SYSTEM_EVIDENCE_SCHEMA_VERSION,
    evidenceKind: WINDOWS_SYSTEM_EVIDENCE_KIND,
    harness: WINDOWS_SYSTEM_HARNESS,
    generatedAt: now.toISOString(),
    appVersion,
    qualification: 'release',
    source,
    qualifierSha256,
    observations,
    claimedGateIds: [...WINDOWS_SYSTEM_GATE_IDS],
    result: 'passed'
  };
  const assessed = assessWindowsSystemEvidence(receipt);
  if (!assessed.externalQualificationPassed) {
    throw new Error(`Windows system observations do not satisfy qualification: ${assessed.failures.join('; ')}`);
  }
  return { receipt, assessment: assessed };
}

export function assessWindowsSystemEvidence(document) {
  const receipt = record(document, 'Windows system receipt');
  exactKeys(receipt, [
    'schemaVersion', 'evidenceKind', 'harness', 'generatedAt', 'appVersion',
    'qualification', 'source', 'qualifierSha256', 'observations', 'claimedGateIds', 'result'
  ], 'Windows system receipt');
  if (receipt.schemaVersion !== WINDOWS_SYSTEM_EVIDENCE_SCHEMA_VERSION) {
    throw new Error(`Windows system receipt must use schema version ${WINDOWS_SYSTEM_EVIDENCE_SCHEMA_VERSION}.`);
  }
  if (receipt.evidenceKind !== WINDOWS_SYSTEM_EVIDENCE_KIND || receipt.harness !== WINDOWS_SYSTEM_HARNESS) {
    throw new Error('Windows system receipt has an unknown evidence identity.');
  }
  isoTimestamp(receipt.generatedAt, 'Windows system receipt generatedAt');
  nonEmptyString(receipt.appVersion, 'Windows system receipt appVersion');
  if (receipt.qualification !== 'release') throw new Error('Windows system qualification must be release scoped.');
  assertValidationSource(receipt.source, 'release', 'Windows system receipt source');
  sha256Value(receipt.qualifierSha256, 'Windows system qualifierSha256');
  const claimedGateIds = stringArray(receipt.claimedGateIds, 'Windows system claimedGateIds').sort();
  if (JSON.stringify(claimedGateIds) !== JSON.stringify([...WINDOWS_SYSTEM_GATE_IDS].sort())) {
    throw new Error('Windows system receipt may qualify only SYS-001, SYS-003, and SYS-004.');
  }
  if (receipt.result !== 'passed') throw new Error('Windows system receipt result must be passed.');
  if (!Array.isArray(receipt.observations) || receipt.observations.length < 3 || receipt.observations.length > 10) {
    throw new Error('Windows system receipt must contain three to ten observations.');
  }

  const failures = [];
  const observations = receipt.observations.map((value, index) =>
    assessObservation(value, index, failures, receipt.appVersion));
  unique(observations.map(value => value.observationSha256), 'observation SHA-256');
  unique(observations.map(value => value.runner.deviceClassSha256), 'device class SHA-256');
  unique(observations.map(value => value.runner.machineFingerprintSha256), 'machine fingerprint SHA-256');
  if (!observations.every(value => value.qualifierSha256 === receipt.qualifierSha256)) {
    throw new Error('Windows system observations were not produced by the receipt qualifier script.');
  }
  const artifactIdentities = observations.map(value => JSON.stringify({
    installerName: value.installerName,
    installerSizeBytes: value.installerSizeBytes,
    installerSha256: value.installerSha256,
    releaseProvenanceSha256: value.releaseProvenanceSha256
  }));
  if (new Set(artifactIdentities).size !== 1) {
    throw new Error('Windows system observations must exercise one identical released installer and provenance document.');
  }

  const cleanInstallPassed = observations.some(value => value.cleanInstallPassed);
  if (!cleanInstallPassed) failures.push('no clean packaged first-run install/uninstall observation passed');

  const hardwareMatrixPassed = WINDOWS_SYSTEM_REQUIRED_HARDWARE.every(hardwareClass => {
    const candidate = observations.find(value => value.runner.hardwareClass === hardwareClass);
    if (!candidate?.hardwarePassed) {
      failures.push(`${hardwareClass} hardware encoder observation is missing or failed`);
      return false;
    }
    return true;
  }) && observations.every(value => value.softwareFallbackPassed);
  if (!observations.every(value => value.softwareFallbackPassed)) {
    failures.push('software H.264 fallback did not pass on every representative device');
  }

  const storageByKind = new Map();
  for (const observation of observations) {
    for (const storage of observation.storage) {
      if (!storageByKind.has(storage.kind) && storage.passed) storageByKind.set(storage.kind, storage);
    }
  }
  const storageMatrixPassed = WINDOWS_SYSTEM_STORAGE_KINDS.every(kind => {
    if (!storageByKind.has(kind)) {
      failures.push(`${kind} storage failure mode is missing or failed`);
      return false;
    }
    return true;
  }) && observations.every(value => value.storageIntegrityPassed);
  if (!observations.every(value => value.storageIntegrityPassed)) {
    failures.push('a storage probe changed or corrupted application database state');
  }

  const targetEligible = observations.every(value => value.targetEligible);
  const externalQualificationPassed = targetEligible
    && cleanInstallPassed
    && hardwareMatrixPassed
    && storageMatrixPassed
    && failures.length === 0;
  const acceptance = Object.fromEntries(WINDOWS_SYSTEM_GATE_IDS.map(id => [
    id,
    externalQualificationPassed ? 'qualified' : 'failed'
  ]));

  return {
    schemaVersion: receipt.schemaVersion,
    generatedAt: receipt.generatedAt,
    appVersion: receipt.appVersion,
    source: receipt.source,
    qualifierSha256: receipt.qualifierSha256,
    installerSha256: observations[0].installerSha256,
    installerSizeBytes: observations[0].installerSizeBytes,
    releaseProvenanceSha256: observations[0].releaseProvenanceSha256,
    qualifiedGateIds: [...WINDOWS_SYSTEM_GATE_IDS],
    observationCount: observations.length,
    cleanInstallPassed,
    hardwareMatrixPassed,
    storageMatrixPassed,
    targetEligible,
    failures: [...new Set(failures)],
    acceptance,
    externalQualificationPassed
  };
}

function assessObservation(value, index, failures, appVersion) {
  const label = `Windows system observation ${index + 1}`;
  const observation = record(value, label);
  exactKeys(observation, [
    'observationSha256', 'observationSizeBytes', 'capturedAt', 'runner',
    'environment', 'artifacts', 'installation', 'eventStream', 'diagnostics',
    'renderer', 'storage', 'storageIntegrity'
  ], label);
  sha256Value(observation.observationSha256, `${label} observationSha256`);
  positiveInteger(observation.observationSizeBytes, `${label} observationSizeBytes`);
  isoTimestamp(observation.capturedAt, `${label} capturedAt`);

  const runner = record(observation.runner, `${label} runner`);
  exactKeys(runner, [
    'platform', 'architecture', 'osVersion', 'ci', 'hardwareClass',
    'machineFingerprintSha256', 'deviceClassSha256'
  ], `${label} runner`);
  if (!WINDOWS_SYSTEM_HARDWARE_CLASSES.includes(runner.hardwareClass)) {
    throw new Error(`${label} has an unsupported hardware class.`);
  }
  nonEmptyString(runner.platform, `${label} platform`);
  nonEmptyString(runner.architecture, `${label} architecture`);
  if (typeof runner.ci !== 'boolean') throw new Error(`${label} ci must be Boolean.`);
  sha256Value(runner.deviceClassSha256, `${label} deviceClassSha256`);
  sha256Value(runner.machineFingerprintSha256, `${label} machineFingerprintSha256`);
  const targetEligible = runner.platform === 'win32'
    && runner.architecture === 'x64'
    && runner.ci === false
    && nonEmptyString(runner.osVersion, `${label} osVersion`).length > 0;
  if (!targetEligible) failures.push(`${label} is not a non-CI Windows x64 observation`);

  const environment = record(observation.environment, `${label} environment`);
  exactKeys(environment, [
    'cleanMachine', 'developerEnvironmentPresent', 'developerCommandsPresent', 'dataRootInitiallyAbsent'
  ], `${label} environment`);
  if (!Array.isArray(environment.developerCommandsPresent)) {
    throw new Error(`${label} developerCommandsPresent must be an array.`);
  }
  for (const key of ['cleanMachine', 'developerEnvironmentPresent', 'dataRootInitiallyAbsent']) {
    if (typeof environment[key] !== 'boolean') throw new Error(`${label} ${key} must be Boolean.`);
  }
  environment.developerCommandsPresent.forEach((value, commandIndex) =>
    nonEmptyString(value, `${label} developerCommandsPresent[${commandIndex}]`));

  const artifacts = record(observation.artifacts, `${label} artifacts`);
  exactKeys(artifacts, [
    'verifiedChecksums', 'installer', 'releaseProvenanceSha256', 'qualifierSha256'
  ], `${label} artifacts`);
  positiveInteger(artifacts.verifiedChecksums, `${label} verifiedChecksums`);
  const installer = record(artifacts.installer, `${label} installer`);
  exactKeys(installer, ['name', 'sizeBytes', 'sha256'], `${label} installer`);
  if (nonEmptyString(installer.name, `${label} installer name`) !== `VideoFactory-Desktop-${appVersion}-x64.exe`) {
    throw new Error(`${label} installer name is not canonical.`);
  }
  positiveInteger(installer.sizeBytes, `${label} installer sizeBytes`);
  sha256Value(installer.sha256, `${label} installer sha256`);
  sha256Value(artifacts.releaseProvenanceSha256, `${label} releaseProvenanceSha256`);
  sha256Value(artifacts.qualifierSha256, `${label} qualifierSha256`);

  const installation = record(observation.installation, `${label} installation`);
  exactKeys(installation, [
    'install', 'executableSha256', 'executablePresent', 'uninstallerPresent',
    'launch', 'databaseInitialized', 'databaseSizeBytes', 'firstRunSetupObserved',
    'uninstall', 'installDirectoryRemoved'
  ], `${label} installation`);
  const install = processResult(installation.install, `${label} install`);
  const launch = processResult(installation.launch, `${label} launch`);
  const uninstall = processResult(installation.uninstall, `${label} uninstall`);
  sha256Value(installation.executableSha256, `${label} executableSha256`);
  for (const key of [
    'executablePresent', 'uninstallerPresent', 'databaseInitialized',
    'firstRunSetupObserved', 'installDirectoryRemoved'
  ]) {
    if (typeof installation[key] !== 'boolean') throw new Error(`${label} ${key} must be Boolean.`);
  }
  positiveInteger(installation.databaseSizeBytes, `${label} databaseSizeBytes`);

  const eventStream = record(observation.eventStream, `${label} eventStream`);
  exactKeys(eventStream, ['sha256', 'eventCount'], `${label} eventStream`);
  sha256Value(eventStream.sha256, `${label} eventStream sha256`);
  positiveInteger(eventStream.eventCount, `${label} eventStream eventCount`);
  if (eventStream.eventCount < 4) throw new Error(`${label} event stream is incomplete.`);

  const renderer = record(observation.renderer, `${label} renderer`);
  exactKeys(renderer, [
    'activeView', 'initialSetupRequired', 'setupReady', 'setupChecklistVisible'
  ], `${label} renderer`);
  nonEmptyString(renderer.activeView, `${label} renderer activeView`);
  for (const key of ['initialSetupRequired', 'setupReady', 'setupChecklistVisible']) {
    if (typeof renderer[key] !== 'boolean') throw new Error(`${label} renderer ${key} must be Boolean.`);
  }
  const cleanInstallPassed = environment.cleanMachine === true
    && environment.developerEnvironmentPresent === false
    && environment.developerCommandsPresent.length === 0
    && environment.dataRootInitiallyAbsent === true
    && artifacts.verifiedChecksums >= 10
    && install.passed
    && launch.passed
    && uninstall.passed
    && installation.executablePresent === true
    && installation.uninstallerPresent === true
    && installation.databaseInitialized === true
    && Number.isSafeInteger(installation.databaseSizeBytes)
    && installation.databaseSizeBytes > 0
    && installation.firstRunSetupObserved === true
    && installation.installDirectoryRemoved === true
    && renderer.activeView === 'settings'
    && renderer.initialSetupRequired === true
    && renderer.setupReady === false
    && renderer.setupChecklistVisible === true;

  const diagnostics = record(observation.diagnostics, `${label} diagnostics`);
  const diagnosticKeys = [
    'platform', 'status', 'issuesCount', 'pathsReady', 'databaseReady', 'ffmpegFound',
    'ffprobeFound', 'mediaEncoded', 'mediaProbed', 'nvencAdvertised', 'nvencUsable',
    'qsvAdvertised', 'qsvUsable', 'amfAdvertised', 'amfUsable',
    'softwareAdvertised', 'softwareUsable'
  ];
  exactKeys(diagnostics, diagnosticKeys, `${label} diagnostics`);
  nonEmptyString(diagnostics.platform, `${label} diagnostics platform`);
  nonEmptyString(diagnostics.status, `${label} diagnostics status`);
  nonNegativeInteger(diagnostics.issuesCount, `${label} diagnostics issuesCount`);
  for (const key of diagnosticKeys.slice(3)) {
    if (typeof diagnostics[key] !== 'boolean') throw new Error(`${label} diagnostics ${key} must be Boolean.`);
  }
  const hardwareKey = {
    nvidia: ['nvencAdvertised', 'nvencUsable'],
    intel: ['qsvAdvertised', 'qsvUsable'],
    amd: ['amfAdvertised', 'amfUsable'],
    software: ['softwareAdvertised', 'softwareUsable']
  }[runner.hardwareClass];
  const diagnosticBasePassed = diagnostics.platform === 'win32-x64'
    && (diagnostics.status === 'pass'
      || (runner.hardwareClass === 'software' && diagnostics.status === 'warning'))
    && diagnostics.issuesCount === 0
    && diagnostics.pathsReady === true
    && diagnostics.databaseReady === true
    && diagnostics.ffmpegFound === true
    && diagnostics.ffprobeFound === true
    && diagnostics.mediaEncoded === true
    && diagnostics.mediaProbed === true;
  const hardwarePassed = diagnosticBasePassed
    && hardwareKey.every(key => diagnostics[key] === true);
  const softwareFallbackPassed = diagnosticBasePassed
    && diagnostics.softwareAdvertised === true
    && diagnostics.softwareUsable === true;

  if (!Array.isArray(observation.storage)) throw new Error(`${label} storage must be an array.`);
  const storage = observation.storage.map((item, storageIndex) =>
    assessStorage(item, `${label} storage ${storageIndex + 1}`));
  unique(storage.map(item => item.pathSha256), `${label} storage path SHA-256`);
  const integrity = record(observation.storageIntegrity, `${label} storageIntegrity`);
  exactKeys(integrity, [
    'probeCount', 'matchedCount', 'databaseIntegrity', 'databaseChangesBefore',
    'databaseChangesAfter', 'databaseUnchanged'
  ], `${label} storageIntegrity`);
  nonNegativeInteger(integrity.probeCount, `${label} storageIntegrity probeCount`);
  nonNegativeInteger(integrity.matchedCount, `${label} storageIntegrity matchedCount`);
  nonNegativeInteger(integrity.databaseChangesBefore, `${label} storageIntegrity databaseChangesBefore`);
  nonNegativeInteger(integrity.databaseChangesAfter, `${label} storageIntegrity databaseChangesAfter`);
  if (typeof integrity.databaseUnchanged !== 'boolean') {
    throw new Error(`${label} storageIntegrity databaseUnchanged must be Boolean.`);
  }
  nonEmptyString(integrity.databaseIntegrity, `${label} storageIntegrity databaseIntegrity`);
  const storageIntegrityPassed = Number.isSafeInteger(integrity.probeCount)
    && integrity.probeCount === storage.length
    && Number.isSafeInteger(integrity.matchedCount)
    && integrity.matchedCount === storage.filter(item => item.passed).length
    && integrity.databaseIntegrity === 'ok'
    && Number.isSafeInteger(integrity.databaseChangesBefore)
    && integrity.databaseChangesAfter === integrity.databaseChangesBefore
    && integrity.databaseUnchanged === true;

  return {
    observationSha256: observation.observationSha256,
    runner,
    targetEligible,
    cleanInstallPassed,
    hardwarePassed,
    softwareFallbackPassed,
    storage,
    storageIntegrityPassed,
    qualifierSha256: artifacts.qualifierSha256,
    installerName: installer.name,
    installerSizeBytes: installer.sizeBytes,
    installerSha256: installer.sha256,
    releaseProvenanceSha256: artifacts.releaseProvenanceSha256
  };
}

function assessStorage(value, label) {
  const storage = record(value, label);
  exactKeys(storage, [
    'kind', 'pathType', 'pathSha256', 'observed', 'matched', 'exists', 'directory', 'writable',
    'freeBytes', 'statErrorCode', 'writeErrorCode', 'timedOut'
  ], label);
  if (!WINDOWS_SYSTEM_STORAGE_KINDS.includes(storage.kind)) throw new Error(`${label} has an unknown kind.`);
  if (!['local', 'unc'].includes(storage.pathType)) throw new Error(`${label} has an unknown path type.`);
  sha256Value(storage.pathSha256, `${label} pathSha256`);
  nonEmptyString(storage.observed, `${label} observed`);
  for (const key of ['matched', 'exists', 'directory', 'writable', 'timedOut']) {
    if (typeof storage[key] !== 'boolean') throw new Error(`${label} ${key} must be Boolean.`);
  }
  if (storage.freeBytes !== null) nonNegativeInteger(storage.freeBytes, `${label} freeBytes`);
  for (const key of ['statErrorCode', 'writeErrorCode']) {
    if (storage[key] !== null && !/^[A-Z0-9_]{1,40}$/u.test(String(storage[key]))) {
      throw new Error(`${label} ${key} must be null or a bounded error code.`);
    }
  }
  const passed = storage.matched === true && storage.observed === storage.kind && (
    (storage.kind === 'missing'
      && storage.pathType === 'local'
      && storage.exists === false
      && typeof storage.statErrorCode === 'string')
    || (storage.kind === 'offline_nas'
      && storage.pathType === 'unc'
      && storage.exists === false
      && (storage.timedOut === true || typeof storage.statErrorCode === 'string'))
    || (storage.kind === 'read_only'
      && storage.exists === true
      && storage.directory === true
      && storage.writable === false
      && typeof storage.writeErrorCode === 'string')
    || (storage.kind === 'insufficient_space'
      && storage.exists === true
      && storage.directory === true
      && storage.writable === true
      && Number.isFinite(storage.freeBytes)
      && storage.freeBytes >= 0
      && storage.freeBytes < WINDOWS_SYSTEM_MINIMUM_FREE_BYTES)
  );
  return { kind: storage.kind, pathSha256: storage.pathSha256, passed };
}

function processResult(value, label) {
  const result = record(value, label);
  exactKeys(result, ['status', 'exitCode', 'durationMs'], label);
  nonEmptyString(result.status, `${label} status`);
  if (!Number.isSafeInteger(result.exitCode)) throw new Error(`${label} exitCode must be an integer.`);
  nonNegativeInteger(result.durationMs, `${label} durationMs`);
  return {
    passed: result.status === 'passed'
      && result.exitCode === 0
      && Number.isSafeInteger(result.durationMs)
      && result.durationMs >= 0
  };
}

function assertSameSource(left, right, label) {
  for (const key of ['commit', 'tree']) {
    if ((left[key] ?? null) !== (right[key] ?? null)) {
      throw new Error(`${label} source ${key} does not match the exact collection source.`);
    }
  }
  if (left.dirty !== false || right.dirty !== false) {
    throw new Error(`${label} source must be clean on the target and collector.`);
  }
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(record(value, label)).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} fields must be exactly: ${wanted.join(', ')}.`);
  }
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty trimmed string.`);
  }
  return value;
}

function stringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array.`);
  const values = value.map((entry, index) => nonEmptyString(entry, `${label}[${index}]`));
  unique(values, label);
  return values;
}

function unique(values, label) {
  if (new Set(values).size !== values.length) throw new Error(`${label} values must be unique.`);
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer.`);
  return value;
}

function sha256Value(value, label) {
  if (!sha256Pattern.test(String(value ?? ''))) throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  return value;
}

function isoTimestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp.`);
  }
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, ''));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
