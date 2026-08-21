import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase } from '@main/database/database';
import { JobService } from '@main/services/job-service';
import { ProjectStateService } from '@main/services/project-state-service';
import { WorkflowService } from '@main/services/workflow-service';
import { JobResourceBusyError } from '@main/services/job-service';
import type { ProjectDetail, ProjectState } from '@shared/types';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(state: ProjectState) {
  const root = mkdtempSync(join(tmpdir(), 'videofactory-workflow-'));
  roots.push(root);
  const db = new AppDatabase(join(root, 'db.sqlite'));
  const now = new Date().toISOString();
  db.raw.prepare(`
    INSERT INTO projects(
      id, sequence, slug, title, topic, state, progress, envato_project_name,
      target_duration_ms, created_at, updated_at
    ) VALUES('project-1', 1, 'project-1', 'Project', 'Topic', ?, 0.5,
      'YT-TEST-0001', 300000, ?, ?)
  `).run(state, now, now);
  const states = new ProjectStateService(db);
  const get = (): ProjectDetail => {
    const row = db.raw.prepare(`SELECT state, youtube_video_id FROM projects WHERE id = 'project-1'`).get() as {
      state: ProjectState;
      youtube_video_id: string | null;
    };
    return {
      id: 'project-1',
      state: row.state,
      youtubeVideoId: row.youtube_video_id,
      outputProfileKey: 'landscape_1080p'
    } as ProjectDetail;
  };
  return { db, get, states };
}

describe('durable automatic workflow continuation', () => {
  it('runs the clean post-acquisition stages once and stops at the final human gate', async () => {
    const { db, get, states } = fixture('FINALIZING_SCRIPT');
    const calls: string[] = [];
    const projects = { get: (_id: string) => get(), states };
    const service = new WorkflowService(
      db,
      new JobService(db),
      projects as never,
      {
        finalize: async () => {
          calls.push('finalize');
          db.raw.prepare(`UPDATE projects SET state = 'GENERATING_VOICE' WHERE id = 'project-1'`).run();
        }
      } as never,
      {
        generate: async () => {
          calls.push('voice');
          db.raw.prepare(`UPDATE projects SET state = 'BUILDING_TIMELINE' WHERE id = 'project-1'`).run();
          return [];
        }
      } as never,
      {
        render: async (_projectId: string, request: { kind: string }) => {
          calls.push(request.kind);
          db.raw.prepare(`UPDATE projects SET state = ? WHERE id = 'project-1'`)
            .run(request.kind === 'draft' ? 'QC_DRAFT' : 'QC_FINAL');
          return {};
        }
      } as never,
      { get: () => ({ canUpload: true }), completeAutomaticRevisions: vi.fn() } as never,
      {
        uploadReadiness: () => ({ ready: true }),
        uploadPrivate: async () => {
          calls.push('upload');
          db.raw.prepare(`UPDATE projects SET state = 'WAITING_FINAL_APPROVAL', youtube_video_id = 'video-1' WHERE id = 'project-1'`).run();
          return { videoId: 'video-1', url: 'https://example.test/video-1' };
        }
      } as never,
      () => undefined,
      () => undefined
    );

    const [first, second] = await Promise.all([service.advance('project-1'), service.advance('project-1')]);
    expect(first.state).toBe('WAITING_FINAL_APPROVAL');
    expect(second.state).toBe('WAITING_FINAL_APPROVAL');
    expect(calls).toEqual(['finalize', 'voice', 'draft', 'final', 'upload']);
    expect(db.raw.prepare(`SELECT type, state FROM jobs ORDER BY created_at`).all()).toEqual([
      { type: 'workflow_finalize_script', state: 'SUCCEEDED' },
      { type: 'workflow_generate_voice', state: 'SUCCEEDED' },
      { type: 'workflow_upload_private', state: 'SUCCEEDED' }
    ]);
    db.close();
  });

  it('turns missing YouTube authorization into one actionable blocking exception', async () => {
    const { db, get, states } = fixture('QC_FINAL');
    const projects = { get: (_id: string) => get(), states };
    const emit = vi.fn();
    const service = new WorkflowService(
      db,
      new JobService(db),
      projects as never,
      {} as never,
      {} as never,
      {} as never,
      { get: () => ({ canUpload: true }) } as never,
      {
        uploadReadiness: () => ({
          ready: false,
          code: 'YOUTUBE_AUTH_REQUIRED',
          title: 'YouTube connection is required',
          message: 'Connect YouTube.'
        })
      } as never,
      emit,
      () => undefined
    );

    expect((await service.advance('project-1')).state).toBe('BLOCKED_EXCEPTION');
    expect(db.raw.prepare(`SELECT code, status FROM exceptions WHERE project_id = 'project-1'`).all())
      .toEqual([{ code: 'YOUTUBE_AUTH_REQUIRED', status: 'OPEN' }]);
    await service.advance('project-1');
    expect(db.raw.prepare(`SELECT count(*) AS count FROM exceptions WHERE project_id = 'project-1'`).get())
      .toEqual({ count: 1 });
    expect(emit).toHaveBeenCalled();
    db.close();
  });

  it('does not advance a human gate or a locked automatic project', async () => {
    const waiting = fixture('WAITING_FOR_DOWNLOADS');
    const waitingProjects = { get: (_id: string) => waiting.get(), states: waiting.states };
    const service = new WorkflowService(
      waiting.db, new JobService(waiting.db), waitingProjects as never,
      {} as never, {} as never, {} as never, {} as never, {} as never,
      () => undefined, () => undefined
    );
    expect((await service.advance('project-1')).state).toBe('WAITING_FOR_DOWNLOADS');
    waiting.db.close();

    const locked = fixture('GENERATING_VOICE');
    locked.db.raw.prepare(`UPDATE projects SET locked_by_job_id = 'other-job' WHERE id = 'project-1'`).run();
    const generate = vi.fn();
    const lockedProjects = { get: (_id: string) => locked.get(), states: locked.states };
    const lockedService = new WorkflowService(
      locked.db, new JobService(locked.db), lockedProjects as never,
      {} as never, { generate } as never, {} as never, {} as never, {} as never,
      () => undefined, () => undefined
    );
    expect((await lockedService.advance('project-1')).state).toBe('GENERATING_VOICE');
    expect(generate).not.toHaveBeenCalled();
    locked.db.close();
  });

  it('does not resume an automatic-looking state with a pending manual revision', async () => {
    const { db, get, states } = fixture('QC_FINAL');
    const now = new Date().toISOString();
    db.raw.prepare(`
      INSERT INTO revision_requests(
        id, project_id, category, note, return_state, status, created_at
      ) VALUES('revision-1', 'project-1', 'packaging', 'Change the title',
        'QC_FINAL', 'requested', ?)
    `).run(now);
    const uploadPrivate = vi.fn();
    const service = new WorkflowService(
      db, new JobService(db), { get, states } as never,
      {} as never, {} as never, {} as never,
      { get: () => ({ canUpload: true }), completeAutomaticRevisions: vi.fn() } as never,
      { uploadReadiness: () => ({ ready: true }), uploadPrivate } as never,
      () => undefined, () => undefined
    );

    expect((await service.advance('project-1')).state).toBe('QC_FINAL');
    expect(await service.resumeOldest()).toBeNull();
    expect(uploadPrivate).not.toHaveBeenCalled();
    db.close();
  });

  it('defers a final render when global capacity is busy without blocking the project', async () => {
    const { db, get, states } = fixture('QC_DRAFT');
    const render = vi.fn(async () => {
      throw new JobResourceBusyError('render_final', new Date(Date.now() + 5_000).toISOString());
    });
    const service = new WorkflowService(
      db,
      new JobService(db),
      { get, states } as never,
      {} as never,
      {} as never,
      { render } as never,
      {} as never,
      {} as never,
      () => undefined,
      () => undefined
    );

    expect((await service.advance('project-1')).state).toBe('QC_DRAFT');
    expect(render).toHaveBeenCalledOnce();
    expect(db.raw.prepare(`SELECT count(*) AS count FROM exceptions WHERE project_id = 'project-1'`).get())
      .toEqual({ count: 0 });
    db.close();
  });

  it('runs a manual private upload through the durable workflow job and reuses its receipt', async () => {
    const { db, get, states } = fixture('QC_FINAL');
    const uploadPrivate = vi.fn(async () => {
      db.raw.prepare(`UPDATE projects SET state = 'WAITING_FINAL_APPROVAL', youtube_video_id = 'video-manual' WHERE id = 'project-1'`).run();
      return { videoId: 'video-manual', url: 'https://www.youtube.com/watch?v=video-manual' };
    });
    const service = new WorkflowService(
      db,
      new JobService(db),
      { get, states } as never,
      {} as never,
      {} as never,
      {} as never,
      { get: () => ({ canUpload: true }) } as never,
      { uploadPrivate } as never,
      () => undefined,
      () => undefined
    );

    await expect(service.uploadPrivate('project-1')).resolves.toEqual({
      videoId: 'video-manual',
      url: 'https://www.youtube.com/watch?v=video-manual'
    });
    await expect(service.uploadPrivate('project-1')).resolves.toEqual({
      videoId: 'video-manual',
      url: 'https://www.youtube.com/watch?v=video-manual'
    });
    expect(uploadPrivate).toHaveBeenCalledOnce();
    expect(db.raw.prepare(`SELECT type, state FROM jobs WHERE project_id = 'project-1'`).all())
      .toEqual([{ type: 'workflow_upload_private', state: 'SUCCEEDED' }]);
    db.close();
  });

  it('does not call YouTube when another state-mutating job holds the project lock', async () => {
    const { db, get, states } = fixture('QC_FINAL');
    const jobs = new JobService(db);
    const holder = jobs.create('other_mutation', 'project-1', { operation: 1 });
    jobs.start(holder.id, 'Holding project lock');
    const uploadPrivate = vi.fn();
    const service = new WorkflowService(
      db,
      jobs,
      { get, states } as never,
      {} as never,
      {} as never,
      {} as never,
      { get: () => ({ canUpload: true }) } as never,
      { uploadPrivate } as never,
      () => undefined,
      () => undefined
    );

    await expect(service.uploadPrivate('project-1')).rejects.toThrow(/already running|project is busy/i);
    expect(uploadPrivate).not.toHaveBeenCalled();
    expect(db.raw.prepare(`SELECT state, attempt FROM jobs WHERE type = 'workflow_upload_private'`).get())
      .toEqual({ state: 'QUEUED', attempt: 0 });
    jobs.succeed(holder.id, {});
    db.close();
  });
});
