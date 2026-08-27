import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { shell } from 'electron';
import type { Auth, youtube_v3 } from 'googleapis';
import type { AppDatabase } from '../database/database';
import { googleApis } from '../google-apis';
import type {
  AppSettings,
  PublicationApprovalResult,
  YouTubeAuthorizationConfirmation,
  YouTubeConnectionStatus
} from '@shared/types';
import type { SecretStore } from '../secret-store';
import {
  formatSecurityError,
  PrivilegedOperationError,
  recordSecurityRejection,
  rejectPrivilegedOperation
} from '../security-events';
import { redactSecrets } from '../logger';
import type { ProjectService } from './project-service';
import {
  createGoogleYouTubeOAuthProvider,
  YouTubeOAuthSessionManager,
  type YouTubeOAuthCredentials,
  type YouTubeOAuthSessionPort,
  type YouTubeOAuthSessionSnapshot
} from './youtube-oauth-session';
import {
  parseCommittedRange,
  reusableEnglishCaptionId,
  resumableContentRange
} from '@shared/youtube-resumable';
import {
  ActiveFinalService,
  PublicationIdentityService,
  StalePublicationSnapshotError,
  invalidatePublicationSnapshots,
  type PublicationSnapshot
} from './active-final-service';
import {
  type ProviderHealthStatus,
  ProviderPolicyService
} from './provider-policy';

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
  'https://www.googleapis.com/auth/spreadsheets.readonly'
];

interface UploadRow {
  id: string;
  project_id: string;
  video_id: string | null;
  upload_session_uri: string | null;
  caption_id: string | null;
  thumbnail_uploaded: number;
  channel_id: string | null;
  final_render_id: string | null;
  final_sha256: string;
  selected_package_id: string | null;
  approval_hash: string | null;
  snapshot_version: number;
  snapshot_status: string;
}

interface YouTubeBindingRow {
  channel_id: string;
  channel_title: string;
  credential_fingerprint: string;
  confirmed_at: string;
}

export function youtubeCredentialFingerprint(clientId: string, refreshToken: string): string {
  return createHash('sha256')
    .update(`videofactory-youtube-binding-v1\0${clientId}\0${refreshToken}`)
    .digest('hex');
}

export function assertPublicationUploadOwner(
  existing: Pick<UploadRow, 'project_id'> | undefined,
  projectId: string
): void {
  if (existing && existing.project_id !== projectId) {
    throw new PrivilegedOperationError(
      'PUBLICATION_PROJECT_OWNER_MISMATCH',
      'This final render hash is already assigned to a different project upload.',
      'Use the publication receipt owned by this project or create a new final render.'
    );
  }
}

export function assertPublicationChannelBinding(
  publicationChannelId: string | null | undefined,
  confirmedChannelId: string
): void {
  if (publicationChannelId !== confirmedChannelId) {
    throw new PrivilegedOperationError(
      'PUBLICATION_CHANNEL_MISMATCH',
      'The YouTube publication destination does not match the confirmed channel.',
      'Keep the upload private, reconnect YouTube, and confirm the exact destination channel.'
    );
  }
}

export function privateVideoStatus(
  containsSyntheticMedia: boolean
): youtube_v3.Schema$VideoStatus {
  return {
    privacyStatus: 'private',
    selfDeclaredMadeForKids: false,
    containsSyntheticMedia
  };
}

interface ResumableVideoResponse {
  id?: string;
}

function responseHeader(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== 'object') return null;
  const collection = headers as Record<string, unknown> & { get?: (key: string) => unknown };
  const get = collection.get;
  const value = typeof get === 'function'
    ? get.call(headers, name)
    : collection[name] ?? collection[name.toLowerCase()] ?? collection[name.toUpperCase()];
  return value === null || value === undefined ? null : String(value);
}

function validateUploadSession(value: string): string {
  const url = new URL(value);
  const allowed = ['www.googleapis.com', 'youtube.googleapis.com', 'content.googleapis.com'];
  if (url.protocol !== 'https:' || !allowed.includes(url.hostname.toLowerCase())) {
    throw new Error('YouTube returned an invalid resumable upload session URL.');
  }
  return url.toString();
}

function isTransientUploadError(error: unknown): boolean {
  if (error instanceof StalePublicationSnapshotError) return false;
  const candidate = error as { status?: number; response?: { status?: number } };
  const status = candidate.response?.status ?? candidate.status;
  return status === undefined || status === 408 || status === 429 || status >= 500;
}

function googleErrorDetails(error: unknown): { status: number | undefined; reasons: string[]; message: string } {
  const candidate = error as {
    status?: number;
    message?: string;
    errors?: Array<{ reason?: string; message?: string }>;
    response?: {
      status?: number;
      data?: { error?: { message?: string; errors?: Array<{ reason?: string; message?: string }> } };
    };
  };
  const errors = candidate.response?.data?.error?.errors ?? candidate.errors ?? [];
  return {
    status: candidate.response?.status ?? candidate.status,
    reasons: errors.flatMap(item => item.reason ? [item.reason] : []),
    message: [
      candidate.message,
      candidate.response?.data?.error?.message,
      ...errors.flatMap(item => item.message ? [item.message] : [])
    ].filter(Boolean).join(' | ')
  };
}

export interface YouTubeProviderHealthFailure {
  status: ProviderHealthStatus;
  statusCode: number | null;
  message: string;
}

export function classifyYouTubeProviderHealthFailure(
  error: unknown
): YouTubeProviderHealthFailure | null {
  const details = googleErrorDetails(error);
  const reasons = new Set(details.reasons.map(reason => reason.toLowerCase()));
  const code = String((error as { code?: unknown })?.code ?? '').toUpperCase();
  const quotaFailure = details.status === 402
    || details.status === 429
    || [...reasons].some(reason => (
      reason.includes('quota')
      || reason.includes('ratelimit')
      || reason === 'uploadlimitexceeded'
      || reason === 'dailylimitexceeded'
    ));
  if (quotaFailure) {
    return {
      status: 'quota_exhausted',
      statusCode: details.status ?? null,
      message: 'YouTube API quota is exhausted; retry after quota resets or review the Google Cloud quota.'
    };
  }
  const authorizationFailure = details.status === 401
    || reasons.has('autherror')
    || reasons.has('invalidcredentials')
    || reasons.has('insufficientpermissions');
  if (authorizationFailure) {
    return {
      status: 'auth_invalid',
      statusCode: details.status ?? null,
      message: 'YouTube authorization is invalid or expired; reconnect and confirm the intended channel.'
    };
  }
  if (details.status !== undefined && details.status >= 400) {
    return {
      status: 'provider_failure',
      statusCode: details.status,
      message: 'YouTube rejected the API request; inspect the private publication exception and retry safely.'
    };
  }
  if (['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ERR_SOCKET_TIMEOUT'].includes(code)) {
    return {
      status: 'timeout',
      statusCode: null,
      message: 'YouTube did not respond before the request timeout; the operation remains retryable.'
    };
  }
  if (['ECONNREFUSED', 'ECONNRESET', 'ENETDOWN', 'ENETUNREACH', 'EAI_AGAIN'].includes(code)) {
    return {
      status: 'unavailable',
      statusCode: null,
      message: 'YouTube is temporarily unreachable; the operation remains retryable.'
    };
  }
  return null;
}

export function isYouTubeStudioRestriction(error: unknown): boolean {
  const details = googleErrorDetails(error);
  if (details.status !== 403) return false;
  const restrictedReasons = new Set([
    'forbidden',
    'youtubeSignupRequired',
    'accountDelegationForbidden',
    'publicAccessNotAllowed',
    'publishAtNotAllowed'
  ]);
  return details.reasons.some(reason => restrictedReasons.has(reason))
    || /unverified|restricted.*private|private.*restricted|public.*not allowed|publishAt.*not allowed|studio/i.test(details.message);
}

function studioVideoUrl(videoId: string): string {
  return `https://studio.youtube.com/video/${encodeURIComponent(videoId)}/edit`;
}

type UpdatePublicationStatus = (
  auth: Auth.OAuth2Client,
  videoId: string,
  status: youtube_v3.Schema$VideoStatus
) => Promise<youtube_v3.Schema$VideoStatus | null>;

export interface YouTubeApiRuntime {
  createOAuthClient(clientId: string, clientSecret: string): Auth.OAuth2Client;
  createYouTubeClient(auth: Auth.OAuth2Client): youtube_v3.Youtube;
}

const defaultYouTubeApiRuntime: YouTubeApiRuntime = {
  createOAuthClient: (clientId, clientSecret) => new (googleApis().google.auth.OAuth2)(clientId, clientSecret),
  createYouTubeClient: auth => googleApis().google.youtube({ version: 'v3', auth })
};

function retryDelay(attempt: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt + Math.floor(Math.random() * 350)));
}

export async function awaitUsableYouTubeProcessing(options: {
  readStatus: () => Promise<string | null | undefined>;
  onProgress?: (attempt: number, status: string | null) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  maximumAttempts?: number;
  intervalMs?: number;
}): Promise<void> {
  const maximumAttempts = Math.max(1, options.maximumAttempts ?? 20);
  const intervalMs = Math.max(0, options.intervalMs ?? 15_000);
  const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const status = (await options.readStatus()) ?? null;
    if (status === 'succeeded') return;
    if (status === 'failed' || status === 'terminated') {
      throw new Error(`YouTube processing ${status}.`);
    }
    options.onProgress?.(attempt, status);
    if (attempt < maximumAttempts - 1) await sleep(intervalMs);
  }
  throw new Error('YouTube processing did not finish within the configured polling window.');
}

export class YouTubeService {
  private readonly oauthSessions: YouTubeOAuthSessionPort;
  private readonly publications: PublicationIdentityService;
  private legacyInspectionAttempted = false;

  constructor(
    private readonly db: AppDatabase,
    private readonly settings: () => AppSettings,
    private readonly secrets: SecretStore,
    private readonly projects: ProjectService,
    private readonly progress: (projectId: string, progress: number, message: string) => void,
    private readonly updatePublicationStatus: UpdatePublicationStatus = async (auth, videoId, status) => {
      const result = await googleApis().google.youtube({ version: 'v3', auth }).videos.update({
        part: ['status'],
        requestBody: { id: videoId, status }
      });
      return result.data.status ?? null;
    },
    private readonly openExternal: (url: string) => Promise<unknown> = url => shell.openExternal(url, { activate: true }),
    oauthSessions?: YouTubeOAuthSessionPort,
    activeFinal = new ActiveFinalService(db, () => settings().outputFolder),
    private readonly apiRuntime: YouTubeApiRuntime = defaultYouTubeApiRuntime,
    private readonly providerPolicy?: ProviderPolicyService
  ) {
    this.oauthSessions = oauthSessions ?? new YouTubeOAuthSessionManager({
      openExternal: this.openExternal,
      createProvider: input => createGoogleYouTubeOAuthProvider({ ...input, scopes: SCOPES }),
      onSecurityRejection: rejection => recordSecurityRejection(this.db, {
        flow: 'oauth',
        operation: rejection.operation,
        code: rejection.code,
        recovery: rejection.recovery,
        entityType: 'youtube_oauth',
        entityId: 'youtube',
        context: rejection.context
      })
    });
    this.publications = new PublicationIdentityService(db, activeFinal);
  }

  createUploadSnapshot(projectId: string): PublicationSnapshot {
    const binding = this.requireConfirmedBinding();
    return this.publications.capture(projectId, binding.channel_id);
  }

  private binding(): YouTubeBindingRow | null {
    return (this.db.raw.prepare(`
      SELECT channel_id, channel_title, credential_fingerprint, confirmed_at
      FROM youtube_connection_binding WHERE singleton_id = 1
    `).get() as YouTubeBindingRow | undefined) ?? null;
  }

  private credentials(secret = this.secrets.getAll()): YouTubeOAuthCredentials {
    return {
      refreshToken: secret.youtubeRefreshToken,
      accessToken: secret.youtubeAccessToken,
      expiryDate: secret.youtubeTokenExpiry
    };
  }

  private matchingBinding(secret = this.secrets.getAll()): YouTubeBindingRow | null {
    const binding = this.binding();
    if (!binding || !secret.youtubeRefreshToken) return null;
    if (!secret.youtubeClientId) return null;
    return binding.credential_fingerprint === youtubeCredentialFingerprint(
      secret.youtubeClientId,
      secret.youtubeRefreshToken
    )
      ? binding
      : null;
  }

  private requireConfirmedBinding(secret = this.secrets.getAll()): YouTubeBindingRow {
    const binding = this.matchingBinding(secret);
    if (!binding) {
      return this.rejectPublication(
        'YOUTUBE_CHANNEL_NOT_CONFIRMED',
        'upload.binding_check',
        'Confirm the exact YouTube destination channel before upload or publication.',
        'Reconnect YouTube and explicitly confirm the exact destination channel.',
        { credentialConfigured: Boolean(secret.youtubeRefreshToken), bindingPresent: Boolean(this.binding()) }
      );
    }
    return binding;
  }

  private connectionStatus(pending = this.oauthSessions.snapshot()): YouTubeConnectionStatus {
    const secret = this.secrets.getAll();
    const configured = Boolean(secret.youtubeClientId && secret.youtubeClientSecret);
    const storedBinding = this.binding();
    const confirmedBinding = this.matchingBinding(secret);
    const confirmationRequired = pending?.phase === 'confirmation_required';
    const safeError = this.oauthSessions.safeError();
    const credentialMismatch = Boolean(storedBinding && secret.youtubeRefreshToken && !confirmedBinding);
    const state: YouTubeConnectionStatus['state'] = !configured
      ? 'not_configured'
      : confirmationRequired
        ? 'confirmation_required'
        : confirmedBinding
          ? 'confirmed'
          : 'authorization_required';
    return {
      state,
      configured,
      authorized: Boolean(confirmedBinding),
      channelTitle: confirmedBinding?.channel_title ?? storedBinding?.channel_title ?? null,
      channelId: confirmedBinding?.channel_id ?? storedBinding?.channel_id ?? null,
      confirmedAt: confirmedBinding?.confirmed_at ?? null,
      pendingAuthorization: pending ? {
        ...pending,
        replacement: Boolean(
          pending.channelId && storedBinding && pending.channelId !== storedBinding.channel_id
        ),
        previousChannelTitle: storedBinding?.channel_title ?? null,
        previousChannelId: storedBinding?.channel_id ?? null
      } : null,
      error: safeError ?? (credentialMismatch ? {
        code: 'YOUTUBE_CREDENTIAL_MISMATCH',
        message: formatSecurityError(
          'YOUTUBE_CREDENTIAL_MISMATCH',
          'Stored YouTube credentials no longer match the confirmed channel.',
          'Reconnect YouTube and explicitly confirm the exact destination channel.'
        ),
        recovery: 'Reconnect YouTube and explicitly confirm the exact destination channel.'
      } : null)
    };
  }

  uploadReadiness(): {
    ready: boolean;
    code: 'YOUTUBE_AUTH_REQUIRED' | 'YOUTUBE_AUTH_EXPIRED' | 'YOUTUBE_QUOTA_EXHAUSTED';
    title: string;
    message: string;
  } {
    const secret = this.secrets.getAll();
    if (!secret.youtubeClientId || !secret.youtubeClientSecret || !this.matchingBinding(secret)) {
      return {
        ready: false,
        code: 'YOUTUBE_AUTH_REQUIRED',
        title: 'YouTube connection is required',
        message: 'Configure Google OAuth and confirm the exact destination channel before automatic private upload.'
      };
    }
    const health = this.db.raw.prepare(`
      SELECT status, message FROM provider_health
      WHERE provider IN ('youtube','google') AND status IN ('auth_invalid','quota_exhausted')
      ORDER BY checked_at DESC LIMIT 1
    `).get() as { status: string; message: string | null } | undefined;
    if (health) {
      const quotaExhausted = health.status === 'quota_exhausted';
      return {
        ready: false,
        code: quotaExhausted ? 'YOUTUBE_QUOTA_EXHAUSTED' : 'YOUTUBE_AUTH_EXPIRED',
        title: quotaExhausted ? 'YouTube quota exhausted' : 'YouTube authorization expired',
        message: health.message ?? (
          quotaExhausted
            ? 'Wait for YouTube quota to reset before automatic private upload.'
            : 'Reconnect YouTube before automatic private upload.'
        )
      };
    }
    return {
      ready: true,
      code: 'YOUTUBE_AUTH_EXPIRED',
      title: 'YouTube is ready',
      message: 'YouTube is configured for private upload.'
    };
  }

  private recordYouTubeHealthy(): void {
    this.providerPolicy?.recordHealth('youtube', 'healthy', 200, null);
  }

  private recordYouTubeFailure(error: unknown): void {
    const failure = classifyYouTubeProviderHealthFailure(error);
    if (!failure) return;
    this.providerPolicy?.recordHealth(
      'youtube',
      failure.status,
      failure.statusCode,
      failure.message
    );
  }

  private async client() {
    const secret = this.secrets.getAll();
    if (!secret.youtubeClientId || !secret.youtubeClientSecret) {
      this.rejectPublication(
        'YOUTUBE_OAUTH_CLIENT_CONFIG_MISSING',
        'upload.oauth_configuration',
        'YouTube OAuth client configuration is missing.',
        'Save the Google OAuth desktop client ID and secret, then reconnect YouTube.'
      );
    }
    this.requireConfirmedBinding(secret);
    const client = this.apiRuntime.createOAuthClient(secret.youtubeClientId, secret.youtubeClientSecret);
    if (secret.youtubeRefreshToken || secret.youtubeAccessToken) {
      client.setCredentials({
        refresh_token: secret.youtubeRefreshToken,
        access_token: secret.youtubeAccessToken,
        expiry_date: secret.youtubeTokenExpiry
      });
    }
    (client as any).on('tokens', (tokens: Auth.Credentials) => {
      this.secrets.update({
        youtubeAccessToken: tokens.access_token ?? undefined,
        youtubeRefreshToken: tokens.refresh_token ?? secret.youtubeRefreshToken,
        youtubeTokenExpiry: tokens.expiry_date ?? undefined
      });
    });
    return client;
  }

  async status(): Promise<YouTubeConnectionStatus> {
    const secret = this.secrets.getAll();
    const configured = Boolean(secret.youtubeClientId && secret.youtubeClientSecret);
    const hasStoredAuthorization = Boolean(secret.youtubeRefreshToken);
    if (configured && hasStoredAuthorization && !this.matchingBinding(secret)
      && !this.oauthSessions.snapshot() && !this.legacyInspectionAttempted) {
      this.legacyInspectionAttempted = true;
      try {
        await this.oauthSessions.stageStored({
          clientId: secret.youtubeClientId as string,
          clientSecret: secret.youtubeClientSecret as string,
          credentials: this.credentials(secret)
        });
      } catch {
        // The session manager exposes only a stable, secret-free recovery error.
      }
    }
    return this.connectionStatus();
  }

  async beginAuthorization(): Promise<YouTubeConnectionStatus> {
    const secret = this.secrets.getAll();
    if (!secret.youtubeClientId || !secret.youtubeClientSecret) {
      this.rejectOAuth(
        'OAUTH_CLIENT_CONFIG_MISSING',
        'session.configuration_check',
        'A Google OAuth desktop client ID and secret are required.',
        'Save the Google OAuth desktop client ID and secret in Settings, then reconnect.'
      );
    }
    this.legacyInspectionAttempted = true;
    const pending = await this.oauthSessions.begin({
      clientId: secret.youtubeClientId,
      clientSecret: secret.youtubeClientSecret
    });
    return this.connectionStatus(pending);
  }

  async confirmAuthorization(request: YouTubeAuthorizationConfirmation): Promise<YouTubeConnectionStatus> {
    const pending = this.oauthSessions.snapshot();
    const existingBinding = this.binding();
    const replacement = Boolean(
      existingBinding && pending?.channelId && pending.channelId !== existingBinding.channel_id
    );
    if (replacement && !request.replaceExisting) {
      if (pending) {
        const source = await this.oauthSessions.cancel(pending.pendingAuthorizationId);
        if (source === 'stored') this.secrets.replaceYouTubeCredentials(null);
      }
      this.rejectOAuth(
        'OAUTH_REPLACEMENT_CONFIRMATION_REQUIRED',
        'confirmation.replacement_check',
        'Replacing the confirmed YouTube channel requires explicit replacement confirmation.',
        'Start the connection again and explicitly confirm replacement of the current channel.',
        { existingBindingPresent: true, candidateChannelPresent: Boolean(pending?.channelId) }
      );
    }

    const previousSecrets = this.secrets.getAll();
    await this.oauthSessions.confirm(
      request.pendingAuthorizationId,
      request.expectedChannelId,
      async candidate => {
        const refreshToken = candidate.credentials.refreshToken;
        if (!refreshToken) {
          this.rejectOAuth(
            'OAUTH_REFRESH_CREDENTIAL_MISSING',
            'confirmation.credential_check',
            'YouTube authorization did not provide a durable refresh credential.',
            'Reconnect YouTube and grant durable offline account access.'
          );
        }
        if (!previousSecrets.youtubeClientId || candidate.clientId !== previousSecrets.youtubeClientId) {
          this.rejectOAuth(
            'OAUTH_CLIENT_CONFIG_CHANGED',
            'confirmation.client_check',
            'The OAuth client configuration changed during authorization.',
            'Review the saved OAuth client configuration and start the connection again.'
          );
        }
        let secretsReplaced = false;
        try {
          if (candidate.source === 'authorization') {
            this.secrets.replaceYouTubeCredentials({
              youtubeRefreshToken: refreshToken,
              youtubeAccessToken: candidate.credentials.accessToken,
              youtubeTokenExpiry: candidate.credentials.expiryDate
            });
            secretsReplaced = true;
          }
          const confirmedAt = new Date().toISOString();
          this.db.raw.transaction(() => {
            this.db.raw.prepare(`
              INSERT INTO youtube_connection_binding(
                singleton_id, channel_id, channel_title, credential_fingerprint, confirmed_at
              ) VALUES(1, ?, ?, ?, ?)
              ON CONFLICT(singleton_id) DO UPDATE SET
                channel_id = excluded.channel_id,
                channel_title = excluded.channel_title,
                credential_fingerprint = excluded.credential_fingerprint,
                confirmed_at = excluded.confirmed_at
            `).run(
              candidate.channelId,
              candidate.channelTitle,
              youtubeCredentialFingerprint(candidate.clientId, refreshToken),
              confirmedAt
            );
            const staleProjects = this.db.raw.prepare(`
              SELECT DISTINCT project_id FROM publication_records
              WHERE snapshot_status = 'current' AND channel_id IS NOT ?
            `).all(candidate.channelId) as Array<{ project_id: string }>;
            for (const publication of staleProjects) {
              invalidatePublicationSnapshots(
                this.db,
                publication.project_id,
                'The confirmed YouTube channel changed. The prior private upload snapshot is stale.',
                'youtube_channel_changed',
                confirmedAt
              );
            }
            this.db.raw.prepare(`
              INSERT INTO audit_log(action, actor, entity_type, entity_id, metadata_json, created_at)
              VALUES('youtube.channel_confirmed', 'human', 'youtube_channel', ?, ?, ?)
            `).run(candidate.channelId, JSON.stringify({
              channelId: candidate.channelId,
              channelTitle: candidate.channelTitle,
              replacedChannelId: replacement ? existingBinding?.channel_id ?? null : null
            }), confirmedAt);
            this.db.raw.prepare(`
              DELETE FROM provider_health WHERE provider IN ('youtube','google')
            `).run();
          })();
        } catch (error) {
          if (secretsReplaced) {
            this.secrets.replaceYouTubeCredentials({
              youtubeRefreshToken: previousSecrets.youtubeRefreshToken,
              youtubeAccessToken: previousSecrets.youtubeAccessToken,
              youtubeTokenExpiry: previousSecrets.youtubeTokenExpiry
            });
          }
          throw error;
        }
      }
    );
    return this.connectionStatus();
  }

  async cancelAuthorization(pendingAuthorizationId: string): Promise<YouTubeConnectionStatus> {
    const source = await this.oauthSessions.cancel(pendingAuthorizationId);
    if (source === 'stored') this.secrets.replaceYouTubeCredentials(null);
    return this.connectionStatus();
  }

  async shutdown(): Promise<void> {
    await this.oauthSessions.shutdown();
  }

  private rejectOAuth(
    code: string,
    operation: string,
    message: string,
    recovery: string,
    context: Record<string, unknown> = {}
  ): never {
    return rejectPrivilegedOperation(this.db, {
      flow: 'oauth',
      operation,
      code,
      recovery,
      entityType: 'youtube_oauth',
      entityId: 'youtube',
      actor: 'human',
      context
    }, message);
  }

  private rejectPublication(
    code: string,
    operation: string,
    message: string,
    recovery: string,
    context: Record<string, unknown> = {},
    entityId = 'youtube'
  ): never {
    return rejectPrivilegedOperation(this.db, {
      flow: 'publication',
      operation,
      code,
      recovery,
      entityType: 'publication',
      entityId,
      context
    }, message);
  }

  async uploadPrivate(
    projectId: string,
    expectedSnapshot?: PublicationSnapshot
  ): Promise<{ videoId: string; url: string }> {
    const readiness = this.uploadReadiness();
    if (!readiness.ready) throw new Error(readiness.message);
    try {
      const result = await this.uploadPrivateReady(projectId, expectedSnapshot);
      this.recordYouTubeHealthy();
      return result;
    } catch (error) {
      this.recordYouTubeFailure(error);
      throw error;
    }
  }

  private async uploadPrivateReady(
    projectId: string,
    expectedSnapshot?: PublicationSnapshot
  ): Promise<{ videoId: string; url: string }> {
    const project = this.projects.get(projectId);
    if (!['QC_FINAL', 'WAITING_FINAL_APPROVAL', 'WAITING_YOUTUBE_PROCESSING', 'UPLOADING_PRIVATE'].includes(project.state)) {
      this.rejectPublication(
        'PUBLICATION_UPLOAD_STATE_INVALID',
        'upload.project_state',
        `Private upload is not allowed from project state ${project.state}.`,
        'Refresh the project and complete the required workflow stages before uploading.',
        { projectState: project.state },
        projectId
      );
    }
    const binding = this.requireConfirmedBinding();
    const snapshot = expectedSnapshot ?? this.publications.capture(projectId, binding.channel_id);
    if (snapshot.projectId !== projectId || snapshot.confirmedChannelId !== binding.channel_id) {
      this.rejectPublication(
        'PUBLICATION_SNAPSHOT_OWNER_MISMATCH',
        'upload.snapshot_identity',
        'The durable upload snapshot does not match the project and confirmed YouTube channel.',
        'Capture a new upload snapshot from the current project and confirmed channel.',
        {
          projectMatched: snapshot.projectId === projectId,
          channelMatched: snapshot.confirmedChannelId === binding.channel_id
        },
        projectId
      );
    }
    this.publications.markSuperseded(snapshot);

    const existing = this.db.raw.prepare(`
      SELECT id, project_id, video_id, upload_session_uri, caption_id, thumbnail_uploaded,
        channel_id, final_render_id, final_sha256, selected_package_id, approval_hash,
        snapshot_version, snapshot_status
      FROM publication_records
      WHERE project_id = ? AND channel_id = ? AND final_render_id = ? AND final_sha256 = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(
      projectId,
      binding.channel_id,
      snapshot.finalRenderId,
      snapshot.finalSha256
    ) as UploadRow | undefined;

    const publicationId = existing?.id ?? randomUUID();
    const reusableSession = Boolean(
      existing
      && existing.snapshot_status === 'current'
      && existing.snapshot_version === snapshot.snapshotVersion
      && existing.selected_package_id === snapshot.selectedPackageId
      && existing.approval_hash === snapshot.approvalHash
    );
    const preparedAt = new Date().toISOString();
    if (existing) {
      this.db.raw.prepare(`
        UPDATE publication_records SET snapshot_version = ?, snapshot_status = 'current',
          selected_package_id = ?, approval_hash = ?, approved_at = NULL,
          scheduled_at = NULL, published_at = NULL, privacy_status = 'private',
          upload_session_uri = CASE WHEN ? THEN upload_session_uri ELSE NULL END,
          caption_id = CASE WHEN video_id IS NOT NULL THEN caption_id ELSE NULL END,
          thumbnail_uploaded = CASE WHEN video_id IS NOT NULL THEN thumbnail_uploaded ELSE 0 END,
          processing_status = CASE WHEN video_id IS NOT NULL THEN processing_status ELSE 'initializing' END,
          error = NULL, updated_at = ? WHERE id = ?
      `).run(
        snapshot.snapshotVersion,
        snapshot.selectedPackageId,
        snapshot.approvalHash,
        Number(reusableSession),
        preparedAt,
        publicationId
      );
      existing.selected_package_id = snapshot.selectedPackageId;
      existing.approval_hash = snapshot.approvalHash;
      existing.snapshot_version = snapshot.snapshotVersion;
      existing.snapshot_status = 'current';
    } else {
      this.db.raw.prepare(`
        INSERT INTO publication_records(
          id, project_id, channel_id, video_id, privacy_status, final_render_id,
          final_sha256, snapshot_version, snapshot_status, processing_status,
          selected_package_id, thumbnail_uploaded, approval_hash, synthetic_media,
          created_at, updated_at
        ) VALUES(?, ?, ?, NULL, 'private', ?, ?, ?, 'current', 'initializing', ?, 0, ?, ?, ?, ?)
      `).run(
        publicationId,
        projectId,
        binding.channel_id,
        snapshot.finalRenderId,
        snapshot.finalSha256,
        snapshot.snapshotVersion,
        snapshot.selectedPackageId,
        snapshot.approvalHash,
        Number(this.settings().youtubeSyntheticMediaDisclosure),
        preparedAt,
        preparedAt
      );
    }
    this.publications.assertCurrent(snapshot, publicationId, 'job_start');

    if (existing?.video_id && project.state === 'WAITING_FINAL_APPROVAL') {
      this.projects.states.transition(projectId, 'UPLOADING_PRIVATE', {
        progress: 0.93,
        reason: 'Synchronizing changed metadata and thumbnail to the existing private upload',
        prerequisites: { videoId: existing.video_id, packageId: snapshot.selectedPackageId }
      });
    } else if (!existing?.video_id) {
      this.projects.states.transition(projectId, 'UPLOADING_PRIVATE', {
        progress: 0.93,
        reason: 'Operator or policy initiated private-first YouTube upload',
        prerequisites: {
          finalRenderId: snapshot.finalRenderId,
          finalSha256: snapshot.finalSha256,
          packageId: snapshot.selectedPackageId
        }
      });
    }

    const auth = await this.client();
    const youtube = this.apiRuntime.createYouTubeClient(auth);
    if (existing?.video_id) {
      this.publications.assertCurrent(snapshot, publicationId, 'metadata');
      await youtube.videos.update({
        part: ['snippet', 'status'],
        requestBody: {
          id: existing.video_id,
          snippet: {
            title: snapshot.title,
            description: snapshot.description,
            tags: snapshot.tags,
            categoryId: this.settings().youtubeCategoryId,
            defaultLanguage: 'en'
          },
          status: privateVideoStatus(this.settings().youtubeSyntheticMediaDisclosure)
        }
      });
      this.publications.assertCurrent(snapshot, publicationId, 'thumbnail');
      await youtube.thumbnails.set({
        videoId: existing.video_id,
        media: { mimeType: 'image/jpeg', body: createReadStream(snapshot.thumbnailPath) }
      });
      this.publications.assertCurrent(snapshot, publicationId, 'caption');
      const captionId = await this.ensureCaption(
        youtube,
        existing.video_id,
        snapshot.finalManifestPath,
        existing.caption_id,
        () => this.publications.assertCurrent(snapshot, publicationId, 'caption')
      );
      this.publications.assertCurrent(snapshot, publicationId, 'playlist');
      await this.ensurePlaylist(
        youtube,
        existing.video_id,
        () => this.publications.assertCurrent(snapshot, publicationId, 'playlist')
      );
      this.publications.assertCurrent(snapshot, publicationId, 'processing');
      this.db.raw.prepare(`
        UPDATE publication_records SET selected_package_id = ?, approval_hash = ?,
          caption_id = ?, thumbnail_uploaded = ?, processing_status = 'uploaded',
          error = NULL, updated_at = ? WHERE id = ?
      `).run(
        snapshot.selectedPackageId, snapshot.approvalHash, captionId, 1,
        new Date().toISOString(), existing.id
      );
      this.projects.states.transition(projectId, 'WAITING_YOUTUBE_PROCESSING', {
        progress: 0.95,
        youtubeVideoId: existing.video_id,
        reason: 'Private upload package synchronized; processing state will be rechecked',
        prerequisites: { videoId: existing.video_id }
      });
      await this.waitForProcessing(youtube, projectId, existing.video_id, existing.id, snapshot);
      this.publications.assertCurrent(snapshot, publicationId, 'approval');
      this.projects.states.transition(projectId, 'WAITING_FINAL_APPROVAL', {
        progress: 0.96,
        reason: 'Changed private package is synchronized and ready for approval',
        prerequisites: { videoId: existing.video_id, approvalHash: snapshot.approvalHash }
      });
      this.publications.resolveStaleException(projectId, publicationId);
      return { videoId: existing.video_id, url: `https://www.youtube.com/watch?v=${existing.video_id}` };
    }
    const videoId = await this.uploadResumable(
      auth,
      publicationId,
      snapshot.finalOutputPath,
      reusableSession ? existing?.upload_session_uri ?? null : null,
      {
        snippet: {
          title: snapshot.title,
          description: snapshot.description,
          tags: snapshot.tags,
          categoryId: this.settings().youtubeCategoryId,
          defaultLanguage: 'en'
        },
        status: privateVideoStatus(this.settings().youtubeSyntheticMediaDisclosure)
      },
      projectId,
      snapshot
    );
    if (!videoId) throw new Error('YouTube upload completed without a video ID.');

    const uploadedAt = new Date().toISOString();
    this.db.raw.prepare(`
      UPDATE publication_records SET video_id = ?, privacy_status = 'private', processing_status = 'uploaded',
        error = NULL, updated_at = ? WHERE id = ?
    `).run(videoId, uploadedAt, publicationId);
    this.publications.assertCurrent(snapshot, publicationId, 'thumbnail');
    this.projects.states.transition(projectId, 'WAITING_YOUTUBE_PROCESSING', {
      progress: 0.95,
      youtubeVideoId: videoId,
      reason: 'Resumable private upload completed; attachments and processing will be confirmed',
      prerequisites: {
        videoId,
        finalRenderId: snapshot.finalRenderId,
        finalSha256: snapshot.finalSha256
      }
    });

    await youtube.thumbnails.set({
      videoId,
      media: {
        mimeType: 'image/jpeg',
        body: createReadStream(snapshot.thumbnailPath)
      }
    });

    this.publications.assertCurrent(snapshot, publicationId, 'caption');
    const captionId = await this.ensureCaption(
      youtube,
      videoId,
      snapshot.finalManifestPath,
      null,
      () => this.publications.assertCurrent(snapshot, publicationId, 'caption')
    );
    this.publications.assertCurrent(snapshot, publicationId, 'playlist');
    await this.ensurePlaylist(
      youtube,
      videoId,
      () => this.publications.assertCurrent(snapshot, publicationId, 'playlist')
    );
    this.publications.assertCurrent(snapshot, publicationId, 'processing');

    const now = new Date().toISOString();
    this.db.raw.prepare(`
      UPDATE publication_records SET channel_id = ?, video_id = ?, privacy_status = 'private',
        processing_status = 'uploaded', selected_package_id = ?, caption_id = ?,
        thumbnail_uploaded = ?, approval_hash = ?, error = NULL, updated_at = ?
      WHERE id = ?
    `).run(
      binding.channel_id,
      videoId,
      snapshot.selectedPackageId,
      captionId,
      1,
      snapshot.approvalHash,
      now,
      publicationId
    );
    await this.waitForProcessing(youtube, projectId, videoId, publicationId, snapshot);
    this.publications.assertCurrent(snapshot, publicationId, 'approval');
    this.projects.states.transition(projectId, 'WAITING_FINAL_APPROVAL', {
      progress: 0.96,
      reason: 'YouTube reports a processed private video ready for operator review',
      prerequisites: { videoId }
    });
    this.publications.resolveStaleException(projectId, publicationId);
    return { videoId, url: `https://www.youtube.com/watch?v=${videoId}` };
  }

  private async uploadResumable(
    auth: Auth.OAuth2Client,
    publicationId: string,
    outputPath: string,
    storedSession: string | null,
    metadata: Record<string, unknown>,
    projectId: string,
    snapshot: PublicationSnapshot
  ): Promise<string> {
    const size = statSync(outputPath).size;
    if (size <= 0) throw new Error('The final render is empty.');
    let session = storedSession ? validateUploadSession(storedSession) : null;
    let offset = 0;

    if (session) {
      try {
        this.publications.assertCurrent(snapshot, publicationId, 'upload_resume');
        const status = await auth.request<ResumableVideoResponse>({
          url: session,
          method: 'PUT',
          headers: { 'Content-Length': '0', 'Content-Range': `bytes */${size}` },
          validateStatus: code => code === 200 || code === 201 || code === 308,
          retry: false
        });
        if (status.status === 200 || status.status === 201) {
          if (!status.data.id) throw new Error('Completed upload session did not return a YouTube video ID.');
          return status.data.id;
        }
        offset = parseCommittedRange(responseHeader(status.headers, 'range'));
      } catch (error) {
        const status = (error as { response?: { status?: number } }).response?.status;
        if (status === 404 || status === 410) {
          session = null;
          offset = 0;
        } else {
          throw error;
        }
      }
    }

    if (!session) {
      this.publications.assertCurrent(snapshot, publicationId, 'upload_create');
      const initiated = await auth.request<unknown>({
        url: 'https://www.googleapis.com/upload/youtube/v3/videos',
        method: 'POST',
        params: { uploadType: 'resumable', part: 'snippet,status' },
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': 'video/mp4',
          'X-Upload-Content-Length': String(size)
        },
        data: metadata,
        retry: false
      });
      const location = responseHeader(initiated.headers, 'location');
      if (!location) throw new Error('YouTube did not return a resumable upload session URL.');
      session = validateUploadSession(location);
      this.db.raw.prepare(`
        UPDATE publication_records SET upload_session_uri = ?, processing_status = 'uploading',
          error = NULL, updated_at = ? WHERE id = ?
      `).run(session, new Date().toISOString(), publicationId);
      this.publications.assertCurrent(snapshot, publicationId, 'upload_create');
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        this.publications.assertCurrent(snapshot, publicationId, 'upload_chunk');
        const result = await auth.request<ResumableVideoResponse>({
          url: session,
          method: 'PUT',
          headers: {
            'Content-Type': 'video/mp4',
            'Content-Length': String(size - offset),
            'Content-Range': resumableContentRange(offset, size)
          },
          data: createReadStream(outputPath, { start: offset }),
          validateStatus: code => code === 200 || code === 201 || code === 308,
          retry: false
        });
        if (result.status === 200 || result.status === 201) {
          if (!result.data.id) throw new Error('YouTube resumable upload completed without a video ID.');
          return result.data.id;
        }
        offset = parseCommittedRange(responseHeader(result.headers, 'range'));
        this.progress(projectId, offset / size, `Uploading private video: ${Math.round(offset / size * 100)}%`);
      } catch (error) {
        this.db.raw.prepare(`
          UPDATE publication_records SET error = ?, updated_at = ? WHERE id = ?
        `).run(error instanceof Error ? error.message : String(error), new Date().toISOString(), publicationId);
        if (!isTransientUploadError(error) || attempt === 4) throw error;
        await retryDelay(attempt);
        this.publications.assertCurrent(snapshot, publicationId, 'upload_resume');
        const status = await auth.request<ResumableVideoResponse>({
          url: session,
          method: 'PUT',
          headers: { 'Content-Length': '0', 'Content-Range': `bytes */${size}` },
          validateStatus: code => code === 200 || code === 201 || code === 308,
          retry: false
        });
        if (status.status === 200 || status.status === 201) {
          if (!status.data.id) throw new Error('Completed upload session did not return a YouTube video ID.');
          return status.data.id;
        }
        offset = parseCommittedRange(responseHeader(status.headers, 'range'));
      }
    }
    throw new Error('YouTube resumable upload exhausted its retry policy.');
  }

  private async ensureCaption(
    youtube: youtube_v3.Youtube,
    videoId: string,
    manifestPath: string | null,
    existingCaptionId: string | null,
    revalidate: () => void
  ): Promise<string | null> {
    if (existingCaptionId) return existingCaptionId;
    const captions = await youtube.captions.list({ part: ['id', 'snippet'], videoId });
    const reusableId = reusableEnglishCaptionId(captions.data.items, videoId);
    if (reusableId) return reusableId;
    if (!manifestPath || !existsSync(manifestPath)) throw new Error('Render manifest is missing for caption upload.');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { captions?: { srtPath?: string } };
    const srt = manifest.captions?.srtPath;
    if (!srt || !existsSync(srt)) throw new Error('Timed SRT caption track is missing.');
    revalidate();
    const caption = await youtube.captions.insert({
      part: ['snippet'],
      requestBody: {
        snippet: { videoId, language: 'en', name: 'English', isDraft: false }
      },
      media: { mimeType: 'application/octet-stream', body: createReadStream(srt) }
    });
    return caption.data.id ?? null;
  }

  private async ensurePlaylist(
    youtube: youtube_v3.Youtube,
    videoId: string,
    revalidate: () => void
  ): Promise<void> {
    const playlistId = this.settings().youtubePlaylistId.trim();
    if (!playlistId) return;
    const existing = await youtube.playlistItems.list({
      part: ['id'], playlistId, videoId, maxResults: 1
    });
    if (existing.data.items?.length) return;
    revalidate();
    await youtube.playlistItems.insert({
      part: ['snippet'],
      requestBody: {
        snippet: {
          playlistId,
          resourceId: { kind: 'youtube#video', videoId }
        }
      }
    });
  }

  private async waitForProcessing(
    youtube: youtube_v3.Youtube,
    projectId: string,
    videoId: string,
    publicationId: string,
    snapshot: PublicationSnapshot
  ): Promise<void> {
    try {
      await awaitUsableYouTubeProcessing({
        readStatus: async () => {
          this.publications.assertCurrent(snapshot, publicationId, 'processing');
          const result = await youtube.videos.list({ part: ['processingDetails', 'status'], id: [videoId] });
          this.publications.assertCurrent(snapshot, publicationId, 'processing');
          return result.data.items?.[0]?.processingDetails?.processingStatus;
        },
        onProgress: (attempt, status) => {
          this.progress(projectId, attempt / 20, `Waiting for YouTube processing (${status ?? 'pending'})`);
        }
      });
      this.db.raw.prepare(`
        UPDATE publication_records SET processing_status = 'succeeded', error = NULL,
          updated_at = ? WHERE id = ?
      `).run(new Date().toISOString(), publicationId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const terminal = /processing (failed|terminated)/i.exec(message)?.[1]?.toLowerCase();
      if (terminal) {
        this.db.raw.prepare(`
          UPDATE publication_records SET processing_status = ?, error = ?, updated_at = ? WHERE id = ?
        `).run(terminal, message, new Date().toISOString(), publicationId);
      }
      if (/configured polling window/i.test(message)) {
        throw new Error('YouTube processing did not finish within five minutes. Retry will not create a duplicate upload.');
      }
      throw error;
    }
  }

  private async resetRemotePrivateAfterStale(
    auth: Auth.OAuth2Client,
    videoId: string,
    publicationId: string,
    action: 'publish' | 'schedule'
  ): Promise<void> {
    try {
      await this.updatePublicationStatus(
        auth,
        videoId,
        privateVideoStatus(this.settings().youtubeSyntheticMediaDisclosure)
      );
      this.recordYouTubeHealthy();
    } catch (resetError) {
      this.recordYouTubeFailure(resetError);
      const resetMessage = redactSecrets(
        resetError instanceof Error ? resetError.message : String(resetError)
      ).slice(0, 1_000);
      this.db.raw.prepare(`
        UPDATE publication_records SET error = ?, updated_at = ? WHERE id = ?
      `).run(
        `Publication snapshot changed during ${action}; automatic private reset failed: ${resetMessage}`,
        new Date().toISOString(),
        publicationId
      );
      throw new StalePublicationSnapshotError(
        'publish',
        `The publication snapshot changed during ${action}, and YouTube private reset failed: ${resetMessage}`
      );
    }
  }

  async approve(
    projectId: string,
    action: 'keep_private' | 'publish' | 'schedule',
    scheduledAt?: string
  ): Promise<PublicationApprovalResult> {
    const project = this.projects.get(projectId);
    if (project.state !== 'WAITING_FINAL_APPROVAL') {
      this.rejectPublication(
        'PUBLICATION_APPROVAL_STATE_INVALID',
        'approval.project_state',
        `Publication approval is not allowed from project state ${project.state}.`,
        'Refresh the project and complete private upload processing before approval.',
        { projectState: project.state, requestedAction: action },
        projectId
      );
    }
    if (!project.youtubeVideoId) {
      this.rejectPublication(
        'PUBLICATION_VIDEO_MISSING',
        'approval.video_check',
        'Project has not been uploaded to YouTube.',
        'Complete a private YouTube upload and processing checks before approval.',
        { requestedAction: action },
        projectId
      );
    }
    const binding = this.requireConfirmedBinding();
    const publication = this.db.raw.prepare(`
      SELECT id, approval_hash, processing_status, caption_id, thumbnail_uploaded, channel_id,
        final_render_id, final_sha256, selected_package_id, snapshot_version, snapshot_status
      FROM publication_records WHERE project_id = ? AND video_id = ?
    `).get(projectId, project.youtubeVideoId) as {
      id: string;
      approval_hash: string | null;
      processing_status: string | null;
      caption_id: string | null;
      thumbnail_uploaded: number;
      channel_id: string | null;
      final_render_id: string | null;
      final_sha256: string;
      selected_package_id: string | null;
      snapshot_version: number;
      snapshot_status: string;
    } | undefined;
    if (!publication) {
      this.rejectPublication(
        'PUBLICATION_RECEIPT_MISSING',
        'approval.receipt_check',
        'The private publication receipt is missing.',
        'Keep the remote video private and create a new verified upload receipt.',
        { requestedAction: action },
        projectId
      );
    }
    let snapshot: PublicationSnapshot;
    try {
      snapshot = this.publications.capture(projectId, binding.channel_id);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.publications.markStale(
        projectId,
        publication.id,
        'approval',
        `${reason} The stale YouTube upload remains private and cannot be approved.`
      );
      throw new StalePublicationSnapshotError('approval', reason);
    }
    this.publications.assertCurrent(snapshot, publication.id, 'approval');
    const currentApprovalHash = snapshot.approvalHash;
    if (publication.processing_status !== 'succeeded' || !publication.caption_id || !publication.thumbnail_uploaded) {
      this.rejectPublication(
        'PUBLICATION_PREREQUISITES_INCOMPLETE',
        'approval.prerequisite_check',
        'YouTube processing, thumbnail, and timed captions must all succeed before approval.',
        'Wait for processing and complete the thumbnail and timed-caption steps before approval.',
        {
          processingStatus: publication.processing_status,
          captionPresent: Boolean(publication.caption_id),
          thumbnailUploaded: Boolean(publication.thumbnail_uploaded),
          requestedAction: action
        },
        publication.id
      );
    }
    if (publication.channel_id !== binding.channel_id) {
      this.rejectPublication(
        'PUBLICATION_CHANNEL_MISMATCH',
        'approval.channel_check',
        'The YouTube publication destination does not match the confirmed channel.',
        'Keep the upload private, reconnect YouTube, and confirm the exact destination channel.',
        { requestedAction: action },
        publication.id
      );
    }

    if (action === 'keep_private') {
      const now = new Date().toISOString();
      this.db.raw.transaction(() => {
        this.db.raw.prepare(`
          UPDATE publication_records SET privacy_status = 'private', approved_at = ?,
            approval_hash = ?, scheduled_at = NULL, published_at = NULL, updated_at = ?
          WHERE id = ?
        `).run(now, currentApprovalHash, now, publication.id);
        this.db.raw.prepare(`
          INSERT INTO audit_log(
            project_id, action, actor, entity_type, entity_id, metadata_json, created_at
          ) VALUES(?, 'youtube.keep_private', 'human', 'publication', ?, ?, ?)
        `).run(projectId, project.youtubeVideoId, JSON.stringify({ approvalHash: currentApprovalHash }), now);
      })();
      return { outcome: 'kept_private' };
    }

    if (action === 'schedule' && (!scheduledAt || !Number.isFinite(new Date(scheduledAt).getTime())
      || new Date(scheduledAt).getTime() <= Date.now())) {
      this.rejectPublication(
        'PUBLICATION_SCHEDULE_INVALID',
        'approval.schedule_validation',
        'A valid future schedule time is required.',
        'Choose a valid future time and submit the schedule approval again.',
        { scheduleProvided: Boolean(scheduledAt), requestedAction: action },
        publication.id
      );
    }

    const readiness = this.uploadReadiness();
    if (!readiness.ready) throw new Error(readiness.message);
    const auth = await this.client();
    const status: youtube_v3.Schema$VideoStatus = action === 'publish'
      ? { privacyStatus: 'public' }
      : {
          privacyStatus: 'private',
          publishAt: scheduledAt
        };
    try {
      this.publications.assertCurrent(snapshot, publication.id, 'publish');
      const responseStatus = await this.updatePublicationStatus(auth, project.youtubeVideoId, status);
      this.recordYouTubeHealthy();
      try {
        this.publications.assertCurrent(snapshot, publication.id, 'publish');
      } catch (error) {
        if (!(error instanceof StalePublicationSnapshotError)) throw error;
        await this.resetRemotePrivateAfterStale(auth, project.youtubeVideoId, publication.id, action);
        throw error;
      }
      const retainedPrivate = action === 'publish'
        && responseStatus?.privacyStatus !== undefined
        && responseStatus.privacyStatus !== 'public';
      const rejectedSchedule = action === 'schedule'
        && responseStatus !== null
        && (responseStatus.privacyStatus !== 'private'
          || (responseStatus.publishAt !== undefined && responseStatus.publishAt !== scheduledAt));
      if (retainedPrivate || rejectedSchedule) {
        const mismatch = new Error('YouTube retained private status because API publication is restricted; complete the approved action in Studio.');
        (mismatch as Error & { status: number }).status = 403;
        throw mismatch;
      }
    } catch (error) {
      if (error instanceof StalePublicationSnapshotError) throw error;
      try {
        this.publications.assertCurrent(snapshot, publication.id, 'publish');
      } catch (snapshotError) {
        if (!(snapshotError instanceof StalePublicationSnapshotError)) throw snapshotError;
        await this.resetRemotePrivateAfterStale(auth, project.youtubeVideoId, publication.id, action);
        throw snapshotError;
      }
      if (!isYouTubeStudioRestriction(error)) {
        this.recordYouTubeFailure(error);
        throw error;
      }
      this.recordYouTubeHealthy();
      return this.routeToStudio(
        projectId,
        publication.id,
        project.youtubeVideoId,
        action,
        scheduledAt,
        currentApprovalHash,
        snapshot,
        error
      );
    }
    const now = new Date().toISOString();
    this.db.raw.prepare(`
      UPDATE publication_records SET privacy_status = ?, approved_at = ?, approval_hash = ?,
        scheduled_at = ?, published_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      action === 'publish' ? 'public' : 'private',
      now,
      currentApprovalHash,
      action === 'schedule' ? scheduledAt : null,
      action === 'publish' ? now : null,
      now,
      publication.id
    );
    this.projects.states.transition(projectId, action === 'schedule' ? 'SCHEDULED' : 'PUBLISHED', {
      progress: 1,
      publishedAt: action === 'publish' ? now : null,
      reason: action === 'schedule' ? 'Operator approved future publication schedule' : 'Operator approved public publication',
      prerequisites: { videoId: project.youtubeVideoId, scheduledAt: action === 'schedule' ? scheduledAt : null }
    });
    return { outcome: action === 'schedule' ? 'scheduled' : 'published' };
  }

  private async routeToStudio(
    projectId: string,
    publicationId: string,
    videoId: string,
    action: 'publish' | 'schedule',
    scheduledAt: string | undefined,
    approvalHash: string,
    snapshot: PublicationSnapshot,
    error: unknown
  ): Promise<PublicationApprovalResult> {
    const url = studioVideoUrl(videoId);
    let opened = false;
    let openError: string | null = null;
    this.publications.assertCurrent(snapshot, publicationId, 'publish');
    try {
      await this.openExternal(url);
      opened = true;
    } catch (cause) {
      openError = cause instanceof Error ? cause.message : String(cause);
    }
    this.publications.assertCurrent(snapshot, publicationId, 'publish');
    const details = googleErrorDetails(error);
    const now = new Date().toISOString();
    this.db.raw.transaction(() => {
      this.db.raw.prepare(`
        UPDATE publication_records SET privacy_status = 'private', approved_at = ?,
          approval_hash = ?, scheduled_at = NULL, published_at = NULL, error = ?, updated_at = ?
        WHERE id = ?
      `).run(
        now,
        approvalHash,
        `API ${action} restriction; manual Studio action required.`,
        now,
        publicationId
      );
      this.db.raw.prepare(`
        INSERT INTO audit_log(
          project_id, action, actor, entity_type, entity_id, metadata_json, created_at
        ) VALUES(?, 'youtube.studio_fallback', 'system', 'publication', ?, ?, ?)
      `).run(projectId, videoId, JSON.stringify({
        requestedAction: action,
        requestedScheduleAt: action === 'schedule' ? scheduledAt ?? null : null,
        studioUrl: url,
        studioOpened: opened,
        openError,
        apiStatus: details.status ?? null,
        apiReasons: details.reasons,
        apiMessage: details.message
      }), now);
    })();
    this.projects.states.transition(projectId, 'AWAITING_MANUAL_STUDIO_ACTION', {
      progress: 0.99,
      reason: 'YouTube API restriction requires the approved action in Studio',
      prerequisites: {
        videoId,
        requestedAction: action,
        scheduledAt: action === 'schedule' ? scheduledAt ?? null : null,
        studioUrl: url,
        studioOpened: opened
      }
    });
    return { outcome: 'studio_fallback', studioUrl: url, requestedAction: action };
  }
}
