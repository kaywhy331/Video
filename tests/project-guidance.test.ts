import { describe, expect, it } from 'vitest';
import { resolveAutopilotGuidance } from '@main/services/project-service';
import type { CoverageCluster } from '@shared/types';

const paris = {
  key: 'france|paris|',
  country: 'France',
  city: 'Paris',
  locationName: null,
  assetCount: 20,
  landscapeCount: 18,
  portraitCount: 2
} as CoverageCluster;

const rome = {
  key: 'italy|rome|',
  country: 'Italy',
  city: 'Rome',
  locationName: null,
  assetCount: 16,
  landscapeCount: 14,
  portraitCount: 2
} as CoverageCluster;

describe('guided Autopilot selection', () => {
  it('makes a qualified topic candidate determine the project title and destination', () => {
    expect(resolveAutopilotGuidance(
      [paris, rome],
      { destinationKey: rome.key, topicId: 'topic-rome' },
      'landscape',
      {
        id: 'topic-rome',
        destinationKey: rome.key,
        title: 'Rome After Dark',
        destination: 'Rome',
        feasibility: 'qualified'
      }
    )).toEqual({ cluster: rome, destination: 'Rome', title: 'Rome After Dark' });
  });

  it('rejects missing, unqualified, mismatched, and stale guided selections', () => {
    expect(() => resolveAutopilotGuidance([paris], { topicId: 'missing' }, 'landscape'))
      .toThrow('does not exist');
    expect(() => resolveAutopilotGuidance([paris], { topicId: 'topic' }, 'landscape', {
      id: 'topic', destinationKey: paris.key, title: 'Paris', destination: 'Paris', feasibility: 'rejected'
    })).toThrow('not production-qualified');
    expect(() => resolveAutopilotGuidance([paris, rome], {
      destinationKey: paris.key, topicId: 'topic'
    }, 'landscape', {
      id: 'topic', destinationKey: rome.key, title: 'Rome', destination: 'Rome', feasibility: 'qualified'
    })).toThrow('does not belong');
    expect(() => resolveAutopilotGuidance([paris], { destinationKey: 'missing' }, 'landscape'))
      .toThrow('unavailable in current catalog coverage');
  });
});
