export type HistoricalReleaseEvidence = Record<string, unknown>;

export function assertReleaseEvidenceIndex<T extends HistoricalReleaseEvidence>(
  index: T,
  label?: string
): T;
