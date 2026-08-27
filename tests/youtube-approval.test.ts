import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase } from '@main/database/database';
import {
  classifyYouTubeProviderHealthFailure,
  isYouTubeStudioRestriction,
  YouTubeService,
  youtubeCredentialFingerprint
} from '@main/services/youtube-service';
import { ProviderPolicyService } from '@main/services/provider-policy';
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
  const outputPath = join(root, 'final.mp4');
  const thumbnailPath = join(root, 'thumbnail.jpg');
  writeFileSync(outputPath, 'final bytes');
  writeFileSync(thumbnailPath, 'thumbnail bytes');
  const finalSha = createHash('sha256').update('final bytes').digest('hex');
  const thumbnailSha = createHash('sha256').update('thumbnail bytes').digest('hex');
  db.raw.prepare(`
    INSERT INTO projects(
      id, sequence, slug, title, topic, state, progress, envato_project_name,
      target_duration_ms, final_render_id, youtube_video_id, created_at, updated_at
    ) VALUES('project-1', 1, 'project-1', 'Project', 'Topic',
      'WAITING_FINAL_APPROVAL', 0.96, 'YT-PROJECT-1', 60000, 'final-1', 'video_123', ?, ?)
  `).run(now, now);
  db.raw.prepare(`
    INSERT INTO renders(
      id, project_id, kind, profile, state, output_path, sha256, created_at, completed_at
    ) VALUES('final-1', 'project-1', 'final', 'final_1080p', 'SUCCEEDED', ?, ?, ?, ?)
  `).run(outputPath, finalSha, now, now);
  const packaging = {
    id: 'package-1', selected: true, title: 'Verified title', description: 'Verified description',
    chapters: '0:00 Opening', tags: ['travel'], thumbnailPath
  };
  db.raw.prepare(`
    INSERT INTO packaging_candidates(
      id, project_id, ordinal, title, angle, viewer_promise, thumbnail_path,
      description, chapters, tags_json, risk_status, selected, created_at
    ) VALUES('package-1', 'project-1', 1, ?, 'Angle', 'Promise', ?, ?, ?, ?, 'pass', 1, ?)
  `).run(
    packaging.title,
    thumbnailPath,
    packaging.description,
    packaging.chapters,
    JSON.stringify(packaging.tags),
    now
  );
  const approvalHash = approvalFingerprint({
    finalSha256: finalSha,
    packageId: packaging.id,
    title: packaging.title,
    description: packaging.description,
    chapters: packaging.chapters,
    tags: packaging.tags,
    thumbnailSha256: thumbnailSha
  });
  db.raw.prepare(`
    INSERT INTO publication_records(
      id, project_id, channel_id, video_id, privacy_status, final_render_id, final_sha256,
      snapshot_version, snapshot_status, processing_status, selected_package_id,
      caption_id, thumbnail_uploaded, approval_hash, created_at, updated_at
    ) VALUES('publication-1', 'project-1', 'UC-confirmed', 'video_123', 'private',
      'final-1', ?, 1, 'current', 'succeeded', 'package-1', 'caption-1', 1, ?, ?, ?)
  `).run(finalSha, approvalHash, now, now);
  db.raw.prepare(`
    INSERT INTO youtube_connection_binding(
      singleton_id, channel_id, channel_title, credential_fingerprint, confirmed_at
    ) VALUES(1, 'UC-confirmed', 'Confirmed Channel', ?, ?)
  `).run(youtubeCredentialFingerprint('client-id', 'refresh-token'), now);
  const transition = vi.fn();
  const project = {
    id: 'project-1',
    state: 'WAITING_FINAL_APPROVAL',
    finalRenderId: 'final-1',
    youtubeVideoId: 'video_123',
    renders: [{ id: 'final-1', kind: 'final', state: 'SUCCEEDED', outputPath, sha256: finalSha }],
    packaging: [packaging]
  } as unknown as ProjectDetail;
  const projects = { get: () => project, states: { transition } } as unknown as ProjectService;
  const secrets = {
    getAll: () => ({
      youtubeClientId: 'client-id', youtubeClientSecret: 'client-secret', youtubeRefreshToken: 'refresh-token'
    })
  } as unknown as SecretStore;
  const settings = () => ({ outputFolder: root, youtubeSyntheticMediaDisclosure: false }) as never;
  return { root, db, projects, secrets, transition, settings };
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
    const policy = new ProviderPolicyService(value.db, () => ({ monthlyBudgetUsd: 100 }) as never);
    const service = new YouTubeService(
      value.db,
      value.settings,
      value.secrets,
      value.projects,
      vi.fn(),
      update,
      open,
      undefined,
      undefined,
      undefined,
      policy
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
    expect(value.db.raw.prepare(`
      SELECT status FROM provider_health WHERE provider = 'youtube'
    `).get()).toEqual({ status: 'healthy' });
    value.db.close();
  });

  it('[YT-008] validates schedule time before an API update and sends private future status', async () => {
    const invalid = fixture();
    const invalidUpdate = vi.fn();
    const invalidService = new YouTubeService(
      invalid.db, invalid.settings, invalid.secrets, invalid.projects, vi.fn(), invalidUpdate, vi.fn()
    );
    await expect(invalidService.approve('project-1', 'schedule', '2020-01-01T00:00:00.000Z'))
      .rejects.toThrow(/valid future schedule time/i);
    expect(invalidUpdate).not.toHaveBeenCalled();
    invalid.db.close();

    const valid = fixture();
    const scheduledAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const update = vi.fn().mockImplementation(async (_auth, _videoId, status) => status);
    const service = new YouTubeService(
      valid.db, valid.settings, valid.secrets, valid.projects, vi.fn(), update, vi.fn()
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
      value.db, value.settings, value.secrets, value.projects, vi.fn(), update, vi.fn()
    );
    await expect(service.approve('project-1', 'keep_private')).rejects.toThrow(/snapshot.*match/i);
    expect(update).not.toHaveBeenCalled();
    expect(value.db.raw.prepare(`SELECT privacy_status, approved_at FROM publication_records WHERE id = 'publication-1'`).get())
      .toEqual({ privacy_status: 'private', approved_at: null });
    value.db.close();
  });

  it('[YT-012] resets the remote video to private when the active final changes during publish', async () => {
    const value = fixture();
    const replacementPath = join(value.root, 'replacement.mp4');
    writeFileSync(replacementPath, 'replacement final bytes');
    const replacementSha = createHash('sha256').update('replacement final bytes').digest('hex');
    const now = new Date().toISOString();
    value.db.raw.prepare(`
      INSERT INTO renders(
        id, project_id, kind, profile, state, output_path, sha256, created_at, completed_at
      ) VALUES('final-2', 'project-1', 'final', 'final_1080p', 'SUCCEEDED', ?, ?, ?, ?)
    `).run(replacementPath, replacementSha, now, now);
    let calls = 0;
    const update = vi.fn().mockImplementation(async (_auth, _videoId, status) => {
      if (calls++ === 0) {
        value.db.raw.prepare(`UPDATE projects SET final_render_id = 'final-2' WHERE id = 'project-1'`).run();
      }
      return status;
    });
    const service = new YouTubeService(
      value.db, value.settings, value.secrets, value.projects, vi.fn(), update, vi.fn()
    );

    await expect(service.approve('project-1', 'publish')).rejects.toThrow(/stale|changed/i);
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1]?.[2]).toMatchObject({ privacyStatus: 'private' });
    expect(value.db.raw.prepare(`
      SELECT privacy_status, snapshot_status, approval_hash, published_at
      FROM publication_records WHERE id = 'publication-1'
    `).get()).toEqual({
      privacy_status: 'private',
      snapshot_status: 'stale',
      approval_hash: null,
      published_at: null
    });
    expect(value.db.raw.prepare(`
      SELECT count(*) AS count FROM exceptions
      WHERE code = 'STALE_PUBLICATION_SNAPSHOT' AND status = 'OPEN'
    `).get()).toEqual({ count: 1 });
    value.db.close();
  });

  it('[YT-012] resets the remote video to private when publish has an uncertain response and the active final changed', async () => {
    const value = fixture();
    const replacementPath = join(value.root, 'replacement-uncertain.mp4');
    writeFileSync(replacementPath, 'replacement after uncertain publish');
    const replacementSha = createHash('sha256').update('replacement after uncertain publish').digest('hex');
    const now = new Date().toISOString();
    value.db.raw.prepare(`
      INSERT INTO renders(
        id, project_id, kind, profile, state, output_path, sha256, created_at, completed_at
      ) VALUES('final-uncertain', 'project-1', 'final', 'final_1080p', 'SUCCEEDED', ?, ?, ?, ?)
    `).run(replacementPath, replacementSha, now, now);
    let calls = 0;
    const update = vi.fn().mockImplementation(async (_auth, _videoId, status) => {
      if (calls++ === 0) {
        value.db.raw.prepare(`
          UPDATE projects SET final_render_id = 'final-uncertain' WHERE id = 'project-1'
        `).run();
        throw new Error('The publish response was lost.');
      }
      return status;
    });
    const service = new YouTubeService(
      value.db, value.settings, value.secrets, value.projects, vi.fn(), update, vi.fn()
    );

    await expect(service.approve('project-1', 'publish')).rejects.toThrow(/stale|changed/i);
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1]?.[2]).toMatchObject({ privacyStatus: 'private' });
    expect(value.db.raw.prepare(`
      SELECT privacy_status, snapshot_status, approval_hash, published_at
      FROM publication_records WHERE id = 'publication-1'
    `).get()).toEqual({
      privacy_status: 'private',
      snapshot_status: 'stale',
      approval_hash: null,
      published_at: null
    });
    value.db.close();
  });

  it('classifies only explicit 403 publication restrictions for Studio fallback', () => {
    expect(isYouTubeStudioRestriction({ response: { status: 403, data: { error: {
      message: 'Public access is not allowed.', errors: [{ reason: 'forbidden' }]
    } } } })).toBe(true);
    expect(isYouTubeStudioRestriction({ response: { status: 401 }, message: 'Refresh token expired' })).toBe(false);
    expect(isYouTubeStudioRestriction({ response: { status: 500 }, message: 'Studio unavailable' })).toBe(false);
  });

  it('persists actionable YouTube auth and quota health without hard-blocking transient failures', async () => {
    const value = fixture();
    const policy = new ProviderPolicyService(value.db, () => ({ monthlyBudgetUsd: 100 }) as never);
    const expired = Object.assign(new Error('Refresh token expired'), {
      response: {
        status: 401,
        data: { error: { errors: [{ reason: 'authError' }] } }
      }
    });
    const service = new YouTubeService(
      value.db,
      value.settings,
      value.secrets,
      value.projects,
      vi.fn(),
      vi.fn().mockRejectedValue(expired),
      vi.fn(),
      undefined,
      undefined,
      undefined,
      policy
    );

    await expect(service.approve('project-1', 'publish')).rejects.toThrow('Refresh token expired');
    expect(value.db.raw.prepare(`
      SELECT status, status_code, message FROM provider_health WHERE provider = 'youtube'
    `).get()).toEqual({
      status: 'auth_invalid',
      status_code: 401,
      message: 'YouTube authorization is invalid or expired; reconnect and confirm the intended channel.'
    });
    expect(service.uploadReadiness()).toMatchObject({
      ready: false,
      code: 'YOUTUBE_AUTH_EXPIRED'
    });

    expect(classifyYouTubeProviderHealthFailure({
      response: {
        status: 403,
        data: { error: { errors: [{ reason: 'quotaExceeded' }] } }
      }
    })).toMatchObject({ status: 'quota_exhausted', statusCode: 403 });
    expect(classifyYouTubeProviderHealthFailure({ code: 'ETIMEDOUT' }))
      .toMatchObject({ status: 'timeout', statusCode: null });
    expect(classifyYouTubeProviderHealthFailure(new Error('Local snapshot changed'))).toBeNull();
    value.db.close();
  });
});
