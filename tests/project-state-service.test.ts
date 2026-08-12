import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase } from '@main/database/database';
import { ProjectStateService } from '@main/services/project-state-service';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('durable project transitions', () => {
  it('stores the prior state while blocked and clears it after audited resume', () => {
    const root = mkdtempSync(join(tmpdir(), 'videofactory-project-state-'));
    roots.push(root);
    const db = new AppDatabase(join(root, 'videofactory.sqlite'));
    const now = new Date().toISOString();
    db.raw.prepare(`
      INSERT INTO projects(
        id, sequence, slug, title, topic, state, progress, envato_project_name,
        target_duration_ms, created_at, updated_at
      ) VALUES('project-1', 1, 'project-1', 'Project 1', 'Topic', 'CREATED', 0,
        'YT-TEST-0001', 300000, ?, ?)
    `).run(now, now);
    const states = new ProjectStateService(db);

    states.transition('project-1', 'ANALYZING_OPPORTUNITY', { reason: 'test planning' });
    states.transition('project-1', 'BLOCKED_EXCEPTION', { reason: 'test blocker' });
    expect(db.raw.prepare(`
      SELECT state, resume_state FROM projects WHERE id = 'project-1'
    `).get()).toEqual({ state: 'BLOCKED_EXCEPTION', resume_state: 'ANALYZING_OPPORTUNITY' });

    expect(states.resume('project-1', 'test repair complete')).toBe('ANALYZING_OPPORTUNITY');
    expect(db.raw.prepare(`
      SELECT state, resume_state FROM projects WHERE id = 'project-1'
    `).get()).toEqual({ state: 'ANALYZING_OPPORTUNITY', resume_state: null });
    expect(db.raw.prepare(`
      SELECT count(*) AS count FROM audit_log WHERE project_id = 'project-1'
    `).get()).toEqual({ count: 3 });
    db.close();
  });
});
