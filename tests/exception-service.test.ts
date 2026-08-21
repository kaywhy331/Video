import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase } from '@main/database/database';
import { ExceptionService } from '@main/services/exception-service';
import { ProjectStateService } from '@main/services/project-state-service';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('exception recovery', () => {
  it('does not let the resolution API resume or hide an actively blocked exception', () => {
    const root = mkdtempSync(join(tmpdir(), 'videofactory-exceptions-'));
    roots.push(root);
    const db = new AppDatabase(join(root, 'videofactory.sqlite'));
    const now = new Date().toISOString();
    db.raw.prepare(`
      INSERT INTO projects(
        id, sequence, slug, title, topic, state, progress, envato_project_name,
        target_duration_ms, created_at, updated_at
      ) VALUES('project-1', 1, 'project-1', 'Project', 'Topic', 'CREATED', 0,
        'YT-TEST-0001', 300000, ?, ?)
    `).run(now, now);
    const states = new ProjectStateService(db);
    states.transition('project-1', 'ANALYZING_OPPORTUNITY', { reason: 'test' });
    states.transition('project-1', 'BLOCKED_EXCEPTION', { reason: 'test blockers' });
    for (const id of ['exception-1', 'exception-2']) {
      db.raw.prepare(`
        INSERT INTO exceptions(
          id, project_id, severity, stage, code, title, message, evidence_json, status, created_at
        ) VALUES(?, 'project-1', 'BLOCKER', 'test', 'TEST', 'Test', 'Test', '{}', 'OPEN', ?)
      `).run(id, now);
    }
    const service = new ExceptionService(db);
    expect(() => service.resolve('exception-1', { method: 'repair_completed' }))
      .toThrow(/still blocked/i);
    expect(db.raw.prepare("SELECT state FROM projects WHERE id = 'project-1'").get()).toEqual({ state: 'BLOCKED_EXCEPTION' });
    expect(db.raw.prepare("SELECT status FROM exceptions WHERE id = 'exception-1'").get())
      .toEqual({ status: 'OPEN' });
    db.close();
  });

  it('does not let acknowledgement bypass a non-overridable safety failure', () => {
    const root = mkdtempSync(join(tmpdir(), 'videofactory-exceptions-'));
    roots.push(root);
    const db = new AppDatabase(join(root, 'videofactory.sqlite'));
    const now = new Date().toISOString();
    db.raw.prepare(`
      INSERT INTO projects(
        id, sequence, slug, title, topic, state, progress, envato_project_name,
        target_duration_ms, resume_state, created_at, updated_at
      ) VALUES('project-1', 1, 'project-1', 'Project', 'Topic', 'BLOCKED_EXCEPTION', 0,
        'YT-TEST-0001', 300000, 'QC_FINAL', ?, ?)
    `).run(now, now);
    db.raw.prepare(`
      INSERT INTO exceptions(
        id, project_id, severity, stage, code, title, message, evidence_json, status, created_at
      ) VALUES('exception-1', 'project-1', 'BLOCKER', 'render_qc', 'QC_LICENSE_STATE',
        'Missing license', 'Missing license', '{}', 'OPEN', ?)
    `).run(now);

    const service = new ExceptionService(db);
    expect(() => service.resolve('exception-1', { method: 'operator_acknowledged' }))
      .toThrow(/cannot be cleared by acknowledgement/i);
    expect(db.raw.prepare("SELECT status FROM exceptions WHERE id = 'exception-1'").get())
      .toEqual({ status: 'OPEN' });
    expect(db.raw.prepare("SELECT state FROM projects WHERE id = 'project-1'").get())
      .toEqual({ state: 'BLOCKED_EXCEPTION' });
    db.close();
  });

  it('records and audits a nonblocking exception acknowledgement', () => {
    const root = mkdtempSync(join(tmpdir(), 'videofactory-exceptions-'));
    roots.push(root);
    const db = new AppDatabase(join(root, 'videofactory.sqlite'));
    const now = new Date().toISOString();
    db.raw.prepare(`
      INSERT INTO projects(
        id, sequence, slug, title, topic, state, progress, envato_project_name,
        target_duration_ms, created_at, updated_at
      ) VALUES('project-1', 1, 'project-1', 'Project', 'Topic', 'ANALYZING_OPPORTUNITY', 0,
        'YT-TEST-0001', 300000, ?, ?)
    `).run(now, now);
    db.raw.prepare(`
      INSERT INTO exceptions(
        id, project_id, severity, stage, code, title, message, evidence_json, status, created_at
      ) VALUES('exception-1', 'project-1', 'MEDIUM', 'catalog', 'THUMBNAIL_UNAVAILABLE',
        'Thumbnail missing', 'Thumbnail missing', '{}', 'OPEN', ?)
    `).run(now);

    const service = new ExceptionService(db);
    expect(service.list('project-1')).toEqual([
      expect.objectContaining({ id: 'exception-1', canAcknowledge: true })
    ]);
    service.resolve('exception-1', { method: 'operator_acknowledged' });
    expect(db.raw.prepare("SELECT status FROM exceptions WHERE id = 'exception-1'").get())
      .toEqual({ status: 'RESOLVED' });
    expect(db.raw.prepare("SELECT action FROM audit_log WHERE entity_id = 'exception-1'").get())
      .toEqual({ action: 'exception.resolved' });
    db.close();
  });

  it('surfaces project context, safe alternatives, audit history, and a reasoned safe override', () => {
    const root = mkdtempSync(join(tmpdir(), 'videofactory-exceptions-'));
    roots.push(root);
    const db = new AppDatabase(join(root, 'videofactory.sqlite'));
    const now = new Date().toISOString();
    db.raw.prepare(`
      INSERT INTO projects(
        id, sequence, slug, title, topic, state, progress, envato_project_name,
        target_duration_ms, created_at, updated_at
      ) VALUES('project-1', 1, 'project-1', 'Project evidence', 'Topic',
        'ANALYZING_OPPORTUNITY', 0, 'YT-TEST-0001', 300000, ?, ?)
    `).run(now, now);
    db.raw.prepare(`
      INSERT INTO exceptions(
        id, project_id, severity, stage, code, title, message, evidence_json,
        recommended_action, safe_alternatives_json, status, created_at
      ) VALUES('exception-1', 'project-1', 'MEDIUM', 'catalog', 'THUMBNAIL_UNAVAILABLE',
        'Thumbnail missing', 'Thumbnail missing', '{"assetId":"asset-1"}',
        'Choose another frame.', '["Use another frame","Continue without preview"]', 'OPEN', ?)
    `).run(now);
    const service = new ExceptionService(db);

    expect(service.list('project-1')[0]).toMatchObject({
      projectTitle: 'Project evidence',
      safeAlternatives: ['Use another frame', 'Continue without preview'],
      canOverride: true,
      retryAction: null,
      auditTrail: []
    });
    expect(() => service.override('exception-1', 'short')).toThrow(/at least 10/i);
    expect(service.override('exception-1', 'The alternate frame was reviewed and accepted.')).toMatchObject({
      status: 'OVERRIDDEN',
      resolution: { method: 'operator_override', reason: 'The alternate frame was reviewed and accepted.' },
      auditTrail: [expect.objectContaining({ action: 'exception.overridden', actor: 'human' })]
    });
    expect(db.integrityCheck()).toBe('ok');
    db.close();
  });

  it('computes and audits a retry without allowing it to bypass other blockers', () => {
    const root = mkdtempSync(join(tmpdir(), 'videofactory-exceptions-'));
    roots.push(root);
    const db = new AppDatabase(join(root, 'videofactory.sqlite'));
    const now = new Date().toISOString();
    db.raw.prepare(`
      INSERT INTO projects(
        id, sequence, slug, title, topic, state, resume_state, progress,
        envato_project_name, target_duration_ms, created_at, updated_at
      ) VALUES('project-1', 1, 'project-1', 'Project', 'Topic', 'BLOCKED_EXCEPTION',
        'RENDERING_FINAL', 0.8, 'YT-TEST-0001', 300000, ?, ?)
    `).run(now, now);
    db.raw.prepare(`
      INSERT INTO exceptions(
        id, project_id, severity, stage, code, title, message, evidence_json,
        recommended_action, status, created_at
      ) VALUES('exception-1', 'project-1', 'BLOCKER', 'render', 'RENDER_FAILED',
        'Render failed', 'Encoder stopped', '{"renderId":"render-1"}',
        'Retry rendering.', 'OPEN', ?)
    `).run(now);
    const service = new ExceptionService(db);
    expect(service.get('exception-1').retryAction).toBe('workflow');
    expect(service.beginRetry('exception-1')).toMatchObject({
      status: 'RESOLVED',
      auditTrail: [expect.objectContaining({ action: 'exception.retry_started' })]
    });
    expect(service.retryFailed('exception-1', new Error('Encoder still unavailable'))).toMatchObject({
      status: 'OPEN',
      message: 'Encoder still unavailable',
      auditTrail: [
        expect.objectContaining({ action: 'exception.retry_failed' }),
        expect.objectContaining({ action: 'exception.retry_started' })
      ]
    });
    db.close();
  });
});
