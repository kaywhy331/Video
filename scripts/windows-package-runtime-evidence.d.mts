import type { ValidationSource } from './validation-source.mjs';

export type WindowsPackageRuntimeGateId = 'SYS-005' | 'SYS-006';

export interface WindowsPackageRuntimeAssessment {
  receiptVersion: 3;
  generatedAt: string;
  appVersion: string;
  source: ValidationSource;
  qualifiedGateIds: WindowsPackageRuntimeGateId[];
  lifecycleMeasured: Record<string, boolean>;
  acceptance: Record<WindowsPackageRuntimeGateId, 'qualified' | 'failed'>;
  externalQualificationPassed: boolean;
}

export const WINDOWS_PACKAGE_RUNTIME_RECEIPT_VERSION: 3;
export const WINDOWS_PACKAGE_RUNTIME_ROWS: 26000;
export const WINDOWS_PACKAGE_RUNTIME_GATE_IDS: readonly WindowsPackageRuntimeGateId[];

export function assessWindowsPackageRuntimeEvidence(document: unknown): WindowsPackageRuntimeAssessment;
