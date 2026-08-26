import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase } from '@main/database/database';
import {
  assertPublicationChannelBinding,
  YouTubeService,
  youtubeCredentialFingerprint
} from '@main/services/youtube-service';
import type { SecretStore, Secrets, YouTubeStoredCredentials } from '@main/secret-store';
import type { ProjectService } from '@main/services/project-service';
import type {
  YouTubeOAuthCandidate,
  YouTubeOAuthSessionPort,
  YouTubeOAuthSessionSnapshot
} from '@main/services/youtube-oauth-session';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fakeSecrets(initial: Secrets) {
  let current = { ...initial };
  const replaceYouTubeCredentials = vi.fn((next: YouTubeStoredCredentials | null) => {
    delete current.youtubeRefreshToken;
    delete current.youtubeAccessToken;
    delete current.youtubeTokenExpiry;
    if (next) current = { ...current, ...next };
    return {} as never;
  });
  const store = {
    getAll: () => ({ ...current }),
    replaceYouTubeCredentials,
    update: (patch: Partial<Secrets>) => {
      current = { ...current, ...patch };
      return {} as never;
    }
  } as unknown as SecretStore;
  return { store, replaceYouTubeCredentials, get current() { return { ...current }; } };
}

function fakeSession(candidate: YouTubeOAuthCandidate) {
  let pending: YouTubeOAuthSessionSnapshot | null = {
    pendingAuthorizationId: 'pending-authorization',
    phase: 'confirmation_required',
    expiresAt: '2030-01-01T00:00:00.000Z',
    channelId: candidate.channelId,
    channelTitle: candidate.channelTitle
  };
  const cancel = vi.fn(async (_pendingAuthorizationId: string) => {
    pending = null;
    return candidate.source;
  });
  const sessions: YouTubeOAuthSessionPort = {
    begin: vi.fn(async () => pending as YouTubeOAuthSessionSnapshot),
    stageStored: vi.fn(async () => pending as YouTubeOAuthSessionSnapshot),
    snapshot: () => pending,
    safeError: () => null,
    confirm: vi.fn(async (pendingId, expectedChannelId, commit) => {
      if (!pending || pendingId !== pending.pendingAuthorizationId || expectedChannelId !== candidate.channelId) {
        await cancel(pending?.pendingAuthorizationId ?? pendingId);
        throw new Error('The pending YouTube channel confirmation did not match and was discarded.');
      }
      await commit(candidate);
      pending = null;
    }),
    cancel,
    shutdown: vi.fn(async () => undefined)
  };
  return { sessions, cancel };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'videofactory-youtube-binding-'));
  roots.push(root);
  const db = new AppDatabase(join(root, 'db.sqlite'));
  const secrets = fakeSecrets({
    youtubeClientId: 'client-id',
    youtubeClientSecret: 'client-secret',
    youtubeRefreshToken: 'old-refresh',
    youtubeAccessToken: 'old-access'
  });
  db.raw.prepare(`
    INSERT INTO youtube_connection_binding(
      singleton_id, channel_id, channel_title, credential_fingerprint, confirmed_at
    ) VALUES(1, 'UC-old', 'Old Channel', ?, '2026-08-01T00:00:00.000Z')
  `).run(youtubeCredentialFingerprint('client-id', 'old-refresh'));
  const oauth = fakeSession({
    source: 'authorization',
    clientId: 'client-id',
    channelId: 'UC-new',
    channelTitle: 'New Channel',
    credentials: { refreshToken: 'new-refresh', accessToken: 'new-access', expiryDate: 1234 }
  });
  const service = new YouTubeService(
    db,
    () => ({}) as never,
    secrets.store,
    {} as ProjectService,
    vi.fn(),
    undefined,
    vi.fn(),
    oauth.sessions
  );
  return { db, secrets, oauth, service };
}

describe('confirmed YouTube channel binding', () => {
  it('[YT-010] keeps candidate credentials pending and requires explicit confirmed replacement identity', async () => {
    const cancelled = fixture();
    await expect(cancelled.service.cancelAuthorization('pending-authorization'))
      .resolves.toMatchObject({ state: 'confirmed', channelId: 'UC-old' });
    expect(cancelled.secrets.current.youtubeRefreshToken).toBe('old-refresh');
    expect(cancelled.db.raw.prepare(`SELECT channel_id FROM youtube_connection_binding`).get())
      .toEqual({ channel_id: 'UC-old' });
    cancelled.db.close();

    const rejected = fixture();
    const before = await rejected.service.status();
    expect(before).toMatchObject({
      state: 'confirmation_required',
      authorized: true,
      channelId: 'UC-old',
      pendingAuthorization: {
        channelId: 'UC-new',
        replacement: true,
        previousChannelId: 'UC-old'
      }
    });
    expect(rejected.secrets.current.youtubeRefreshToken).toBe('old-refresh');
    await expect(rejected.service.confirmAuthorization({
      pendingAuthorizationId: 'pending-authorization',
      expectedChannelId: 'UC-new',
      replaceExisting: false
    })).rejects.toMatchObject({
      code: 'OAUTH_REPLACEMENT_CONFIRMATION_REQUIRED',
      recovery: expect.stringContaining('explicitly confirm replacement')
    });
    expect(rejected.secrets.current.youtubeRefreshToken).toBe('old-refresh');
    expect(rejected.db.raw.prepare(`SELECT channel_id FROM youtube_connection_binding`).get())
      .toEqual({ channel_id: 'UC-old' });
    const replacementRejection = rejected.db.raw.prepare(`
      SELECT metadata_json FROM audit_log
      WHERE action = 'security.privileged_rejected' ORDER BY id DESC LIMIT 1
    `).get() as { metadata_json: string };
    expect(JSON.parse(replacementRejection.metadata_json)).toMatchObject({
      schemaVersion: 1,
      flow: 'oauth',
      operation: 'confirmation.replacement_check',
      code: 'OAUTH_REPLACEMENT_CONFIRMATION_REQUIRED',
      outcome: 'rejected'
    });
    expect(replacementRejection.metadata_json).not.toMatch(/client-secret|old-refresh|new-refresh/i);
    rejected.db.close();

    const confirmed = fixture();
    const publicationNow = new Date().toISOString();
    confirmed.db.raw.prepare(`
      INSERT INTO projects(
        id, sequence, slug, title, topic, state, progress, envato_project_name,
        target_duration_ms, created_at, updated_at
      ) VALUES('publication-project', 1, 'publication-project', 'Publication', 'Topic',
        'WAITING_FINAL_APPROVAL', 0.95, 'YT-PUBLICATION', 60000, ?, ?)
    `).run(publicationNow, publicationNow);
    confirmed.db.raw.prepare(`
      INSERT INTO publication_records(
        id, project_id, channel_id, video_id, privacy_status, final_sha256,
        snapshot_version, snapshot_status, created_at, updated_at
      ) VALUES('old-channel-publication', 'publication-project', 'UC-old', 'old-channel-video',
        'private', 'old-channel-sha', 1, 'current', ?, ?)
    `).run(publicationNow, publicationNow);
    await expect(confirmed.service.confirmAuthorization({
      pendingAuthorizationId: 'pending-authorization',
      expectedChannelId: 'UC-new',
      replaceExisting: true
    })).resolves.toMatchObject({ state: 'confirmed', authorized: true, channelId: 'UC-new' });
    expect(confirmed.secrets.current).toMatchObject({
      youtubeRefreshToken: 'new-refresh',
      youtubeAccessToken: 'new-access',
      youtubeTokenExpiry: 1234
    });
    expect(confirmed.db.raw.prepare(`
      SELECT channel_id, channel_title, credential_fingerprint FROM youtube_connection_binding
    `).get()).toEqual({
      channel_id: 'UC-new',
      channel_title: 'New Channel',
      credential_fingerprint: youtubeCredentialFingerprint('client-id', 'new-refresh')
    });
    const audit = confirmed.db.raw.prepare(`
      SELECT metadata_json FROM audit_log WHERE action = 'youtube.channel_confirmed'
    `).get() as { metadata_json: string };
    expect(JSON.parse(audit.metadata_json)).toEqual({
      channelId: 'UC-new',
      channelTitle: 'New Channel',
      replacedChannelId: 'UC-old'
    });
    expect(audit.metadata_json).not.toMatch(/refresh|access|client-secret/i);
    expect(confirmed.db.raw.prepare(`
      SELECT privacy_status, snapshot_status FROM publication_records
      WHERE id = 'old-channel-publication'
    `).get()).toEqual({ privacy_status: 'private', snapshot_status: 'stale' });
    expect(confirmed.db.raw.prepare(`
      SELECT count(*) AS count FROM exceptions
      WHERE project_id = 'publication-project' AND code = 'STALE_PUBLICATION_SNAPSHOT'
    `).get()).toEqual({ count: 1 });
    confirmed.db.close();
  });

  it('blocks autonomous upload readiness and publication when the confirmed destination does not match', () => {
    const root = mkdtempSync(join(tmpdir(), 'videofactory-youtube-readiness-'));
    roots.push(root);
    const db = new AppDatabase(join(root, 'db.sqlite'));
    const secrets = fakeSecrets({
      youtubeClientId: 'client-id', youtubeClientSecret: 'client-secret', youtubeRefreshToken: 'refresh'
    });
    const oauth = fakeSession({
      source: 'stored', clientId: 'client-id', channelId: 'UC-one', channelTitle: 'One',
      credentials: { refreshToken: 'refresh' }
    });
    const service = new YouTubeService(
      db, () => ({}) as never, secrets.store, {} as ProjectService, vi.fn(), undefined, vi.fn(), oauth.sessions
    );
    expect(service.uploadReadiness()).toMatchObject({ ready: false, code: 'YOUTUBE_AUTH_REQUIRED' });
    db.raw.prepare(`
      INSERT INTO youtube_connection_binding(
        singleton_id, channel_id, channel_title, credential_fingerprint, confirmed_at
      ) VALUES(1, 'UC-one', 'One', ?, '2026-08-25T00:00:00.000Z')
    `).run(youtubeCredentialFingerprint('client-id', 'refresh'));
    expect(service.uploadReadiness()).toMatchObject({ ready: true });
    secrets.store.update({ youtubeClientId: 'different-client-id' });
    expect(service.uploadReadiness()).toMatchObject({ ready: false, code: 'YOUTUBE_AUTH_REQUIRED' });
    expect(() => assertPublicationChannelBinding('UC-other', 'UC-one')).toThrow(/does not match/i);
    expect(() => assertPublicationChannelBinding(null, 'UC-one')).toThrow(/does not match/i);
    expect(() => assertPublicationChannelBinding('UC-one', 'UC-one')).not.toThrow();
    db.close();
  });
});
