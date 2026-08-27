import { assertValidationSource } from './validation-source.mjs';

export const WINDOWS_PACKAGE_RUNTIME_RECEIPT_VERSION = 3;
export const WINDOWS_PACKAGE_RUNTIME_ROWS = 26_000;
export const WINDOWS_PACKAGE_RUNTIME_GATE_IDS = Object.freeze(['SYS-005', 'SYS-006']);

const requiredHarnessChecks = Object.freeze([
  'trayReady',
  'catalogWorkerObservedActive',
  'powerBlockerObservedStarted',
  'windowCloseHiddenToTray',
  'processAliveAfterWindowClose',
  'catalogWorkerObservedActiveWhileHidden',
  'catalogWorkerCompletedWhileHidden',
  'powerBlockerObservedStopped',
  'powerBlockerCoveredWork',
  'shutdownStarted',
  'shutdownCompleted',
  'orderlyQuit',
  'eventSequenceValid'
]);

export function assessWindowsPackageRuntimeEvidence(document) {
  const receipt = record(document, 'Windows package runtime receipt');
  if (receipt.receiptVersion !== WINDOWS_PACKAGE_RUNTIME_RECEIPT_VERSION) {
    throw new Error(
      `Windows package runtime receipt must use version ${WINDOWS_PACKAGE_RUNTIME_RECEIPT_VERSION}.`
    );
  }
  if (!Number.isFinite(Date.parse(string(receipt.generatedAt, 'receipt generatedAt')))) {
    throw new Error('Windows package runtime receipt generatedAt is not an ISO timestamp.');
  }
  string(receipt.appVersion, 'receipt appVersion');
  assertValidationSource(receipt.source, 'release', 'Windows package runtime receipt source');

  const runner = record(receipt.runner, 'Windows package runtime runner');
  const qualification = record(receipt.qualification, 'Windows package runtime qualification');
  const lifecycleClaim = record(
    qualification.windowsRuntimeLifecycle,
    'Windows package runtime lifecycle qualification'
  );
  const claimedGateIds = stringArray(lifecycleClaim.qualifiedGateIds, 'qualified gate IDs').sort();
  if (JSON.stringify(claimedGateIds) !== JSON.stringify([...WINDOWS_PACKAGE_RUNTIME_GATE_IDS].sort())) {
    throw new Error('Windows package runtime receipt may qualify only SYS-005 and SYS-006.');
  }

  const checks = record(receipt.checks, 'Windows package runtime checks');
  for (const name of ['archiveLaunch', 'installerInstall', 'installedLaunch', 'uninstall']) {
    record(checks[name], `${name} check`);
  }
  const archive = record(checks.archiveLaunch, 'archive package launch');
  const archiveApp = record(archive.app, 'archive package app');
  const installed = record(checks.installedLaunch, 'installed package launch');
  const installedApp = record(installed.app, 'installed package app');
  const installedLifecycle = record(installed.lifecycle, 'installed package lifecycle');
  const runtime = record(installed.runtimeQualification, 'installed runtime qualification');
  if (runtime.schemaVersion !== 1) {
    throw new Error('Installed runtime qualification must use schema version 1.');
  }

  const workload = record(runtime.workload, 'installed runtime workload');
  positiveInteger(workload.sourceSizeBytes, 'installed runtime workload sourceSizeBytes');
  string(workload.operationId, 'installed runtime workload operationId');
  string(workload.source, 'installed runtime workload source');
  const runtimeChecks = record(runtime.checks, 'installed runtime checks');
  for (const name of requiredHarnessChecks) {
    if (typeof runtimeChecks[name] !== 'boolean') {
      throw new Error(`Installed runtime check ${name} must be Boolean.`);
    }
  }

  if (!Array.isArray(runtime.events) || runtime.events.length < 7) {
    throw new Error('Installed runtime qualification must contain its ordered main-process events.');
  }
  const events = runtime.events.map((value, index) => {
    const event = record(value, `installed runtime event ${index + 1}`);
    if (event.schemaVersion !== 1 || event.sequence !== index + 1) {
      throw new Error('Installed runtime events have an invalid schema or sequence.');
    }
    if (!Number.isFinite(Date.parse(string(event.at, `installed runtime event ${index + 1} timestamp`)))) {
      throw new Error(`Installed runtime event ${index + 1} has an invalid timestamp.`);
    }
    positiveInteger(event.pid, `installed runtime event ${index + 1} pid`);
    string(event.event, `installed runtime event ${index + 1} name`);
    record(event.details, `installed runtime event ${index + 1} details`);
    return event;
  });
  if (new Set(events.map(event => event.pid)).size !== 1) {
    throw new Error('Installed runtime events must come from one packaged main process.');
  }
  for (let index = 1; index < events.length; index += 1) {
    if (Date.parse(events[index].at) < Date.parse(events[index - 1].at)) {
      throw new Error('Installed runtime event timestamps are out of order.');
    }
  }

  const qualificationStarted = event(events, 'qualification_started');
  const trayReady = event(events, 'tray_ready');
  const powerStarted = event(events, 'power_blocker_started');
  const windowHidden = event(events, 'window_hidden_to_tray');
  const powerStopped = event(events, 'power_blocker_stopped');
  const shutdownStarted = event(events, 'shutdown_started');
  const shutdownCompleted = event(events, 'shutdown_completed');
  const eventOrder = [
    qualificationStarted,
    trayReady,
    powerStarted,
    windowHidden,
    powerStopped,
    shutdownStarted,
    shutdownCompleted
  ].every((value, index, ordered) => index === 0 || value.sequence > ordered[index - 1].sequence);

  const lifecycleMeasured = {
    packagedWindowsX64: runner.platform === 'win32' && runner.architecture === 'x64',
    hostedScopeExplicit: qualification.validation === 'release'
      && qualification.scope === 'hosted_windows_package_smoke'
      && qualification.cleanMachine === false
      && qualification.developerToolingPresent === true
      && qualification.productionQualification === false,
    lifecycleClaimPassed: lifecycleClaim.status === 'passed',
    packageLifecyclePassed: receipt.status === 'passed'
      && checks.archiveLaunch.status === 'passed'
      && checks.installerInstall.status === 'passed'
      && installed.status === 'passed'
      && checks.uninstall.status === 'passed'
      && installedApp.isPackaged === true
      && installed.kind === 'installed'
      && installedLifecycle.orderlyQuit === true,
    archiveFirstRunSetupObserved: initialSetupObserved(archiveApp, 'archive package app'),
    installedFirstRunSetupObserved: initialSetupObserved(installedApp, 'installed package app'),
    fullCatalogWorkerCompleted: workload.kind === 'catalog_preview'
      && workload.requestedRows === WINDOWS_PACKAGE_RUNTIME_ROWS
      && workload.completedRows === WINDOWS_PACKAGE_RUNTIME_ROWS,
    harnessChecksPassed: runtime.status === 'passed'
      && requiredHarnessChecks.every(name => runtimeChecks[name] === true),
    trayObserved: trayReady.details.available === true,
    hiddenWindowObserved: windowHidden.details.visible === false
      && windowHidden.details.destroyed === false,
    blockerObserved: powerStarted.details.started === true
      && powerStarted.details.mode === 'prevent-app-suspension'
      && powerStopped.details.wasStarted === true
      && powerStopped.details.reason === 'operation_complete'
      && powerStopped.details.blockerId === powerStarted.details.blockerId,
    orderlyEventSequence: qualificationStarted.sequence === 1 && eventOrder
  };
  const externalQualificationPassed = Object.values(lifecycleMeasured).every(Boolean);
  const acceptance = Object.fromEntries(WINDOWS_PACKAGE_RUNTIME_GATE_IDS.map(id => [
    id,
    externalQualificationPassed ? 'qualified' : 'failed'
  ]));

  return {
    receiptVersion: receipt.receiptVersion,
    generatedAt: receipt.generatedAt,
    appVersion: receipt.appVersion,
    source: receipt.source,
    qualifiedGateIds: [...WINDOWS_PACKAGE_RUNTIME_GATE_IDS],
    lifecycleMeasured,
    acceptance,
    externalQualificationPassed
  };
}

function initialSetupObserved(app, label) {
  const setup = record(app.initialSetup, `${label} initial setup`);
  return setup.activeView === 'settings'
    && setup.initialSetupRequired === true
    && setup.setupReady === false
    && setup.checklistVisible === true;
}

function event(events, name) {
  const matches = events.filter(value => value.event === name);
  if (matches.length !== 1) {
    throw new Error(`Installed runtime event stream must contain exactly one ${name} event.`);
  }
  return matches[0];
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

function stringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array.`);
  const values = value.map((entry, index) => string(entry, `${label}[${index}]`));
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicates.`);
  return values;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
  return value;
}
