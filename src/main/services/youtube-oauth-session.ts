import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { google } from 'googleapis';
import type { CodeChallengeMethod } from 'google-auth-library';

const CALLBACK_PATH = '/oauth2callback';
const DEFAULT_TTL_MS = 5 * 60_000;

export interface YouTubeOAuthCredentials {
  accessToken?: string;
  refreshToken?: string;
  expiryDate?: number;
}

export interface YouTubeChannelIdentity {
  channelId: string;
  channelTitle: string;
}

export interface YouTubeOAuthCandidate extends YouTubeChannelIdentity {
  clientId: string;
  credentials: YouTubeOAuthCredentials;
  source: 'authorization' | 'stored';
}

export interface YouTubeOAuthSessionSnapshot {
  pendingAuthorizationId: string;
  phase: 'awaiting_callback' | 'exchanging' | 'confirmation_required';
  expiresAt: string;
  channelId: string | null;
  channelTitle: string | null;
}

export interface YouTubeOAuthSafeError {
  code: 'authorization_failed' | 'authorization_expired' | 'browser_open_failed';
  message: string;
}

export interface YouTubeOAuthProvider {
  authorizationUrl(input: { state: string; codeChallenge: string }): string;
  exchangeCode(input: { code: string; codeVerifier: string }): Promise<YouTubeOAuthCandidate>;
  identifyChannel(credentials: YouTubeOAuthCredentials): Promise<YouTubeChannelIdentity>;
  revoke(credentials: YouTubeOAuthCredentials): Promise<void>;
}

export type YouTubeOAuthProviderFactory = (input: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}) => YouTubeOAuthProvider;

export interface YouTubeOAuthSessionPort {
  begin(input: { clientId: string; clientSecret: string }): Promise<YouTubeOAuthSessionSnapshot>;
  stageStored(input: {
    clientId: string;
    clientSecret: string;
    credentials: YouTubeOAuthCredentials;
  }): Promise<YouTubeOAuthSessionSnapshot>;
  snapshot(): YouTubeOAuthSessionSnapshot | null;
  safeError(): YouTubeOAuthSafeError | null;
  confirm(
    pendingAuthorizationId: string,
    expectedChannelId: string,
    commit: (candidate: YouTubeOAuthCandidate) => void | Promise<void>
  ): Promise<void>;
  cancel(pendingAuthorizationId: string): Promise<'authorization' | 'stored'>;
  shutdown(): Promise<void>;
}

interface ActiveSession {
  id: string;
  phase: YouTubeOAuthSessionSnapshot['phase'];
  expiresAtMs: number;
  provider: YouTubeOAuthProvider;
  source: YouTubeOAuthCandidate['source'];
  server: Server | null;
  timer: ReturnType<typeof setTimeout>;
  redirectUri: string | null;
  state: string | null;
  codeVerifier: string | null;
  callbackConsumed: boolean;
  candidate: YouTubeOAuthCandidate | null;
}

function base64UrlSha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function secretEqual(actual: string, expected: string): boolean {
  const actualDigest = createHash('sha256').update(actual).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

function validIdentity(value: YouTubeChannelIdentity): boolean {
  return Boolean(value.channelId.trim() && value.channelTitle.trim());
}

function callbackHtml(title: string, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>${message}</p></body></html>`;
}

function writeCallbackResponse(response: ServerResponse, status: number, title: string, message: string): void {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  response.end(callbackHtml(title, message));
}

export function createGoogleYouTubeOAuthProvider(input: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
}): YouTubeOAuthProvider {
  const auth = new google.auth.OAuth2(input.clientId, input.clientSecret, input.redirectUri);
  const credentialsFor = (credentials: YouTubeOAuthCredentials) => ({
    access_token: credentials.accessToken,
    refresh_token: credentials.refreshToken,
    expiry_date: credentials.expiryDate
  });
  const identify = async (credentials: YouTubeOAuthCredentials): Promise<YouTubeChannelIdentity> => {
    auth.setCredentials(credentialsFor(credentials));
    const response = await google.youtube({ version: 'v3', auth }).channels.list({
      part: ['id', 'snippet'],
      mine: true,
      maxResults: 1
    });
    const channel = response.data.items?.[0];
    const identity = {
      channelId: channel?.id?.trim() ?? '',
      channelTitle: channel?.snippet?.title?.trim() ?? ''
    };
    if (!validIdentity(identity)) throw new Error('The authorized Google account has no usable YouTube channel.');
    return identity;
  };
  const revoke = async (credentials: YouTubeOAuthCredentials): Promise<void> => {
    auth.setCredentials(credentialsFor(credentials));
    await auth.revokeCredentials();
  };
  return {
    authorizationUrl: ({ state, codeChallenge }) => auth.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: input.scopes,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256' as CodeChallengeMethod
    }),
    exchangeCode: async ({ code, codeVerifier }) => {
      const response = await auth.getToken({ code, codeVerifier });
      const credentials: YouTubeOAuthCredentials = {
        accessToken: response.tokens.access_token ?? undefined,
        refreshToken: response.tokens.refresh_token ?? undefined,
        expiryDate: response.tokens.expiry_date ?? undefined
      };
      if (!credentials.refreshToken) {
        await revoke(credentials).catch(() => undefined);
        throw new Error('Google did not return an offline refresh credential.');
      }
      try {
        return { ...await identify(credentials), clientId: input.clientId, credentials, source: 'authorization' };
      } catch (error) {
        await revoke(credentials).catch(() => undefined);
        throw error;
      }
    },
    identifyChannel: identify,
    revoke
  };
}

export class YouTubeOAuthSessionManager implements YouTubeOAuthSessionPort {
  private active: ActiveSession | null = null;
  private lastError: YouTubeOAuthSafeError | null = null;

  constructor(private readonly options: {
    createProvider: YouTubeOAuthProviderFactory;
    openExternal: (url: string) => Promise<unknown>;
    ttlMs?: number;
    now?: () => number;
  }) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private ttlMs(): number {
    return Math.min(DEFAULT_TTL_MS, Math.max(1, this.options.ttlMs ?? DEFAULT_TTL_MS));
  }

  private armExpiry(session: Omit<ActiveSession, 'timer'>): ActiveSession {
    const timer = setTimeout(() => {
      if (this.active === result) void this.expire(result);
    }, Math.max(1, session.expiresAtMs - this.now()));
    timer.unref();
    const result: ActiveSession = { ...session, timer };
    return result;
  }

  private async expire(session: ActiveSession): Promise<void> {
    if (this.active !== session) return;
    this.active = null;
    clearTimeout(session.timer);
    session.server?.close();
    this.lastError = {
      code: 'authorization_expired',
      message: 'YouTube authorization expired. Start the connection again.'
    };
    if (session.candidate && session.source === 'authorization') {
      await session.provider.revoke(session.candidate.credentials).catch(() => undefined);
    }
  }

  private async replaceActive(): Promise<void> {
    const session = this.active;
    if (!session) return;
    if (session.source === 'authorization') {
      await this.cancel(session.id);
      return;
    }
    this.discardWithoutRevocation(session);
  }

  private discardWithoutRevocation(session: ActiveSession): void {
    if (this.active !== session) return;
    this.active = null;
    clearTimeout(session.timer);
    session.server?.close();
  }

  async begin(input: { clientId: string; clientSecret: string }): Promise<YouTubeOAuthSessionSnapshot> {
    await this.replaceActive();
    this.lastError = null;
    const state = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(64).toString('base64url');
    const id = randomUUID();
    let session: ActiveSession | null = null;
    const server = createServer((request, response) => {
      if (!session) {
        writeCallbackResponse(response, 503, 'Authorization unavailable', 'Return to VideoFactory and try again.');
        return;
      }
      void this.handleCallback(session, request, response);
    });

    await new Promise<void>((resolve, reject) => {
      const onInitialError = (error: Error): void => reject(error);
      server.once('error', onInitialError);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', onInitialError);
        resolve();
      });
    });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    if (!port) {
      server.close();
      throw new Error('YouTube authorization listener could not start.');
    }
    const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
    let provider: YouTubeOAuthProvider;
    try {
      provider = this.options.createProvider({ ...input, redirectUri });
    } catch {
      server.close();
      throw new Error('YouTube authorization could not start. Check the OAuth client configuration.');
    }
    session = this.armExpiry({
      id,
      phase: 'awaiting_callback',
      expiresAtMs: this.now() + this.ttlMs(),
      provider,
      source: 'authorization',
      server,
      redirectUri,
      state,
      codeVerifier,
      callbackConsumed: false,
      candidate: null
    });
    this.active = session;
    server.on('error', () => {
      if (this.active === session) void this.fail(session, 'authorization_failed');
    });

    let authorizationUrl: string;
    try {
      authorizationUrl = provider.authorizationUrl({
        state,
        codeChallenge: base64UrlSha256(codeVerifier)
      });
    } catch {
      await this.fail(session, 'authorization_failed');
      throw new Error('YouTube authorization could not start. Check the OAuth client configuration.');
    }
    try {
      await this.options.openExternal(authorizationUrl);
    } catch {
      await this.fail(session, 'browser_open_failed');
      throw new Error('The authorization page could not be opened. Start the connection again.');
    }
    const snapshot = this.snapshot();
    if (!snapshot || this.active !== session) {
      throw new Error('YouTube authorization expired before the browser could open. Start again.');
    }
    return snapshot;
  }

  async stageStored(input: {
    clientId: string;
    clientSecret: string;
    credentials: YouTubeOAuthCredentials;
  }): Promise<YouTubeOAuthSessionSnapshot> {
    if (this.active) return this.snapshot() as YouTubeOAuthSessionSnapshot;
    this.lastError = null;
    const provider = this.options.createProvider({
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      redirectUri: `http://127.0.0.1${CALLBACK_PATH}`
    });
    const session = this.armExpiry({
      id: randomUUID(),
      phase: 'exchanging',
      expiresAtMs: this.now() + this.ttlMs(),
      provider,
      source: 'stored',
      server: null,
      redirectUri: null,
      state: null,
      codeVerifier: null,
      callbackConsumed: true,
      candidate: null
    });
    this.active = session;
    try {
      const identity = await provider.identifyChannel(input.credentials);
      if (this.active !== session) throw new Error('YouTube authorization was cancelled.');
      session.candidate = {
        ...identity,
        clientId: input.clientId,
        credentials: input.credentials,
        source: 'stored'
      };
      session.phase = 'confirmation_required';
      return this.snapshot() as YouTubeOAuthSessionSnapshot;
    } catch {
      if (this.active === session) await this.fail(session, 'authorization_failed');
      throw new Error('The stored YouTube authorization could not identify a channel. Reconnect YouTube.');
    }
  }

  private async handleCallback(
    session: ActiveSession,
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    if (this.active !== session) {
      writeCallbackResponse(response, 410, 'Authorization expired', 'Return to VideoFactory and start again.');
      return;
    }
    if (this.now() >= session.expiresAtMs) {
      await this.expire(session);
      writeCallbackResponse(response, 410, 'Authorization expired', 'Return to VideoFactory and start again.');
      return;
    }
    if (request.method !== 'GET') {
      response.setHeader('allow', 'GET');
      await this.fail(session, 'authorization_failed');
      writeCallbackResponse(response, 405, 'Invalid authorization request', 'Return to VideoFactory and try again.');
      return;
    }
    const target = request.url ?? '';
    if (!target.startsWith('/') || target.startsWith('//') || !session.redirectUri) {
      await this.fail(session, 'authorization_failed');
      writeCallbackResponse(response, 404, 'Not found', 'Return to VideoFactory and try again.');
      return;
    }
    const url = new URL(target, session.redirectUri);
    if (url.pathname !== CALLBACK_PATH) {
      await this.fail(session, 'authorization_failed');
      writeCallbackResponse(response, 404, 'Not found', 'Return to VideoFactory and try again.');
      return;
    }
    if (session.callbackConsumed) {
      writeCallbackResponse(response, 409, 'Authorization already used', 'Return to VideoFactory and start again.');
      return;
    }
    const returnedState = url.searchParams.get('state');
    if (!returnedState || !session.state || !secretEqual(returnedState, session.state)) {
      await this.fail(session, 'authorization_failed');
      writeCallbackResponse(response, 400, 'Authorization rejected', 'The authorization response was not valid. Return to VideoFactory and try again.');
      return;
    }

    session.callbackConsumed = true;
    session.state = null;
    session.server?.close();
    const code = url.searchParams.get('code');
    if (url.searchParams.has('error') || !code || !session.codeVerifier) {
      await this.fail(session, 'authorization_failed');
      writeCallbackResponse(response, 400, 'Authorization failed', 'No credentials were saved. Return to VideoFactory and try again.');
      return;
    }

    session.phase = 'exchanging';
    const codeVerifier = session.codeVerifier;
    session.codeVerifier = null;
    try {
      const candidate = await session.provider.exchangeCode({ code, codeVerifier });
      if (this.active !== session) {
        await session.provider.revoke(candidate.credentials).catch(() => undefined);
        writeCallbackResponse(response, 410, 'Authorization cancelled', 'No credentials were saved.');
        return;
      }
      if (!candidate.credentials.refreshToken || !validIdentity(candidate)) {
        await session.provider.revoke(candidate.credentials).catch(() => undefined);
        await this.fail(session, 'authorization_failed');
        writeCallbackResponse(response, 400, 'Authorization failed', 'No credentials were saved. Return to VideoFactory and try again.');
        return;
      }
      session.candidate = { ...candidate, source: 'authorization' };
      session.phase = 'confirmation_required';
      writeCallbackResponse(response, 200, 'Channel confirmation required', 'Return to VideoFactory to verify the exact destination channel.');
    } catch {
      await this.fail(session, 'authorization_failed');
      writeCallbackResponse(response, 400, 'Authorization failed', 'No credentials were saved. Return to VideoFactory and try again.');
    }
  }

  private async fail(session: ActiveSession, code: YouTubeOAuthSafeError['code']): Promise<void> {
    if (this.active !== session) return;
    this.active = null;
    clearTimeout(session.timer);
    session.server?.close();
    this.lastError = code === 'browser_open_failed'
      ? { code, message: 'The authorization page could not be opened. Start the connection again.' }
      : { code, message: 'YouTube authorization failed. No credentials were saved.' };
    if (session.candidate) {
      await session.provider.revoke(session.candidate.credentials).catch(() => undefined);
    }
  }

  snapshot(): YouTubeOAuthSessionSnapshot | null {
    const session = this.active;
    if (!session) return null;
    return {
      pendingAuthorizationId: session.id,
      phase: session.phase,
      expiresAt: new Date(session.expiresAtMs).toISOString(),
      channelId: session.candidate?.channelId ?? null,
      channelTitle: session.candidate?.channelTitle ?? null
    };
  }

  safeError(): YouTubeOAuthSafeError | null {
    return this.lastError;
  }

  async confirm(
    pendingAuthorizationId: string,
    expectedChannelId: string,
    commit: (candidate: YouTubeOAuthCandidate) => void | Promise<void>
  ): Promise<void> {
    const session = this.active;
    if (!session || !secretEqual(pendingAuthorizationId, session.id) || session.phase !== 'confirmation_required'
      || !session.candidate || !secretEqual(expectedChannelId, session.candidate.channelId)) {
      if (session) {
        if (session.source === 'stored') this.discardWithoutRevocation(session);
        else await this.cancel(session.id);
      }
      throw new Error('The pending YouTube channel confirmation did not match and was discarded.');
    }
    try {
      await commit(session.candidate);
    } catch (error) {
      if (session.source === 'stored') this.discardWithoutRevocation(session);
      else await this.cancel(session.id);
      throw error;
    }
    if (this.active === session) {
      this.active = null;
      clearTimeout(session.timer);
      session.server?.close();
      this.lastError = null;
    }
  }

  async cancel(pendingAuthorizationId: string): Promise<'authorization' | 'stored'> {
    const session = this.active;
    if (!session || !secretEqual(pendingAuthorizationId, session.id)) {
      throw new Error('The pending YouTube authorization was not found.');
    }
    this.active = null;
    clearTimeout(session.timer);
    session.server?.close();
    this.lastError = null;
    if (session.candidate) {
      await session.provider.revoke(session.candidate.credentials).catch(() => undefined);
    }
    return session.source;
  }

  async shutdown(): Promise<void> {
    const session = this.active;
    if (!session) return;
    if (session.source === 'authorization') {
      await this.cancel(session.id);
      return;
    }
    this.discardWithoutRevocation(session);
  }
}
