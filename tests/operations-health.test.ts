import { describe, expect, it } from 'vitest';
import { classifyOperationsHealth } from '@shared/operations-health';

const gib = 1024 ** 3;
const base = {
  spentUsd: 0,
  limitUsd: 100,
  freeBytes: 100 * gib,
  minimumBytes: 25 * gib,
  providers: [],
  runningTypes: [],
  activeProjectStates: []
};

describe('operations health classification', () => {
  it('classifies exact budget warning/block thresholds including a zero hard limit', () => {
    expect(classifyOperationsHealth({ ...base, spentUsd: 79.99 }).budget.status).toBe('healthy');
    expect(classifyOperationsHealth({ ...base, spentUsd: 80 }).budget.status).toBe('warning');
    expect(classifyOperationsHealth({ ...base, spentUsd: 100 }).budget).toMatchObject({ status: 'blocked', remainingUsd: 0 });
    expect(classifyOperationsHealth({ ...base, spentUsd: 0, limitUsd: 0 }).budget.status).toBe('blocked');
  });

  it('classifies unavailable, blocked, warning, and healthy disk capacity exactly', () => {
    expect(classifyOperationsHealth({ ...base, freeBytes: null }).disk.status).toBe('unknown');
    expect(classifyOperationsHealth({ ...base, freeBytes: 24.99 * gib }).disk.status).toBe('blocked');
    expect(classifyOperationsHealth({ ...base, freeBytes: 30 * gib }).disk.status).toBe('warning');
    expect(classifyOperationsHealth({ ...base, freeBytes: 31.25 * gib }).disk.status).toBe('healthy');
  });

  it('reports provider receipts and worker activity from jobs or project states', () => {
    const providers = [{
      provider: 'youtube', status: 'quota_exhausted' as const, message: 'Daily quota reached', checkedAt: '2026-08-20T00:00:00.000Z'
    }];
    expect(classifyOperationsHealth({
      ...base,
      providers,
      runningTypes: ['media_analyze', 'render_final'],
      activeProjectStates: ['WAITING_YOUTUBE_PROCESSING']
    })).toMatchObject({
      providers,
      workers: { media: 'active', render: 'active', upload: 'active', runningTypes: ['media_analyze', 'render_final'] }
    });
  });
});
