import type { ProductionRecoveryAssessment, ProductionRecoveryEvidence } from './production-recovery-evidence.mjs';
import type { ValidationSource } from './validation-source.mjs';

export const PRODUCTION_RECOVERY_OBSERVATION_VERSION: 1;
export const PRODUCTION_RECOVERY_OBSERVATION_KIND: 'videofactory-production-recovery-observation';

export function collectProductionRecoveryEvidence(options: {
  observationPaths: string[];
  source: ValidationSource;
  appVersion: string;
  mode?: 'supporting' | 'qualification';
  now?: Date;
}): {
  receipt: ProductionRecoveryEvidence;
  assessment: ProductionRecoveryAssessment;
};
