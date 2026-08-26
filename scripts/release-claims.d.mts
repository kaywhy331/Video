import type { ValidationInputDigest } from './validation-input.mjs';
import type { HistoricalReleaseEvidence } from './release-evidence.mjs';

export type ReleaseEvidenceEntry = {
  path: string;
  index: HistoricalReleaseEvidence;
};

export type ReleaseClaimDocuments = Record<string, string>;

export const RELEASE_EVIDENCE_README: string;

export function loadReleaseClaimDocuments(root?: string): ReleaseClaimDocuments;

export function assertReleaseClaims(
  input: {
    indexes: ReleaseEvidenceEntry[];
    documents: ReleaseClaimDocuments;
  },
  label?: string
): Record<string, number | boolean>;

export function assertReleaseClaimDigestCoverage(
  root: string | undefined,
  indexes: ReleaseEvidenceEntry[]
): ValidationInputDigest;
