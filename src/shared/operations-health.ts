import type { OperationsHealth } from './types';

export interface OperationsHealthInput {
  spentUsd: number;
  limitUsd: number;
  freeBytes: number | null;
  minimumBytes: number;
  providers: OperationsHealth['providers'];
  runningTypes: string[];
  activeProjectStates: string[];
}

export function classifyOperationsHealth(input: OperationsHealthInput): OperationsHealth {
  const spentUsd = Math.max(0, Number.isFinite(input.spentUsd) ? input.spentUsd : 0);
  const limitUsd = Math.max(0, Number.isFinite(input.limitUsd) ? input.limitUsd : 0);
  const budgetRatio = limitUsd > 0 ? spentUsd / limitUsd : Number.POSITIVE_INFINITY;
  const freeBytes = input.freeBytes === null || !Number.isFinite(input.freeBytes)
    ? null
    : Math.max(0, input.freeBytes);
  const minimumBytes = Math.max(0, Number.isFinite(input.minimumBytes) ? input.minimumBytes : 0);
  return {
    budget: {
      spentUsd,
      limitUsd,
      remainingUsd: Math.max(0, limitUsd - spentUsd),
      status: budgetRatio >= 1 ? 'blocked' : budgetRatio >= 0.8 ? 'warning' : 'healthy'
    },
    disk: {
      freeBytes,
      minimumBytes,
      status: freeBytes === null
        ? 'unknown'
        : freeBytes < minimumBytes
          ? 'blocked'
          : minimumBytes > 0 && freeBytes < minimumBytes * 1.25
            ? 'warning'
            : 'healthy'
    },
    providers: input.providers.map(provider => ({ ...provider })),
    workers: {
      media: input.runningTypes.some(type => /media|footage|ingest|vision/.test(type))
        || input.activeProjectStates.some(state => ['INGESTING_MEDIA', 'VERIFYING_FOOTAGE'].includes(state)) ? 'active' : 'idle',
      render: input.runningTypes.some(type => type.startsWith('render_'))
        || input.activeProjectStates.some(state => ['RENDERING_DRAFT', 'RENDERING_FINAL'].includes(state)) ? 'active' : 'idle',
      upload: input.runningTypes.some(type => type.includes('upload'))
        || input.activeProjectStates.some(state => ['UPLOADING_PRIVATE', 'WAITING_YOUTUBE_PROCESSING'].includes(state)) ? 'active' : 'idle',
      runningTypes: [...input.runningTypes]
    }
  };
}
