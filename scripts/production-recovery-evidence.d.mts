import type { ValidationSource } from './validation-source.mjs';

export type ProductionRecoveryDrillKind =
  | 'provider'
  | 'ingest'
  | 'render'
  | 'upload_session'
  | 'upload_commit'
  | 'restore';

export interface ProductionRecoveryEvidence {
  schemaVersion: 1;
  evidenceKind: 'videofactory-production-recovery';
  harness: 'videofactory-production-recovery';
  generatedAt: string;
  appVersion: string;
  mode: 'supporting' | 'qualification';
  source: ValidationSource;
  environment: {
    platform: string;
    architecture: string;
    release: string;
    node: string;
    ci: boolean;
    deviceClassSha256: string;
    machineFingerprintSha256: string;
  };
  application: {
    packaged: boolean;
    executableSha256: string;
    releaseProvenanceSha256: string;
    releaseCommit: string;
    releaseTree: string;
  };
  observations: Array<Record<string, unknown>>;
  claimedGateIds: ['E2E-004'];
  result: 'passed';
}

export interface ProductionRecoveryAssessment {
  schemaVersion: number;
  generatedAt: string;
  appVersion: string;
  mode: 'supporting' | 'qualification';
  source: ValidationSource;
  environment: Record<string, unknown>;
  application: Record<string, unknown>;
  qualifiedGateIds: string[];
  observationCount: number;
  fieldCriteria: Record<string, boolean>;
  observationAssessments: Array<{
    kind: ProductionRecoveryDrillKind;
    commonPassed: boolean;
    stagePassed: boolean;
    checks: Record<string, boolean>;
  }>;
  targetEligibility: {
    eligible: boolean;
    checks: Record<string, boolean>;
    reasons: string[];
  };
  fieldCriteriaPassed: boolean;
  acceptance: Record<'E2E-004', 'qualified' | 'supporting' | 'failed'>;
  externalQualificationPassed: boolean;
}

export const PRODUCTION_RECOVERY_SCHEMA_VERSION: 1;
export const PRODUCTION_RECOVERY_EVIDENCE_KIND: 'videofactory-production-recovery';
export const PRODUCTION_RECOVERY_HARNESS: 'videofactory-production-recovery';
export const PRODUCTION_RECOVERY_GATE_IDS: readonly ['E2E-004'];
export const PRODUCTION_RECOVERY_DRILL_KINDS: readonly ProductionRecoveryDrillKind[];

export function assessProductionRecoveryEvidence(document: unknown): ProductionRecoveryAssessment;
export function assessProductionRecoveryObservation(document: unknown): {
  kind: ProductionRecoveryDrillKind;
  commonPassed: boolean;
  stagePassed: boolean;
  checks: Record<string, boolean>;
};
