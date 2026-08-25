export type ValidationQualification = 'development' | 'release';

export type ValidationSource = {
  commit: string;
  tree: string;
  ref: string;
  repository: string;
  workflowCommit: string | null;
  runId: string | null;
  runAttempt: string | null;
  dirty: boolean;
};

export type ValidationAdmission = {
  admittedAt: string;
  qualification: ValidationQualification;
  source: ValidationSource;
};

export const VALIDATION_QUALIFICATIONS: readonly ValidationQualification[];
export function parseValidationQualification(args?: string[]): ValidationQualification;
export function captureValidationSource(
  root?: string,
  environment?: Record<string, string | undefined>
): ValidationSource;
export function assertValidationSource(
  source: ValidationSource,
  qualification: ValidationQualification,
  label?: string
): ValidationSource;
export function admitValidationSource(options?: {
  root?: string;
  qualification?: ValidationQualification;
  environment?: Record<string, string | undefined>;
}): ValidationAdmission;
export function assertValidationSourceStable(
  admission: ValidationAdmission,
  options?: {
    root?: string;
    environment?: Record<string, string | undefined>;
  }
): ValidationSource;
