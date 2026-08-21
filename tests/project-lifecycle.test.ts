import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase } from '@main/database/database';
import { ProjectService } from '@main/services/project-service';
import { JobService } from '@main/services/job-service';
import type { AppSettings, ProjectState } from '@shared/types';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(state: ProjectState = 'ANALYZING_OPPORTUNITY') {
  const root = mkdtempSync(join(tmpdir(), 'videofactory-project-lifecycle-'));
  roots.push(root);
  const db = new AppDatabase(join(root, 'db.sqlite'));
  const now = new Date().toISOString();
  db.raw.prepare(`
    INSERT INTO projects(
      id, sequence, slug, title, topic, state, progress, envato_project_name,
      target_duration_ms, created_at, updated_at
    ) VALUES('project-1', 1, 'project-1', 'Project', 'Topic', ?, 0.1,
      'YT-TEST-0001', 300000, ?, ?)
  `).run(state, now, now);
  const service = new ProjectService(
    db,
    {} as never,
    {} as never,
    () => ({}) as AppSettings,
    {} as never
  );
  return { db, service };
}

describe('audited project lifecycle controls', () => {
  it('pauses and resumes the exact durable prior state', () => {
    const { db, service } = fixture();
    expect(service.pause('project-1').state).toBe('PAUSED');
    expect(db.raw.prepare(`SELECT state, resume_state FROM projects WHERE id = 'project-1'`).get())
      .toEqual({ state: 'PAUSED', resume_state: 'ANALYZING_OPPORTUNITY' });
    expect(service.resume('project-1').state).toBe('ANALYZING_OPPORTUNITY');
    expect(db.raw.prepare(`SELECT action FROM audit_log WHERE action = 'project.state_changed'`).all())
      .toHaveLength(2);
    db.close();
  });

  it('defers pause to the next checkpoint while refusing destructive lifecycle changes under lease', () => {
    const { db, service } = fixture();
    const jobs = new JobService(db);
    jobs.setCheckpointHandler(projectId => { service.applyPendingLifecycle(projectId); });
    const job = jobs.create('workflow_test', 'project-1', { fixture: true });
    expect(jobs.start(job.id, 'Running fixture')).toEqual({ state: 'started' });
    expect(service.pause('project-1')).toMatchObject({ state: 'ANALYZING_OPPORTUNITY', pendingLifecycleAction: 'pause' });
    expect(() => service.cancel('project-1')).toThrow('active project job');
    expect(db.raw.prepare(`SELECT state, pending_lifecycle_action FROM projects WHERE id = 'project-1'`).get())
      .toEqual({ state: 'ANALYZING_OPPORTUNITY', pending_lifecycle_action: 'pause' });
    jobs.succeed(job.id, { fixture: true });
    expect(service.get('project-1')).toMatchObject({ state: 'PAUSED', pendingLifecycleAction: null });
    expect(db.raw.prepare(`SELECT action FROM audit_log ORDER BY id`).all()).toEqual([
      { action: 'project.pause_requested' },
      { action: 'project.state_changed' }
    ]);
    db.close();
  });

  it('requires blocker repair before resume, then supports cancel and archive terminals', () => {
    const blocked = fixture('BLOCKED_EXCEPTION');
    blocked.db.raw.prepare(`UPDATE projects SET resume_state = 'ANALYZING_OPPORTUNITY' WHERE id = 'project-1'`).run();
    blocked.db.raw.prepare(`
      INSERT INTO exceptions(
        id, project_id, severity, stage, code, title, message, evidence_json, status, created_at
      ) VALUES('exception-1', 'project-1', 'HIGH', 'test', 'TEST', 'Test', 'Test', '{}', 'OPEN', ?)
    `).run(new Date().toISOString());
    expect(() => blocked.service.resume('project-1')).toThrow('Resolve every open blocker');
    blocked.db.raw.prepare(`UPDATE exceptions SET status = 'RESOLVED' WHERE id = 'exception-1'`).run();
    expect(blocked.service.resume('project-1').state).toBe('ANALYZING_OPPORTUNITY');
    blocked.db.raw.prepare(`
      INSERT INTO jobs(
        id, project_id, type, state, input_json, input_hash, available_at, created_at, updated_at
      ) VALUES('job-queued', 'project-1', 'test', 'QUEUED', '{}', 'hash', ?, ?, ?)
    `).run(new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
    expect(blocked.service.cancel('project-1').state).toBe('CANCELLED');
    expect(blocked.db.raw.prepare(`SELECT state FROM jobs WHERE id = 'job-queued'`).get())
      .toEqual({ state: 'CANCELLED' });
    expect(blocked.service.archive('project-1').state).toBe('ARCHIVED');
    blocked.db.close();
  });
});
