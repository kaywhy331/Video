export const PRODUCTION_RECOVERY_SNAPSHOT_VERSION: 1;
export const PRODUCTION_RECOVERY_SNAPSHOT_KIND: 'videofactory-production-recovery-snapshot';

export function listProductionRecoveryCandidates(options: {
  databasePath: string;
  kind: string;
}): {
  kind: string;
  schemaVersion: number;
  candidates: Array<Record<string, unknown>>;
};

export function captureProductionRecoverySnapshot(options: {
  databasePath: string;
  kind: string;
  workId: string;
  phase: 'before' | 'after';
  releaseProvenancePath: string;
  appExecutablePath: string;
  processId: number;
  now?: Date;
}): Record<string, unknown>;

export function finalizeProductionRecoveryObservation(options: {
  before: unknown;
  after: unknown;
  process: unknown;
}): Record<string, unknown>;

export function productionRecoveryEnvironment(
  deviceClass: string,
  machineFingerprintSha256: string
): Record<string, unknown>;
