import type { ValidationSource } from './validation-source.mjs';

export type WindowsSystemHardwareClass = 'nvidia' | 'intel' | 'amd' | 'software';
export type WindowsSystemStorageKind = 'read_only' | 'missing' | 'offline_nas' | 'insufficient_space';

export interface WindowsSystemEvidence {
  schemaVersion: 1;
  evidenceKind: 'videofactory-windows-system-matrix';
  harness: 'videofactory-windows-system-matrix';
  generatedAt: string;
  appVersion: string;
  qualification: 'release';
  source: ValidationSource;
  qualifierSha256: string;
  observations: Array<Record<string, unknown>>;
  claimedGateIds: ['SYS-001', 'SYS-003', 'SYS-004'];
  result: 'passed';
}

export interface WindowsSystemAssessment {
  schemaVersion: number;
  generatedAt: string;
  appVersion: string;
  source: ValidationSource;
  qualifierSha256: string;
  installerSha256: string;
  installerSizeBytes: number;
  releaseProvenanceSha256: string;
  qualifiedGateIds: string[];
  observationCount: number;
  cleanInstallPassed: boolean;
  hardwareMatrixPassed: boolean;
  storageMatrixPassed: boolean;
  targetEligible: boolean;
  failures: string[];
  acceptance: Record<string, 'qualified' | 'failed'>;
  externalQualificationPassed: boolean;
}

export const WINDOWS_SYSTEM_EVIDENCE_SCHEMA_VERSION: 1;
export const WINDOWS_SYSTEM_OBSERVATION_VERSION: 1;
export const WINDOWS_SYSTEM_EVIDENCE_KIND: 'videofactory-windows-system-matrix';
export const WINDOWS_SYSTEM_OBSERVATION_KIND: 'videofactory-windows-system-observation';
export const WINDOWS_SYSTEM_HARNESS: 'videofactory-windows-system-matrix';
export const WINDOWS_SYSTEM_GATE_IDS: readonly ['SYS-001', 'SYS-003', 'SYS-004'];
export const WINDOWS_SYSTEM_HARDWARE_CLASSES: readonly WindowsSystemHardwareClass[];
export const WINDOWS_SYSTEM_REQUIRED_HARDWARE: readonly ['nvidia', 'intel', 'amd'];
export const WINDOWS_SYSTEM_STORAGE_KINDS: readonly WindowsSystemStorageKind[];
export const WINDOWS_SYSTEM_MINIMUM_FREE_BYTES: number;

export function collectWindowsSystemEvidence(options: {
  observationPaths: string[];
  source: ValidationSource;
  appVersion: string;
  qualifierPath?: string;
  now?: Date;
}): { receipt: WindowsSystemEvidence; assessment: WindowsSystemAssessment };

export function assessWindowsSystemEvidence(document: unknown): WindowsSystemAssessment;
