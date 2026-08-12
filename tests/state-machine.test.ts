import { describe, expect, it } from 'vitest';
import { PROJECT_STATES, assertProjectTransition, canTransitionProject } from '@shared/state-machine';

describe('project state machine', () => {
  it('contains every canonical production state exactly once', () => {
    expect(new Set(PROJECT_STATES).size).toBe(PROJECT_STATES.length);
    expect(PROJECT_STATES).toContain('WAITING_YOUTUBE_PROCESSING');
    expect(PROJECT_STATES).toContain('BLOCKED_EXCEPTION');
    expect(PROJECT_STATES).not.toContain('PLANNING');
  });

  it('allows the documented critical path and blocks unsafe skips', () => {
    const path = [
      'CREATED',
      'ANALYZING_OPPORTUNITY',
      'TOPIC_SELECTED',
      'RESEARCHING',
      'SCRIPTING_PROVISIONAL',
      'STORYBOARD_PROVISIONAL',
      'WAITING_FOR_DOWNLOADS',
      'INGESTING_MEDIA',
      'VERIFYING_FOOTAGE',
      'FINALIZING_SCRIPT',
      'GENERATING_VOICE',
      'BUILDING_TIMELINE',
      'RENDERING_DRAFT',
      'QC_DRAFT',
      'RENDERING_FINAL',
      'QC_FINAL',
      'UPLOADING_PRIVATE',
      'WAITING_YOUTUBE_PROCESSING',
      'WAITING_FINAL_APPROVAL',
      'SCHEDULED',
      'PUBLISHED',
      'ANALYTICS_ACTIVE'
    ] as const;
    for (let index = 0; index < path.length - 1; index += 1) {
      expect(canTransitionProject(path[index]!, path[index + 1]!)).toBe(true);
    }
    expect(() => assertProjectTransition('CREATED', 'PUBLISHED')).toThrow(/Invalid project transition/);
    expect(() => assertProjectTransition('QC_FINAL', 'PUBLISHED')).toThrow(/Invalid project transition/);
  });

  it('supports explicit exception recovery without weakening terminal states', () => {
    expect(canTransitionProject('VERIFYING_FOOTAGE', 'BLOCKED_EXCEPTION')).toBe(true);
    expect(canTransitionProject('BLOCKED_EXCEPTION', 'VERIFYING_FOOTAGE')).toBe(true);
    expect(canTransitionProject('ARCHIVED', 'CREATED')).toBe(false);
  });
});
