import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  openUploadCrashFixture,
  seedUploadCrashFixture,
  uploadProtocolState,
  UPLOAD_CRASH_MARKERS,
  UPLOAD_FIXTURE_SESSION,
  UPLOAD_FIXTURE_VIDEO_ID,
  type UploadCrashMode
} from './fixtures/youtube-upload-crash-fixture';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('resumable private-upload crash recovery', () => {
  it.each([
    ['session_persisted', 2],
    ['remote_committed', 1]
  ] as const)(
    '[E2E-004] resumes after a killed host at %s without creating a duplicate remote upload',
    async (mode: UploadCrashMode, expectedChunkAttempts: number) => {
      const root = mkdtempSync(join(tmpdir(), `videofactory-upload-${mode}-`));
      roots.push(root);
      seedUploadCrashFixture(root);

      const child = spawnSync(process.execPath, [
        resolve('node_modules/vite-node/vite-node.mjs'),
        `--config=${resolve('vitest.config.ts')}`,
        resolve('tests/fixtures/youtube-upload-crash-host.ts')
      ], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          VIDEOFACTORY_UPLOAD_CRASH_ROOT: root,
          VIDEOFACTORY_UPLOAD_CRASH_MODE: mode
        },
        encoding: 'utf8',
        timeout: 30_000
      });
      expect(child.error, child.stderr).toBeUndefined();
      expect(child.stdout, child.stderr).toContain(UPLOAD_CRASH_MARKERS[mode]);
      expect(child.status, child.stderr).not.toBe(0);

      const restarted = openUploadCrashFixture(root);
      try {
        const interruptedJob = restarted.db.raw.prepare(`
          SELECT id, state, attempt, phase FROM jobs WHERE type = 'workflow_upload_private'
        `).get() as { id: string; state: string; attempt: number; phase: string };
        const interruptedPublication = restarted.db.raw.prepare(`
          SELECT id, video_id, upload_session_uri, processing_status, snapshot_status
          FROM publication_records WHERE project_id = 'project-1'
        `).get();
        const beforeRecovery = uploadProtocolState(restarted.db);

        expect(interruptedJob).toMatchObject({
          state: 'RUNNING',
          attempt: 1,
          phase: 'Running workflow upload private'
        });
        expect(interruptedPublication).toEqual({
          id: expect.any(String),
          video_id: null,
          upload_session_uri: UPLOAD_FIXTURE_SESSION,
          processing_status: 'uploading',
          snapshot_status: 'current'
        });
        expect(restarted.db.raw.prepare(`
          SELECT state, locked_by_job_id FROM projects WHERE id = 'project-1'
        `).get()).toEqual({ state: 'UPLOADING_PRIVATE', locked_by_job_id: interruptedJob.id });
        expect(beforeRecovery).toMatchObject({
          session_creates: 1,
          status_queries: 0,
          chunk_attempts: 1,
          remote_bytes: mode === 'remote_committed' ? restarted.finalSizeBytes : 0,
          remote_video_id: mode === 'remote_committed' ? UPLOAD_FIXTURE_VIDEO_ID : null,
          last_content_range: `bytes 0-${restarted.finalSizeBytes - 1}/${restarted.finalSizeBytes}`
        });
        expect(restarted.db.integrityCheck()).toBe('ok');

        restarted.jobs.recoverInterrupted();
        expect(restarted.db.raw.prepare(`
          SELECT state, attempt, phase FROM jobs WHERE id = ?
        `).get(interruptedJob.id)).toEqual({
          state: 'QUEUED',
          attempt: 1,
          phase: 'Recovered after remote session reused'
        });
        expect(restarted.db.raw.prepare(`
          SELECT outcome, publication_id, video_id
          FROM job_retry_reconciliations WHERE job_id = ?
        `).get(interruptedJob.id)).toEqual({
          outcome: 'remote_session_reused',
          publication_id: (interruptedPublication as { id: string }).id,
          video_id: null
        });
        expect(restarted.db.raw.prepare(`
          SELECT state, locked_by_job_id FROM projects WHERE id = 'project-1'
        `).get()).toEqual({ state: 'UPLOADING_PRIVATE', locked_by_job_id: null });

        await expect(restarted.workflow.uploadPrivate('project-1')).resolves.toEqual({
          videoId: UPLOAD_FIXTURE_VIDEO_ID,
          url: `https://www.youtube.com/watch?v=${UPLOAD_FIXTURE_VIDEO_ID}`
        });
        expect(uploadProtocolState(restarted.db)).toMatchObject({
          session_creates: 1,
          status_queries: 1,
          chunk_attempts: expectedChunkAttempts,
          remote_bytes: restarted.finalSizeBytes,
          remote_video_id: UPLOAD_FIXTURE_VIDEO_ID
        });
        expect(restarted.db.raw.prepare(`
          SELECT video_id, upload_session_uri, processing_status, snapshot_status,
            thumbnail_uploaded, caption_id
          FROM publication_records WHERE project_id = 'project-1'
        `).get()).toEqual({
          video_id: UPLOAD_FIXTURE_VIDEO_ID,
          upload_session_uri: UPLOAD_FIXTURE_SESSION,
          processing_status: 'succeeded',
          snapshot_status: 'current',
          thumbnail_uploaded: 1,
          caption_id: 'fixture-caption-1'
        });
        expect(restarted.db.raw.prepare(`
          SELECT count(*) AS count FROM publication_records WHERE project_id = 'project-1'
        `).get()).toEqual({ count: 1 });
        expect(restarted.db.raw.prepare(`
          SELECT state, attempt FROM jobs WHERE id = ?
        `).get(interruptedJob.id)).toEqual({ state: 'SUCCEEDED', attempt: 2 });
        expect(restarted.db.raw.prepare(`
          SELECT state, locked_by_job_id, youtube_video_id FROM projects WHERE id = 'project-1'
        `).get()).toEqual({
          state: 'WAITING_FINAL_APPROVAL',
          locked_by_job_id: null,
          youtube_video_id: UPLOAD_FIXTURE_VIDEO_ID
        });
        expect(restarted.db.integrityCheck()).toBe('ok');
      } finally {
        restarted.db.close();
      }
    },
    60_000
  );
});
