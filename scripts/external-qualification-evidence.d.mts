import type { ElectronPerformanceEvidence } from './electron-performance-evidence.mjs';
import type { ValidationSource } from './validation-source.mjs';
import type { WindowsPackageRuntimeAssessment } from './windows-package-runtime-evidence.mjs';
import type { ProductionPilotEvidence } from './production-pilot-evidence.mjs';

export type ExternalQualificationReceiptKind =
  | 'production_pilot'
  | 'electron_performance'
  | 'windows_package_runtime';

export interface FileEvidence {
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface ExternalQualificationIndex {
  schemaVersion: 1;
  evidenceKind: 'videofactory-external-qualification-index';
  generatedAt: string;
  qualification: 'release';
  source: ValidationSource;
  receipts: Array<{
    kind: ExternalQualificationReceiptKind;
    path: string;
    sha256: string;
    sizeBytes: number;
  }>;
}

export interface ExternalQualificationAdmission {
  present: boolean;
  indexPath?: string;
  index: FileEvidence | null;
  receipts: Array<{
    kind: ExternalQualificationReceiptKind;
    evidence: FileEvidence;
    qualifiedIds: string[];
    assessment: ProductionPilotEvidence | ElectronPerformanceEvidence | WindowsPackageRuntimeAssessment;
  }>;
  qualifiedIds: string[];
  qualifiedById: Record<string, {
    kind: ExternalQualificationReceiptKind;
    evidence: FileEvidence;
  }>;
}

export const EXTERNAL_QUALIFICATION_INDEX_SCHEMA_VERSION: 1;
export const EXTERNAL_QUALIFICATION_INDEX_KIND: 'videofactory-external-qualification-index';
export const EXTERNAL_QUALIFICATION_INDEX_PATH: 'validation/external-qualification/index.json';
export const ELECTRON_PERFORMANCE_RECEIPT_KIND: 'electron_performance';
export const ELECTRON_PERFORMANCE_RECEIPT_PATH: 'validation/results/electron-performance.json';
export const WINDOWS_PACKAGE_RUNTIME_RECEIPT_KIND: 'windows_package_runtime';
export const WINDOWS_PACKAGE_RUNTIME_RECEIPT_PATH: 'release/WINDOWS_PACKAGE_SMOKE.json';
export const PRODUCTION_PILOT_RECEIPT_KIND: 'production_pilot';
export const PRODUCTION_PILOT_RECEIPT_PATH: 'validation/results/production-pilot.json';
export const EXTERNAL_QUALIFICATION_GATE_IDS: readonly string[];

export function writeElectronPerformanceQualificationIndex(options?: {
  root?: string;
  source?: ValidationSource;
  receiptPath?: string;
  indexPath?: string;
  now?: Date;
}): ExternalQualificationAdmission;

export function writeWindowsPackageRuntimeQualificationIndex(options?: {
  root?: string;
  source?: ValidationSource;
  receiptPath?: string;
  indexPath?: string;
  now?: Date;
}): ExternalQualificationAdmission;

export function writeProductionPilotQualificationIndex(options?: {
  root?: string;
  source?: ValidationSource;
  receiptPath?: string;
  indexPath?: string;
  now?: Date;
}): ExternalQualificationAdmission;

export function admitExternalQualificationEvidence(options?: {
  root?: string;
  indexPath?: string;
  source?: ValidationSource;
  allowedIds?: readonly string[] | Set<string>;
}): ExternalQualificationAdmission;
