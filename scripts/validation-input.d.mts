export type ValidationInputFile = {
  path: string;
  sizeBytes: number;
  sha256: string;
};

export type ValidationInputDigest = {
  sha256: string;
  fileCount: number;
  files: ValidationInputFile[];
};

export const RUNTIME_INPUTS: readonly string[];
export const RUNTIME_NORMATIVE_DOCUMENTS: readonly string[];
export const RELEASE_CLAIM_DOCUMENTS: readonly string[];
export const CLAIMS_INPUTS: readonly string[];

export function validationInputDigest(root?: string): ValidationInputDigest;
export function runtimeInputDigest(root?: string): ValidationInputDigest;
export function claimsInputDigest(root?: string): ValidationInputDigest;
export function validationInputDigests(root?: string): {
  runtime: ValidationInputDigest;
  claims: ValidationInputDigest;
};
