export type HistoricalReleaseEvidence = Record<string, unknown>;

export function assertReleaseEvidenceIndex<T extends HistoricalReleaseEvidence>(
  index: T,
  label?: string
): T;

export function assertReleaseEvidenceGitBinding<T extends HistoricalReleaseEvidence>(
  index: T,
  options: { root?: string; indexPath: string },
  label?: string
): T;
