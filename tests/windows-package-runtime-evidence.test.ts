import { describe, expect, it } from 'vitest';
import {
  WINDOWS_PACKAGE_RUNTIME_GATE_IDS,
  assessWindowsPackageRuntimeEvidence
} from '../scripts/windows-package-runtime-evidence.mjs';

function receipt() {
  const names = [
    ['qualification_started', { packaged: true }],
    ['tray_ready', { available: true, imageEmpty: false }],
    ['power_blocker_started', { blockerId: 7, started: true, mode: 'prevent-app-suspension' }],
    ['window_hidden_to_tray', { visible: false, destroyed: false }],
    ['power_blocker_stopped', { blockerId: 7, wasStarted: true, reason: 'operation_complete' }],
    ['shutdown_started', {}],
    ['shutdown_completed', {}]
  ] as const;
  const checks = Object.fromEntries([
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
  ].map(name => [name, true]));
  return {
    receiptVersion: 3,
    status: 'passed',
    generatedAt: '2026-08-26T12:00:00.000Z',
    appVersion: '0.1.0-alpha.7',
    source: {
      commit: 'a'.repeat(40), tree: 'b'.repeat(40), ref: 'refs/heads/main', repository: 'fixture/video',
      workflowCommit: 'a'.repeat(40), runId: '1', runAttempt: '1', dirty: false
    },
    runner: { platform: 'win32', architecture: 'x64' },
    qualification: {
      validation: 'release', scope: 'hosted_windows_package_smoke', cleanMachine: false,
      developerToolingPresent: true, productionQualification: false,
      windowsRuntimeLifecycle: { status: 'passed', qualifiedGateIds: ['SYS-005', 'SYS-006'] }
    },
    checks: {
      archiveLaunch: { status: 'passed' },
      installerInstall: { status: 'passed' },
      installedLaunch: {
        status: 'passed', kind: 'installed', app: { isPackaged: true }, lifecycle: { orderlyQuit: true },
        runtimeQualification: {
          schemaVersion: 1, status: 'passed',
          workload: {
            kind: 'catalog_preview', operationId: 'runtime-1', source: 'catalog.xlsx',
            sourceSizeBytes: 1_000_000, requestedRows: 26_000, completedRows: 26_000
          },
          checks,
          events: names.map(([event, details], index) => ({
            schemaVersion: 1,
            sequence: index + 1,
            at: new Date(Date.parse('2026-08-26T12:00:01.000Z') + index * 100).toISOString(),
            event,
            pid: 100,
            details
          }))
        }
      },
      uninstall: { status: 'passed' }
    }
  };
}

describe('Windows package runtime evidence', () => {
  it('[SYS-005][SYS-006] qualifies only tray/background and power lifecycle gates', () => {
    const assessed = assessWindowsPackageRuntimeEvidence(receipt());
    expect(assessed.externalQualificationPassed).toBe(true);
    expect(assessed.qualifiedGateIds).toEqual(WINDOWS_PACKAGE_RUNTIME_GATE_IDS);
    expect(assessed.acceptance).toEqual({ 'SYS-005': 'qualified', 'SYS-006': 'qualified' });
    expect('SYS-001' in assessed.acceptance).toBe(false);
  });

  it('fails closed when the worker was not observed active while hidden', () => {
    const value = receipt();
    value.checks.installedLaunch.runtimeQualification.checks.catalogWorkerObservedActiveWhileHidden = false;
    expect(assessWindowsPackageRuntimeEvidence(value).externalQualificationPassed).toBe(false);
  });

  it('rejects a blocker release that does not match its start lease', () => {
    const value = receipt();
    const stop = value.checks.installedLaunch.runtimeQualification.events[4]!;
    stop.details = { blockerId: 8, wasStarted: true, reason: 'operation_complete' };
    expect(assessWindowsPackageRuntimeEvidence(value).externalQualificationPassed).toBe(false);
  });
});
