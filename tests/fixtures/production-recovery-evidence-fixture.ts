import { createHash } from 'node:crypto';
import {
  PRODUCTION_RECOVERY_EVIDENCE_KIND,
  PRODUCTION_RECOVERY_HARNESS,
  type ProductionRecoveryEvidence,
  type ProductionRecoveryDrillKind
} from '../../scripts/production-recovery-evidence.mjs';
import type { ValidationSource } from '../../scripts/validation-source.mjs';

export function recoveryDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function evidence(kind: ProductionRecoveryDrillKind): Record<string, unknown> {
  if (kind === 'provider') {
    return {
      productionProviders: true,
      completedCallSha256sBefore: [recoveryDigest('provider-call-1')],
      completedCallSha256sAfter: [recoveryDigest('provider-call-1')],
      replayedCompletedCallSha256s: [],
      paidCallCountBefore: 1,
      paidCallCountAfter: 1,
      estimatedCostMicrosBefore: 50_000,
      estimatedCostMicrosAfter: 50_000,
      repeatedEstimatedCostMicros: 0
    };
  }
  if (kind === 'ingest') {
    return {
      licensedSource: true,
      sourceSha256: recoveryDigest('licensed-source'),
      checkpointPhaseBefore: 'original_preserved',
      checkpointPhaseAfter: 'complete',
      assetStateBefore: 'FILE_STABLE',
      assetStateAfter: 'COMPLETE',
      sourceHashVerified: true,
      derivativesVerified: true,
      managedPartialCountAfter: 0,
      unmanagedPathTouched: false
    };
  }
  if (kind === 'render') {
    return {
      licensedInputs: true,
      jobType: 'render_final',
      phaseBefore: 'Assembling timeline',
      renderStateBefore: 'RUNNING',
      renderStateAfter: 'SUCCEEDED',
      outputSha256: recoveryDigest('final-output'),
      manifestSha256: recoveryDigest('final-manifest'),
      mediaProbePassed: true,
      managedPartialCountAfter: 0,
      unmanagedPathTouched: false
    };
  }
  if (kind === 'upload_session' || kind === 'upload_commit') {
    return {
      liveGoogleApi: true,
      oauthAuthorized: true,
      uploadSessionSha256Before: recoveryDigest(`session-${kind}`),
      uploadSessionSha256After: recoveryDigest(`session-${kind}`),
      videoIdSha256Before: kind === 'upload_commit' ? recoveryDigest('remote-video-commit') : null,
      videoIdSha256After: recoveryDigest(kind === 'upload_commit' ? 'remote-video-commit' : 'remote-video-session'),
      publicationCountBefore: 1,
      publicationCountAfter: 1,
      reconciliationOutcome: kind === 'upload_commit' ? 'remote_effect_reused' : 'remote_session_reused',
      attachmentsComplete: true,
      processingSucceeded: true
    };
  }
  return {
    representativeData: true,
    backupSha256: recoveryDigest('backup-source'),
    stagedSha256: recoveryDigest('backup-source'),
    restoredSourceSha256: recoveryDigest('backup-source'),
    safetyBackupSha256: recoveryDigest('pre-restore-safety'),
    safetyBackupIntegrity: 'ok',
    pendingMarkerBefore: true,
    completionMarkerAfter: false,
    artifactRebuildStatus: 'passed',
    missingOriginalsCount: 0
  };
}

function observation(kind: ProductionRecoveryDrillKind, index: number): Record<string, unknown> {
  const minute = String(index * 4).padStart(2, '0');
  return {
    kind,
    observationSha256: recoveryDigest(`observation-${kind}`),
    observationSizeBytes: 4_096 + index,
    startedAt: `2026-08-26T20:${minute}:00.000Z`,
    killedAt: `2026-08-26T20:${String(index * 4 + 1).padStart(2, '0')}:00.000Z`,
    restartedAt: `2026-08-26T20:${String(index * 4 + 2).padStart(2, '0')}:00.000Z`,
    completedAt: `2026-08-26T20:${String(index * 4 + 3).padStart(2, '0')}:00.000Z`,
    process: {
      terminationMethod: 'windows_terminate_process',
      forced: true,
      processTree: true,
      exitObserved: true,
      initialPidSha256: recoveryDigest(`initial-pid-${kind}`),
      restartedPidSha256: recoveryDigest(`restarted-pid-${kind}`)
    },
    database: {
      schemaVersionBefore: 24,
      schemaVersionAfter: 24,
      integrityBefore: 'ok',
      integrityAfter: 'ok',
      foreignKeyViolationsBefore: 0,
      foreignKeyViolationsAfter: 0
    },
    work: {
      identitySha256: recoveryDigest(`work-${kind}`),
      inputSha256: recoveryDigest(`input-${kind}`),
      stateBefore: 'RUNNING',
      stateAfter: 'SUCCEEDED',
      attemptBefore: 1,
      attemptAfter: 2,
      recoveredFromCheckpoint: true,
      completed: true
    },
    evidence: evidence(kind)
  };
}

export function qualifyingProductionRecoveryEvidence(options: {
  source?: ValidationSource;
  appVersion?: string;
} = {}): ProductionRecoveryEvidence {
  const kinds: ProductionRecoveryDrillKind[] = [
    'provider',
    'ingest',
    'render',
    'upload_session',
    'upload_commit',
    'restore'
  ];
  const exactSource = options.source ?? {
    commit: 'a'.repeat(40),
    tree: 'b'.repeat(40),
    ref: 'main',
    repository: 'owner/repository',
    workflowCommit: null,
    runId: null,
    runAttempt: null,
    dirty: false
  };
  return {
    schemaVersion: 1,
    evidenceKind: PRODUCTION_RECOVERY_EVIDENCE_KIND,
    harness: PRODUCTION_RECOVERY_HARNESS,
    generatedAt: '2026-08-26T21:00:00.000Z',
    appVersion: options.appVersion ?? '0.1.0-alpha.7',
    mode: 'qualification',
    source: exactSource,
    environment: {
      platform: 'win32',
      architecture: 'x64',
      release: '10.0.26100',
      node: 'v22.22.0',
      ci: false,
      deviceClassSha256: recoveryDigest('operator-workstation'),
      machineFingerprintSha256: recoveryDigest('machine-guid-salted')
    },
    application: {
      packaged: true,
      executableSha256: recoveryDigest('packaged-executable'),
      releaseProvenanceSha256: recoveryDigest('release-provenance'),
      releaseCommit: exactSource.commit,
      releaseTree: exactSource.tree
    },
    observations: kinds.map(observation),
    claimedGateIds: ['E2E-004'],
    result: 'passed'
  };
}

export function qualifyingProductionRecoveryObservation(
  kind: ProductionRecoveryDrillKind,
  options: { source?: ValidationSource; appVersion?: string } = {}
): Record<string, unknown> {
  const receipt = qualifyingProductionRecoveryEvidence(options);
  const observation = receipt.observations.find(value => value.kind === kind) as any;
  const index = receipt.observations.indexOf(observation) + 1;
  return {
    observationVersion: 1,
    evidenceKind: 'videofactory-production-recovery-observation',
    capturedAt: observation.completedAt,
    appVersion: receipt.appVersion,
    mode: receipt.mode,
    source: structuredClone(receipt.source),
    environment: {
      platform: receipt.environment.platform,
      architecture: receipt.environment.architecture,
      release: receipt.environment.release,
      node: receipt.environment.node,
      ci: receipt.environment.ci,
      deviceClass: 'representative-operator-workstation',
      machineFingerprintSha256: receipt.environment.machineFingerprintSha256
    },
    application: structuredClone(receipt.application),
    kind,
    startedAt: observation.startedAt,
    killedAt: observation.killedAt,
    restartedAt: observation.restartedAt,
    completedAt: observation.completedAt,
    process: {
      terminationMethod: observation.process.terminationMethod,
      forced: observation.process.forced,
      processTree: observation.process.processTree,
      exitObserved: observation.process.exitObserved,
      initialPid: 10_000 + index,
      restartedPid: 20_000 + index
    },
    database: structuredClone(observation.database),
    work: {
      identity: `private-project-and-work-id-${kind}`,
      inputSha256: observation.work.inputSha256,
      stateBefore: observation.work.stateBefore,
      stateAfter: observation.work.stateAfter,
      attemptBefore: observation.work.attemptBefore,
      attemptAfter: observation.work.attemptAfter,
      recoveredFromCheckpoint: observation.work.recoveredFromCheckpoint,
      completed: observation.work.completed
    },
    evidence: structuredClone(observation.evidence)
  };
}
