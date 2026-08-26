import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  YouTubeOAuthSessionManager,
  type YouTubeOAuthProvider,
  type YouTubeOAuthProviderFactory,
  type YouTubeOAuthSecurityRejection
} from '@main/services/youtube-oauth-session';

interface CallbackResponse {
  status: number;
  body: string;
}

function callback(
  redirectUri: string,
  path: string,
  method = 'GET',
  host = '127.0.0.1'
): Promise<CallbackResponse> {
  const redirect = new URL(redirectUri);
  return new Promise((resolve, reject) => {
    const outgoing = request({
      hostname: '127.0.0.1',
      port: Number(redirect.port),
      path,
      method,
      headers: { host }
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

function harness(now?: () => number) {
  let redirectUri = '';
  let authorizationInput: { state: string; codeChallenge: string } | null = null;
  let openedUrl = '';
  const exchangeCode = vi.fn(async ({ code, codeVerifier }: { code: string; codeVerifier: string }) => ({
    source: 'authorization' as const,
    clientId: 'client-id',
    channelId: 'UC-exact-channel',
    channelTitle: 'Exact Channel',
    credentials: {
      accessToken: `access-for-${code}`,
      refreshToken: 'refresh-secret',
      expiryDate: 2_000_000_000_000
    },
    codeVerifier
  }));
  const revoke = vi.fn(async () => undefined);
  const securityRejections: YouTubeOAuthSecurityRejection[] = [];
  const provider: YouTubeOAuthProvider = {
    authorizationUrl: input => {
      authorizationInput = input;
      const url = new URL('https://accounts.example.test/authorize');
      url.searchParams.set('state', input.state);
      url.searchParams.set('code_challenge', input.codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
      return url.toString();
    },
    exchangeCode,
    identifyChannel: vi.fn(async () => ({ channelId: 'UC-exact-channel', channelTitle: 'Exact Channel' })),
    revoke
  };
  const createProvider: YouTubeOAuthProviderFactory = input => {
    redirectUri = input.redirectUri;
    return provider;
  };
  const manager = new YouTubeOAuthSessionManager({
    createProvider,
    openExternal: async url => { openedUrl = url; },
    onSecurityRejection: rejection => { securityRejections.push(rejection); },
    now,
    ttlMs: 1_000
  });
  return {
    manager,
    exchangeCode,
    revoke,
    securityRejections,
    get redirectUri() { return redirectUri; },
    get authorizationInput() { return authorizationInput; },
    get openedUrl() { return openedUrl; }
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('YouTube OAuth loopback session', () => {
  it('[YT-009][SEC-009] enforces state, PKCE, callback shape, replay protection, and secret-free snapshots', async () => {
    const rejectedStates: string[] = [];
    const callbackRejections: YouTubeOAuthSecurityRejection[] = [];
    const assertRejected = async (path: (state: string) => string, method = 'GET', status = 400) => {
      const rejected = harness();
      await rejected.manager.begin({ clientId: 'client-id', clientSecret: 'client-secret' });
      const rejectedState = new URL(rejected.openedUrl).searchParams.get('state') as string;
      rejectedStates.push(rejectedState);
      expect((await callback(rejected.redirectUri, path(rejectedState), method)).status).toBe(status);
      callbackRejections.push(...rejected.securityRejections);
      expect(rejected.exchangeCode).not.toHaveBeenCalled();
      const afterFailure = await callback(
        rejected.redirectUri,
        '/oauth2callback?code=unused&state=unused'
      ).catch(() => null);
      expect(afterFailure === null || afterFailure.status === 410).toBe(true);
    };
    await assertRejected(() => '/wrong?code=secret&state=secret', 'GET', 404);
    await assertRejected(state => `/oauth2callback?code=secret&state=${state}`, 'POST', 405);
    await assertRejected(() => '/oauth2callback?code=secret');
    await assertRejected(() => '/oauth2callback?code=secret&state=wrong');
    expect(new Set(rejectedStates).size).toBe(rejectedStates.length);
    expect(callbackRejections.map(rejection => rejection.code)).toEqual([
      'OAUTH_CALLBACK_PATH_INVALID',
      'OAUTH_CALLBACK_METHOD_INVALID',
      'OAUTH_STATE_INVALID',
      'OAUTH_STATE_INVALID'
    ]);
    expect(callbackRejections.every(rejection => typeof rejection.recovery === 'string')).toBe(true);
    expect(JSON.stringify(callbackRejections)).not.toMatch(/client-secret|refresh-secret|access-for|code=secret|state=secret/i);

    const value = harness();
    const started = await value.manager.begin({ clientId: 'client-id', clientSecret: 'client-secret' });
    expect(started.phase).toBe('awaiting_callback');
    expect(JSON.stringify(started)).not.toMatch(/client-secret|refresh-secret|access-for|state|verifier|challenge/i);

    const authorization = new URL(value.openedUrl);
    const state = authorization.searchParams.get('state') as string;
    const challenge = authorization.searchParams.get('code_challenge') as string;
    expect(Buffer.from(state, 'base64url')).toHaveLength(32);
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');

    const accepted = await callback(
      value.redirectUri,
      `/oauth2callback?code=one-time-code&state=${encodeURIComponent(state)}`,
      'GET',
      'attacker.invalid'
    );
    expect(accepted.status).toBe(200);
    expect(accepted.body).not.toMatch(/one-time-code|refresh-secret|access-for|client-secret/);
    expect(value.exchangeCode).toHaveBeenCalledTimes(1);
    const exchange = value.exchangeCode.mock.calls[0]?.[0];
    expect(exchange).toBeDefined();
    if (!exchange) throw new Error('Expected the OAuth exchange to capture a PKCE verifier.');
    expect(createHash('sha256').update(exchange.codeVerifier).digest('base64url')).toBe(challenge);

    const pending = value.manager.snapshot();
    expect(pending).toMatchObject({
      phase: 'confirmation_required',
      channelId: 'UC-exact-channel',
      channelTitle: 'Exact Channel'
    });
    expect(JSON.stringify(pending)).not.toMatch(/refresh-secret|access-for|one-time-code|verifier|state/i);

    const replay = await callback(
      value.redirectUri,
      `/oauth2callback?code=replayed&state=${encodeURIComponent(state)}`
    ).catch(() => null);
    expect(replay === null || replay.status === 409).toBe(true);
    expect(value.exchangeCode).toHaveBeenCalledTimes(1);

    let committedRefreshToken = '';
    await value.manager.confirm(
      started.pendingAuthorizationId,
      'UC-exact-channel',
      candidate => { committedRefreshToken = candidate.credentials.refreshToken ?? ''; }
    );
    expect(committedRefreshToken).toBe('refresh-secret');
    expect(value.manager.snapshot()).toBeNull();
  });

  it('[YT-010] discards mismatched, cancelled, expired, and shutdown authorization sessions', async () => {
    const mismatch = harness();
    const mismatchStarted = await mismatch.manager.begin({ clientId: 'client-id', clientSecret: 'client-secret' });
    const mismatchState = new URL(mismatch.openedUrl).searchParams.get('state') as string;
    await callback(
      mismatch.redirectUri,
      `/oauth2callback?code=code&state=${encodeURIComponent(mismatchState)}`
    );
    await expect(mismatch.manager.confirm(
      mismatchStarted.pendingAuthorizationId,
      'UC-wrong-channel',
      vi.fn()
    )).rejects.toMatchObject({
      code: 'OAUTH_CONFIRMATION_MISMATCH',
      recovery: expect.stringContaining('confirm the exact channel')
    });
    expect(mismatch.securityRejections.at(-1)).toMatchObject({
      operation: 'confirmation.identity_check',
      code: 'OAUTH_CONFIRMATION_MISMATCH'
    });
    expect(mismatch.revoke).toHaveBeenCalledWith(expect.objectContaining({ refreshToken: 'refresh-secret' }));
    expect(mismatch.manager.snapshot()).toBeNull();

    const cancelled = harness();
    const cancelledStarted = await cancelled.manager.begin({ clientId: 'client-id', clientSecret: 'client-secret' });
    await expect(cancelled.manager.cancel(cancelledStarted.pendingAuthorizationId)).resolves.toBe('authorization');
    await expect(callback(cancelled.redirectUri, '/oauth2callback?code=unused&state=unused')).rejects.toThrow();
    expect(cancelled.exchangeCode).not.toHaveBeenCalled();

    let clock = 10_000;
    const expired = harness(() => clock);
    await expired.manager.begin({ clientId: 'client-id', clientSecret: 'client-secret' });
    const expiredState = new URL(expired.openedUrl).searchParams.get('state') as string;
    clock += 1_000;
    expect((await callback(
      expired.redirectUri,
      `/oauth2callback?code=expired&state=${encodeURIComponent(expiredState)}`
    )).status).toBe(410);
    expect(expired.exchangeCode).not.toHaveBeenCalled();

    const shutdown = harness();
    await shutdown.manager.begin({ clientId: 'client-id', clientSecret: 'client-secret' });
    await shutdown.manager.shutdown();
    await expect(callback(shutdown.redirectUri, '/oauth2callback?code=unused&state=unused')).rejects.toThrow();
    expect(shutdown.exchangeCode).not.toHaveBeenCalled();

    const stored = harness();
    const storedInput = {
      clientId: 'client-id', clientSecret: 'client-secret', credentials: { refreshToken: 'stored-refresh' }
    };
    await stored.manager.stageStored(storedInput);
    await stored.manager.shutdown();
    expect(stored.revoke).not.toHaveBeenCalled();
    const stagedAgain = await stored.manager.stageStored(storedInput);
    await expect(stored.manager.confirm(
      stagedAgain.pendingAuthorizationId,
      'UC-wrong-channel',
      vi.fn()
    )).rejects.toThrow(/did not match.*discarded/i);
    expect(stored.revoke).not.toHaveBeenCalled();
    const explicitlyCancelled = await stored.manager.stageStored(storedInput);
    await stored.manager.cancel(explicitlyCancelled.pendingAuthorizationId);
    expect(stored.revoke).toHaveBeenCalledWith({ refreshToken: 'stored-refresh' });
  });
});
