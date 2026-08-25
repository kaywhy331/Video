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
    })).rejects.toThrow(/explicit replacement confirmation/i);
    expect(rejected.secrets.current.youtubeRefreshToken).toBe('old-refresh');
    expect(rejected.db.raw.prepare(`SELECT channel_id FROM youtube_connection_binding`).get())
      .toEqual({ channel_id: 'UC-old' });
    rejected.db.close();

    const confirmed = fixture();
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
