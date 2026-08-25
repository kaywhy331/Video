import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase } from '@main/database/database';
import {
  isYouTubeStudioRestriction,
  YouTubeService,
  youtubeCredentialFingerprint
} from '@main/services/youtube-service';
import { approvalFingerprint } from '@shared/approval';
import type { ProjectDetail } from '@shared/types';
import type { ProjectService } from '@main/services/project-service';
import type { SecretStore } from '@main/secret-store';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'videofactory-youtube-approval-'));
  roots.push(root);
  const db = new AppDatabase(join(root, 'db.sqlite'));
  const now = new Date().toISOString();
  db.raw.prepare(`
    INSERT INTO projects(
      id, sequence, slug, title, topic, state, progress, envato_project_name,
      target_duration_ms, youtube_video_id, created_at, updated_at
    ) VALUES('project-1', 1, 'project-1', 'Project', 'Topic',
      'WAITING_FINAL_APPROVAL', 0.96, 'YT-PROJECT-1', 60000, 'video_123', ?, ?)
  `).run(now, now);
  const packaging = {
    id: 'package-1', selected: true, title: 'Verified title', description: 'Verified description',
    chapters: '0:00 Opening', tags: ['travel'], thumbnailPath: null
  };
  const approvalHash = approvalFingerprint({
    finalSha256: 'final-sha',
    packageId: packaging.id,
    title: packaging.title,
    description: packaging.description,
    chapters: packaging.chapters,
    tags: packaging.tags,
    thumbnailSha256: null
  });
  db.raw.prepare(`
    INSERT INTO publication_records(
      id, project_id, channel_id, video_id, privacy_status, final_sha256, processing_status,
      caption_id, thumbnail_uploaded, approval_hash, created_at, updated_at
    ) VALUES('publication-1', 'project-1', 'UC-confirmed', 'video_123', 'private', 'final-sha',
      'succeeded', 'caption-1', 1, ?, ?, ?)
  `).run(approvalHash, now, now);
  db.raw.prepare(`
    INSERT INTO youtube_connection_binding(
      singleton_id, channel_id, channel_title, credential_fingerprint, confirmed_at
    ) VALUES(1, 'UC-confirmed', 'Confirmed Channel', ?, ?)
  `).run(youtubeCredentialFingerprint('client-id', 'refresh-token'), now);
  const transition = vi.fn();
  const project = {
    id: 'project-1',
    state: 'WAITING_FINAL_APPROVAL',
    youtubeVideoId: 'video_123',
    renders: [{ kind: 'final', state: 'SUCCEEDED', sha256: 'final-sha' }],
    packaging: [packaging]
  } as unknown as ProjectDetail;
  const projects = { get: () => project, states: { transition } } as unknown as ProjectService;
  const secrets = {
    getAll: () => ({
      youtubeClientId: 'client-id', youtubeClientSecret: 'client-secret', youtubeRefreshToken: 'refresh-token'
    })
  } as unknown as SecretStore;
  return { db, projects, secrets, transition };
}

describe('YouTube publication approval', () => {
  it('[YT-006] preserves private state and routes an API restriction to the exact Studio editor', async () => {
    const value = fixture();
    const restriction = Object.assign(new Error('Unverified API projects are restricted to private videos.'), {
      response: {
        status: 403,
        data: { error: { message: 'Public access is not allowed.', errors: [{ reason: 'forbidden' }] } }
      }
    });
    const update = vi.fn().mockRejectedValue(restriction);
    const open = vi.fn().mockResolvedValue(undefined);
    const service = new YouTubeService(
      value.db,
      () => ({}) as never,
      value.secrets,
      value.projects,
      vi.fn(),
      update,
      open
    );

    await expect(service.approve('project-1', 'publish')).resolves.toEqual({
      outcome: 'studio_fallback',
      requestedAction: 'publish',
      studioUrl: 'https://studio.youtube.com/video/video_123/edit'
    });
    expect(open).toHaveBeenCalledWith('https://studio.youtube.com/video/video_123/edit');
    expect(value.transition).toHaveBeenCalledWith('project-1', 'AWAITING_MANUAL_STUDIO_ACTION', expect.objectContaining({
      prerequisites: expect.objectContaining({ videoId: 'video_123', requestedAction: 'publish' })
    }));
    expect(value.db.raw.prepare(`
      SELECT privacy_status, scheduled_at, published_at, error FROM publication_records WHERE id = 'publication-1'
    `).get()).toEqual({
      privacy_status: 'private',
      scheduled_at: null,
      published_at: null,
      error: 'API publish restriction; manual Studio action required.'
    });
    const audit = value.db.raw.prepare(`
      SELECT metadata_json FROM audit_log WHERE action = 'youtube.studio_fallback'
    `).get() as { metadata_json: string };
    expect(JSON.parse(audit.metadata_json)).toMatchObject({
      requestedAction: 'publish',
      studioOpened: true,
      studioUrl: 'https://studio.youtube.com/video/video_123/edit',
      apiStatus: 403,
      apiReasons: ['forbidden']
    });
    value.db.close();
  });

  it('[YT-008] validates schedule time before an API update and sends private future status', async () => {
    const invalid = fixture();
    const invalidUpdate = vi.fn();
    const invalidService = new YouTubeService(
      invalid.db, () => ({}) as never, invalid.secrets, invalid.projects, vi.fn(), invalidUpdate, vi.fn()
    );
    await expect(invalidService.approve('project-1', 'schedule', '2020-01-01T00:00:00.000Z'))
      .rejects.toThrow(/valid future schedule time/i);
    expect(invalidUpdate).not.toHaveBeenCalled();
    invalid.db.close();

    const valid = fixture();
    const scheduledAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const update = vi.fn().mockImplementation(async (_auth, _videoId, status) => status);
    const service = new YouTubeService(
      valid.db, () => ({}) as never, valid.secrets, valid.projects, vi.fn(), update, vi.fn()
    );
    await expect(service.approve('project-1', 'schedule', scheduledAt)).resolves.toEqual({ outcome: 'scheduled' });
    expect(update).toHaveBeenCalledWith(expect.anything(), 'video_123', {
      privacyStatus: 'private', publishAt: scheduledAt
    });
    expect(valid.transition).toHaveBeenCalledWith('project-1', 'SCHEDULED', expect.anything());
    expect(valid.db.raw.prepare(`
      SELECT privacy_status, scheduled_at, published_at FROM publication_records WHERE id = 'publication-1'
    `).get()).toEqual({ privacy_status: 'private', scheduled_at: scheduledAt, published_at: null });
    valid.db.close();
  });

  it('rejects approval when the publication receipt targets a different YouTube channel', async () => {
    const value = fixture();
    value.db.raw.prepare(`UPDATE publication_records SET channel_id = 'UC-other' WHERE id = 'publication-1'`).run();
    const update = vi.fn();
    const service = new YouTubeService(
      value.db, () => ({}) as never, value.secrets, value.projects, vi.fn(), update, vi.fn()
    );
    await expect(service.approve('project-1', 'keep_private')).rejects.toThrow(/does not match/i);
    expect(update).not.toHaveBeenCalled();
    expect(value.db.raw.prepare(`SELECT privacy_status, approved_at FROM publication_records WHERE id = 'publication-1'`).get())
      .toEqual({ privacy_status: 'private', approved_at: null });
    value.db.close();
  });

  it('classifies only explicit 403 publication restrictions for Studio fallback', () => {
    expect(isYouTubeStudioRestriction({ response: { status: 403, data: { error: {
      message: 'Public access is not allowed.', errors: [{ reason: 'forbidden' }]
    } } } })).toBe(true);
    expect(isYouTubeStudioRestriction({ response: { status: 401 }, message: 'Refresh token expired' })).toBe(false);
    expect(isYouTubeStudioRestriction({ response: { status: 500 }, message: 'Studio unavailable' })).toBe(false);
  });
});
