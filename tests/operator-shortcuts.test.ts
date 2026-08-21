import { describe, expect, it } from 'vitest';
import { resolveOperatorShortcut, selectOperatorTarget } from '@shared/operator-shortcuts';

describe('operator keyboard shortcuts', () => {
  it('maps the five PRD shortcuts only behind Control+Alt', () => {
    expect(['d', 'r', 'a', 'p', 'e'].map(key => resolveOperatorShortcut({
      key, ctrlKey: true, altKey: true
    }))).toEqual(['next_download', 'retry', 'approve', 'pause', 'open_exception']);
    expect(resolveOperatorShortcut({ key: 'd', ctrlKey: false, altKey: true })).toBeNull();
    expect(resolveOperatorShortcut({ key: 'd', ctrlKey: true, altKey: false })).toBeNull();
  });

  it('never fires from editable controls or key repeat', () => {
    expect(resolveOperatorShortcut({
      key: 'a', ctrlKey: true, altKey: true, editableTarget: true
    })).toBeNull();
    expect(resolveOperatorShortcut({
      key: 'p', ctrlKey: true, altKey: true, repeat: true
    })).toBeNull();
  });

  it('targets the open project first, then the oldest candidate deterministically', () => {
    const candidates = [
      { id: 'new', projectId: 'project-new', createdAt: '2026-08-20T12:00:00.000Z' },
      { id: 'old-b', projectId: 'project-old-b', createdAt: '2026-08-19T12:00:00.000Z' },
      { id: 'old-a', projectId: 'project-old-a', createdAt: '2026-08-19T12:00:00.000Z' }
    ];
    expect(selectOperatorTarget(candidates, 'project-new')?.id).toBe('new');
    expect(selectOperatorTarget(candidates, null)?.id).toBe('old-a');
    expect(selectOperatorTarget([], null)).toBeNull();
  });
});
