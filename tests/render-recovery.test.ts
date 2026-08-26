import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AppDatabase } from '@main/database/database';
import { JobService } from '@main/services/job-service';
import { RenderService } from '@main/services/render-service';
import type { AppSettings } from '@shared/types';
import { openRenderCrashFixture, seedRenderCrashFixture } from './fixtures/render-crash-fixture';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('render crash recovery', () => {
  it('[E2E-004] resumes a real draft render after the service host is killed at the assembly boundary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'videofactory-real-render-recovery-'));
    roots.push(root);
    await seedRenderCrashFixture(root);

    const child = spawnSync(process.execPath, [
      resolve('node_modules/vite-node/vite-node.mjs'),
      `--config=${resolve('vitest.config.ts')}`,
      resolve('tests/fixtures/render-crash-host.ts')
    ], {
      cwd: process.cwd(),
      env: { ...process.env, VIDEOFACTORY_RENDER_CRASH_ROOT: root },
      encoding: 'utf8',
      timeout: 60_000
    });
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.stdout, child.stderr).toContain('VIDEOFACTORY_RENDER_CHECKPOINT_READY');
    expect(child.status, child.stderr).not.toBe(0);

    const restarted = openRenderCrashFixture(root);
    try {
      const interruptedJob = restarted.db.raw.prepare(`
        SELECT id, state, attempt, phase FROM jobs WHERE type = 'render_draft'
      `).get() as { id: string; state: string; attempt: number; phase: string };
      const interruptedRender = restarted.db.raw.prepare(`
        SELECT id, state, output_path FROM renders WHERE kind = 'draft'
      `).get() as { id: string; state: string; output_path: string };
      const interruptedFragment = restarted.db.raw.prepare(`
        SELECT output_path FROM render_fragments WHERE project_id = 'project-1'
      `).get() as { output_path: string };
      const staleWork = join(
        restarted.settings.projectFolder,
        'project-1',
        'render-work',
        interruptedRender.id
      );

      expect(interruptedJob).toMatchObject({ state: 'RUNNING', attempt: 1, phase: 'Assembling timeline' });
      expect(interruptedRender).toMatchObject({ state: 'RUNNING' });
      expect(restarted.db.raw.prepare(`
        SELECT state, locked_by_job_id FROM projects WHERE id = 'project-1'
      `).get()).toEqual({ state: 'RENDERING_DRAFT', locked_by_job_id: interruptedJob.id });
      expect(existsSync(staleWork)).toBe(true);
      expect(existsSync(interruptedFragment.output_path)).toBe(true);
      expect(existsSync(interruptedRender.output_path)).toBe(false);

      restarted.jobs.recoverInterrupted();
      expect(restarted.render.recoverInterrupted()).toBe(1);
      expect(restarted.db.raw.prepare(`
        SELECT state, attempt, phase FROM jobs WHERE id = ?
      `).get(interruptedJob.id)).toEqual({ state: 'QUEUED', attempt: 1, phase: 'Recovered after restart' });
      expect(restarted.db.raw.prepare(`
        SELECT state, locked_by_job_id FROM projects WHERE id = 'project-1'
      `).get()).toEqual({ state: 'RENDERING_DRAFT', locked_by_job_id: null });
      expect(restarted.db.raw.prepare(`
        SELECT state, error, completed_at FROM renders WHERE id = ?
      `).get(interruptedRender.id)).toEqual({
        state: 'FAILED',
        error: 'Interrupted by a prior desktop process; automatic rerender is safe.',
        completed_at: expect.any(String)
      });
      expect(existsSync(staleWork)).toBe(false);
      expect(restarted.db.integrityCheck()).toBe('ok');

      const completed = await restarted.render.render('project-1', 'draft');
      expect(completed).toMatchObject({ state: 'SUCCEEDED', kind: 'draft', artifactVersion: 2 });
      expect(existsSync(completed.outputPath!)).toBe(true);
      expect(existsSync(completed.manifestPath!)).toBe(true);
      expect(restarted.db.raw.prepare(`
        SELECT state, attempt FROM jobs WHERE id = ?
      `).get(interruptedJob.id)).toEqual({ state: 'SUCCEEDED', attempt: 2 });
      expect(restarted.db.raw.prepare(`
        SELECT state, count(*) AS count FROM renders
        WHERE project_id = 'project-1' GROUP BY state ORDER BY state
      `).all()).toEqual([
        { state: 'FAILED', count: 1 },
        { state: 'SUCCEEDED', count: 1 }
      ]);
      expect(restarted.db.raw.prepare(`
        SELECT state, locked_by_job_id FROM projects WHERE id = 'project-1'
      `).get()).toEqual({ state: 'QC_DRAFT', locked_by_job_id: null });
      expect(restarted.db.integrityCheck()).toBe('ok');
    } finally {
      restarted.db.close();
    }
  }, 120_000);

  it('requeues the prior-process job, releases its lock, and closes only stale running render attempts', () => {
    const root = mkdtempSync(join(tmpdir(), 'videofactory-render-recovery-'));
    roots.push(root);
    const db = new AppDatabase(join(root, 'videofactory.sqlite'));
    const now = new Date().toISOString();
    const outputFolder = join(root, 'output');
    const projectFolder = join(root, 'projects');
    const staleOutput = join(outputFolder, 'render-stale.mp4');
    const completedOutput = join(outputFolder, 'render-complete.mp4');
    const outsideOutput = join(root, 'outside-render.mp4');
    const staleWork = join(projectFolder, 'project-1', 'render-work', 'render-stale');
    mkdirSync(staleWork, { recursive: true });
    mkdirSync(outputFolder, { recursive: true });
    writeFileSync(staleOutput, 'unvalidated partial output');
    writeFileSync(completedOutput, 'validated completed output');
    writeFileSync(outsideOutput, 'outside managed storage');
    writeFileSync(join(staleWork, 'assembled.mp4'), 'interrupted work product');
    db.raw.prepare(`
      INSERT INTO projects(
        id, sequence, slug, title, topic, state, progress,
        envato_project_name, target_duration_ms, created_at, updated_at
      ) VALUES('project-1', 1, 'project-1', 'Project 1', 'Project 1',
        'RENDERING_FINAL', 0.8, 'YT-PROJECT-1', 300000, ?, ?)
    `).run(now, now);

    const beforeCrash = new JobService(db);
    const job = beforeCrash.create('render_final', 'project-1', { manifest: 'stable-input' }, 2);
    beforeCrash.start(job.id, 'Encoding final video');
    db.raw.prepare('UPDATE jobs SET lease_owner = ?, lease_until = ? WHERE id = ?')
      .run('desktop-prior-process', '2999-01-01T00:00:00.000Z', job.id);
    db.raw.prepare(`
      INSERT INTO renders(
        id, project_id, kind, profile, state, manifest_path, output_path,
        artifact_version, scope_json, created_at
      ) VALUES
        ('render-stale', 'project-1', 'final', 'final_1080p', 'RUNNING',
          '/managed/manifest-stale.json', ?, 1, '{}', ?),
        ('render-outside', 'project-1', 'final', 'final_1080p', 'RUNNING',
          '/managed/manifest-outside.json', ?, 2, '{}', ?),
        ('render-complete', 'project-1', 'draft', 'draft_720p', 'SUCCEEDED',
          '/managed/manifest-complete.json', ?, 1, '{}', ?)
    `).run(staleOutput, now, outsideOutput, now, completedOutput, now);

    const restartedJobs = new JobService(db);
    restartedJobs.recoverInterrupted();
    const renders = new RenderService(
      db,
      () => ({ musicEnabled: false, outputFolder, projectFolder } as unknown as AppSettings),
      restartedJobs,
      {} as never,
      () => undefined
    );

    expect(renders.recoverInterrupted()).toBe(2);
    expect(restartedJobs.list('project-1').find(item => item.id === job.id)).toMatchObject({
      state: 'QUEUED',
      phase: 'Recovered after restart',
      attempt: 1
    });
    expect(db.raw.prepare('SELECT locked_by_job_id, state FROM projects WHERE id = ?').get('project-1'))
      .toEqual({ locked_by_job_id: null, state: 'RENDERING_FINAL' });
    expect(db.raw.prepare('SELECT state, error, completed_at FROM renders WHERE id = ?').get('render-stale'))
      .toEqual({
        state: 'FAILED',
        error: 'Interrupted by a prior desktop process; automatic rerender is safe.',
        completed_at: expect.any(String)
      });
    expect(db.raw.prepare('SELECT state, error FROM renders WHERE id = ?').get('render-complete'))
      .toEqual({ state: 'SUCCEEDED', error: null });
    expect(db.raw.prepare('SELECT state, error FROM renders WHERE id = ?').get('render-outside'))
      .toEqual({
        state: 'FAILED',
        error: expect.stringContaining('outside managed storage')
      });
    expect(existsSync(staleOutput)).toBe(false);
    expect(existsSync(staleWork)).toBe(false);
    expect(existsSync(completedOutput)).toBe(true);
    expect(existsSync(outsideOutput)).toBe(true);
    expect(renders.recoverInterrupted()).toBe(0);
    expect(db.integrityCheck()).toBe('ok');
    db.close();
  });
});
