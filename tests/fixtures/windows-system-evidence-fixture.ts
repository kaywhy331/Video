import type { ValidationSource } from '../../scripts/validation-source.mjs';
import type { WindowsSystemEvidence } from '../../scripts/windows-system-evidence.mjs';

export const WINDOWS_SYSTEM_FIXTURE_SOURCE: ValidationSource = {
  commit: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  ref: 'refs/heads/main',
  repository: 'fixture/video',
  workflowCommit: 'a'.repeat(40),
  runId: '123',
  runAttempt: '1',
  dirty: false
};

export function windowsSystemEvidenceFixture(): WindowsSystemEvidence {
  const qualifierSha256 = 'c'.repeat(64);
  const storage = [
    {
      kind: 'read_only', pathType: 'local', pathSha256: '7'.repeat(64), observed: 'read_only', matched: true,
      exists: true, directory: true, writable: false, freeBytes: 100 * 1024 ** 3,
      statErrorCode: null, writeErrorCode: 'EACCES', timedOut: false
    },
    {
      kind: 'missing', pathType: 'local', pathSha256: '8'.repeat(64), observed: 'missing', matched: true,
      exists: false, directory: false, writable: false, freeBytes: null,
      statErrorCode: 'ENOENT', writeErrorCode: null, timedOut: false
    },
    {
      kind: 'offline_nas', pathType: 'unc', pathSha256: '9'.repeat(64), observed: 'offline_nas', matched: true,
      exists: false, directory: false, writable: false, freeBytes: null,
      statErrorCode: 'ENETUNREACH', writeErrorCode: null, timedOut: false
    },
    {
      kind: 'insufficient_space', pathType: 'local', pathSha256: 'd'.repeat(64), observed: 'insufficient_space', matched: true,
      exists: true, directory: true, writable: true, freeBytes: 1024 ** 3,
      statErrorCode: null, writeErrorCode: null, timedOut: false
    }
  ];

  const observations = (['nvidia', 'intel', 'amd'] as const).map((hardwareClass, index) => {
    const encoder = {
      nvidia: ['nvencAdvertised', 'nvencUsable'],
      intel: ['qsvAdvertised', 'qsvUsable'],
      amd: ['amfAdvertised', 'amfUsable']
    }[hardwareClass];
    const diagnostics: Record<string, string | number | boolean> = {
      platform: 'win32-x64', status: 'pass', issuesCount: 0,
      pathsReady: true, databaseReady: true, ffmpegFound: true, ffprobeFound: true,
      mediaEncoded: true, mediaProbed: true,
      nvencAdvertised: false, nvencUsable: false,
      qsvAdvertised: false, qsvUsable: false,
      amfAdvertised: false, amfUsable: false,
      softwareAdvertised: true, softwareUsable: true
    };
    diagnostics[encoder[0]!] = true;
    diagnostics[encoder[1]!] = true;
    const observedStorage = index === 0 ? storage : [];
    return {
      observationSha256: String(index + 1).repeat(64),
      observationSizeBytes: 4096 + index,
      capturedAt: `2026-08-26T12:00:0${index}.000Z`,
      runner: {
        platform: 'win32', architecture: 'x64', osVersion: `Windows fixture ${index + 1}`,
        ci: false, hardwareClass,
        machineFingerprintSha256: String(index + 4).repeat(64),
        deviceClassSha256: String(index + 7).repeat(64)
      },
      environment: {
        cleanMachine: true, developerEnvironmentPresent: false,
        developerCommandsPresent: [], dataRootInitiallyAbsent: true
      },
      artifacts: {
        verifiedChecksums: 14,
        installer: {
          name: 'VideoFactory-Desktop-0.1.0-alpha.7-x64.exe',
          sizeBytes: 100_000_000,
          sha256: 'e'.repeat(64)
        },
        releaseProvenanceSha256: 'f'.repeat(64),
        qualifierSha256
      },
      installation: {
        install: { status: 'passed', exitCode: 0, durationMs: 1_000 },
        executableSha256: '0'.repeat(64), executablePresent: true, uninstallerPresent: true,
        launch: { status: 'passed', exitCode: 0, durationMs: 2_000 },
        databaseInitialized: true, databaseSizeBytes: 98_304, firstRunSetupObserved: true,
        uninstall: { status: 'passed', exitCode: 0, durationMs: 1_500 },
        installDirectoryRemoved: true
      },
      eventStream: { sha256: String(index + 1).repeat(64), eventCount: 4 + observedStorage.length },
      diagnostics,
      renderer: {
        activeView: 'settings', initialSetupRequired: true, setupReady: false,
        setupChecklistVisible: true
      },
      storage: observedStorage,
      storageIntegrity: {
        probeCount: observedStorage.length,
        matchedCount: observedStorage.length,
        databaseIntegrity: 'ok', databaseChangesBefore: 0, databaseChangesAfter: 0,
        databaseUnchanged: true
      }
    };
  });

  return {
    schemaVersion: 1,
    evidenceKind: 'videofactory-windows-system-matrix',
    harness: 'videofactory-windows-system-matrix',
    generatedAt: '2026-08-26T13:00:00.000Z',
    appVersion: '0.1.0-alpha.7',
    qualification: 'release',
    source: { ...WINDOWS_SYSTEM_FIXTURE_SOURCE },
    qualifierSha256,
    observations,
    claimedGateIds: ['SYS-001', 'SYS-003', 'SYS-004'],
    result: 'passed'
  };
}
