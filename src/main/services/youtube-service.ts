import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { shell } from 'electron';
import { google, type Auth, type youtube_v3 } from 'googleapis';
import type { AppDatabase } from '../database/database';
import type { AppSettings, PublicationApprovalResult, YouTubeConnectionStatus } from '@shared/types';
import type { SecretStore } from '../secret-store';
import type { ProjectService } from './project-service';
import { approvalFingerprint } from '@shared/approval';
import {
  parseCommittedRange,
  reusableEnglishCaptionId,
  resumableContentRange
} from '@shared/youtube-resumable';

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
  'https://www.googleapis.com/auth/spreadsheets.readonly'
];

function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

interface UploadRow {
  id: string;
  project_id: string;
  video_id: string | null;
  upload_session_uri: string | null;
  caption_id: string | null;
  thumbnail_uploaded: number;
  channel_id: string | null;
}

export function assertPublicationUploadOwner(
  existing: Pick<UploadRow, 'project_id'> | undefined,
  projectId: string
): void {
  if (existing && existing.project_id !== projectId) {
    throw new Error('This final render hash is already assigned to a different project upload.');
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
  constructor(
    private readonly db: AppDatabase,
    private readonly settings: () => AppSettings,
    private readonly secrets: SecretStore,
    private readonly projects: ProjectService,
    private readonly progress: (projectId: string, progress: number, message: string) => void,
    private readonly updatePublicationStatus: UpdatePublicationStatus = async (auth, videoId, status) => {
      const result = await google.youtube({ version: 'v3', auth }).videos.update({
        part: ['status'],
        requestBody: { id: videoId, status }
      });
      return result.data.status ?? null;
    },
    private readonly openExternal: (url: string) => Promise<unknown> = url => shell.openExternal(url, { activate: true })
  ) {}

  uploadReadiness(): {
    ready: boolean;
    code: 'YOUTUBE_AUTH_REQUIRED' | 'YOUTUBE_AUTH_EXPIRED';
    title: string;
    message: string;
  } {
    const status = this.secrets.status();
    if (!status.youtubeClientConfigured || !status.youtubeAuthorized) {
      return {
        ready: false,
        code: 'YOUTUBE_AUTH_REQUIRED',
        title: 'YouTube connection is required',
        message: 'Configure the Google OAuth desktop client and connect YouTube before automatic private upload.'
      };
    }
    const health = this.db.raw.prepare(`
      SELECT status, message FROM provider_health
      WHERE provider IN ('youtube','google') AND status = 'auth_invalid'
      ORDER BY checked_at DESC LIMIT 1
    `).get() as { status: string; message: string | null } | undefined;
    if (health) {
      return {
        ready: false,
        code: 'YOUTUBE_AUTH_EXPIRED',
        title: 'YouTube authorization expired',
        message: health.message ?? 'Reconnect YouTube before automatic private upload.'
      };
    }
    return {
      ready: true,
      code: 'YOUTUBE_AUTH_EXPIRED',
      title: 'YouTube is ready',
      message: 'YouTube is configured for private upload.'
    };
  }

  private async client() {
    const secret = this.secrets.getAll();
    if (!secret.youtubeClientId || !secret.youtubeClientSecret) {
      throw new Error('YouTube OAuth client ID and secret are not configured.');
    }
    const client = new google.auth.OAuth2(secret.youtubeClientId, secret.youtubeClientSecret);
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
    const status = this.secrets.status();
    if (!status.youtubeClientConfigured || !status.youtubeAuthorized) {
      return { configured: status.youtubeClientConfigured, authorized: false, channelTitle: null, channelId: null };
    }
    try {
      const auth = await this.client();
      const youtube = google.youtube({ version: 'v3', auth });
      const response = await youtube.channels.list({ part: ['snippet'], mine: true });
      const channel = response.data.items?.[0];
      return {
        configured: true,
        authorized: true,
        channelTitle: channel?.snippet?.title ?? null,
        channelId: channel?.id ?? null
      };
    } catch {
      return { configured: true, authorized: false, channelTitle: null, channelId: null };
    }
  }

  async authorize(): Promise<YouTubeConnectionStatus> {
    const secret = this.secrets.getAll();
    if (!secret.youtubeClientId || !secret.youtubeClientSecret) {
      throw new Error('Save a Google OAuth desktop client ID and secret in Settings first.');
    }

    const result = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
      const server = createServer((request, response) => {
        try {
          const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
          if (url.pathname !== '/oauth2callback') {
            response.writeHead(404).end('Not found');
            return;
          }
          const error = url.searchParams.get('error');
          const code = url.searchParams.get('code');
          if (error || !code) {
            response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
            response.end('<h1>Authorization failed</h1><p>You can close this window.</p>');
            server.close();
            reject(new Error(error ?? 'OAuth callback did not include a code.'));
            return;
          }
          const address = server.address();
          const port = typeof address === 'object' && address ? address.port : 0;
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          response.end('<h1>VideoFactory is connected</h1><p>You can close this window and return to the app.</p>');
          server.close();
          resolve({ code, redirectUri: `http://127.0.0.1:${port}/oauth2callback` });
        } catch (error) {
          server.close();
          reject(error);
        }
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', async () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
        const auth = new google.auth.OAuth2(secret.youtubeClientId, secret.youtubeClientSecret, redirectUri);
        const authUrl = auth.generateAuthUrl({
          access_type: 'offline',
          prompt: 'consent',
          scope: SCOPES
        });
        await shell.openExternal(authUrl, { activate: true });
      });
      setTimeout(() => {
        server.close();
        reject(new Error('YouTube authorization timed out.'));
      }, 5 * 60_000).unref();
    });

    const auth = new google.auth.OAuth2(secret.youtubeClientId, secret.youtubeClientSecret, result.redirectUri);
    const tokenResponse = await auth.getToken(result.code);
    this.secrets.update({
      youtubeAccessToken: tokenResponse.tokens.access_token ?? undefined,
      youtubeRefreshToken: tokenResponse.tokens.refresh_token ?? undefined,
      youtubeTokenExpiry: tokenResponse.tokens.expiry_date ?? undefined
    });
    return this.status();
  }

  async uploadPrivate(projectId: string): Promise<{ videoId: string; url: string }> {
    const project = this.projects.get(projectId);
    if (!['QC_FINAL', 'WAITING_FINAL_APPROVAL', 'WAITING_YOUTUBE_PROCESSING', 'UPLOADING_PRIVATE'].includes(project.state)) {
      throw new Error(`Private upload is not allowed from project state ${project.state}.`);
    }
    const render = project.renders.find(item => item.kind === 'final' && item.state === 'SUCCEEDED');
    if (!render?.outputPath || !render.sha256 || !existsSync(render.outputPath)) {
      throw new Error('A validated final render is required before upload.');
    }
    const selected = project.packaging.find(candidate => candidate.selected) ?? project.packaging[0];
    if (!selected) throw new Error('Packaging has not been generated.');
    if (!selected.thumbnailPath || !existsSync(selected.thumbnailPath)) {
      throw new Error('The selected publishing package requires a generated thumbnail before upload.');
    }

    const existing = this.db.raw.prepare(`
      SELECT id, project_id, video_id, upload_session_uri, caption_id, thumbnail_uploaded, channel_id
      FROM publication_records
      WHERE final_sha256 = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(render.sha256) as UploadRow | undefined;
    assertPublicationUploadOwner(existing, projectId);

    const auth = await this.client();
    const youtube = google.youtube({ version: 'v3', auth });
    if (existing?.video_id) {
      if (project.state === 'WAITING_FINAL_APPROVAL') {
        this.projects.states.transition(projectId, 'UPLOADING_PRIVATE', {
          progress: 0.93,
          reason: 'Synchronizing changed metadata and thumbnail to the existing private upload',
          prerequisites: { videoId: existing.video_id, packageId: selected.id }
        });
      }
      await youtube.videos.update({
        part: ['snippet', 'status'],
        requestBody: {
          id: existing.video_id,
          snippet: {
            title: selected.title,
            description: selected.description,
            tags: selected.tags,
            categoryId: this.settings().youtubeCategoryId,
            defaultLanguage: 'en'
          },
          status: privateVideoStatus(this.settings().youtubeSyntheticMediaDisclosure)
        }
      });
      if (selected.thumbnailPath && existsSync(selected.thumbnailPath)) {
        await youtube.thumbnails.set({
          videoId: existing.video_id,
          media: { mimeType: 'image/jpeg', body: createReadStream(selected.thumbnailPath) }
        });
      }
      const captionId = await this.ensureCaption(youtube, existing.video_id, render.manifestPath, existing.caption_id);
      await this.ensurePlaylist(youtube, existing.video_id);
      const approvalHash = approvalFingerprint({
        finalSha256: render.sha256,
        packageId: selected.id,
        title: selected.title,
        description: selected.description,
        chapters: selected.chapters,
        tags: selected.tags,
        thumbnailSha256: selected.thumbnailPath && existsSync(selected.thumbnailPath) ? fileSha256(selected.thumbnailPath) : null
      });
      this.db.raw.prepare(`
        UPDATE publication_records SET selected_package_id = ?, approval_hash = ?,
          caption_id = ?, thumbnail_uploaded = ?, processing_status = 'uploaded',
          error = NULL, updated_at = ? WHERE id = ?
      `).run(
        selected.id, approvalHash, captionId,
        Number(!selected.thumbnailPath || existsSync(selected.thumbnailPath)),
        new Date().toISOString(), existing.id
      );
      this.projects.states.transition(projectId, 'WAITING_YOUTUBE_PROCESSING', {
        progress: 0.95,
        youtubeVideoId: existing.video_id,
        reason: 'Private upload package synchronized; processing state will be rechecked',
        prerequisites: { videoId: existing.video_id }
      });
      await this.waitForProcessing(youtube, projectId, existing.video_id, existing.id);
      this.projects.states.transition(projectId, 'WAITING_FINAL_APPROVAL', {
        progress: 0.96,
        reason: 'Changed private package is synchronized and ready for approval',
        prerequisites: { videoId: existing.video_id, approvalHash }
      });
      return { videoId: existing.video_id, url: `https://www.youtube.com/watch?v=${existing.video_id}` };
    }
    this.projects.states.transition(projectId, 'UPLOADING_PRIVATE', {
      progress: 0.93,
      reason: 'Operator or policy initiated private-first YouTube upload',
      prerequisites: { finalSha256: render.sha256, packageId: selected.id }
    });

    const publicationId = existing?.id ?? randomUUID();
    const approvalHash = approvalFingerprint({
      finalSha256: render.sha256,
      packageId: selected.id,
      title: selected.title,
      description: selected.description,
      chapters: selected.chapters,
      tags: selected.tags,
      thumbnailSha256: selected.thumbnailPath && existsSync(selected.thumbnailPath) ? fileSha256(selected.thumbnailPath) : null
    });
    if (!existing) {
      const now = new Date().toISOString();
      this.db.raw.prepare(`
        INSERT INTO publication_records(
          id, project_id, video_id, privacy_status, final_sha256, processing_status,
          selected_package_id, thumbnail_uploaded, approval_hash, synthetic_media,
          created_at, updated_at
        ) VALUES(?, ?, NULL, 'private', ?, 'initializing', ?, 0, ?, ?, ?, ?)
      `).run(
        publicationId, projectId, render.sha256, selected.id, approvalHash,
        Number(this.settings().youtubeSyntheticMediaDisclosure), now, now
      );
    }

    const videoId = await this.uploadResumable(
      auth,
      publicationId,
      render.outputPath,
      existing?.upload_session_uri ?? null,
      {
        snippet: {
          title: selected.title,
          description: selected.description,
          tags: selected.tags,
          categoryId: this.settings().youtubeCategoryId,
          defaultLanguage: 'en'
        },
        status: privateVideoStatus(this.settings().youtubeSyntheticMediaDisclosure)
      },
      projectId
    );
    if (!videoId) throw new Error('YouTube upload completed without a video ID.');

    const uploadedAt = new Date().toISOString();
    this.db.raw.prepare(`
      UPDATE publication_records SET video_id = ?, processing_status = 'uploaded',
        error = NULL, updated_at = ? WHERE id = ?
    `).run(videoId, uploadedAt, publicationId);
    this.projects.states.transition(projectId, 'WAITING_YOUTUBE_PROCESSING', {
      progress: 0.95,
      youtubeVideoId: videoId,
      reason: 'Resumable private upload completed; attachments and processing will be confirmed',
      prerequisites: { videoId, finalSha256: render.sha256 }
    });

    if (selected.thumbnailPath && existsSync(selected.thumbnailPath)) {
      await youtube.thumbnails.set({
        videoId,
        media: {
          mimeType: 'image/jpeg',
          body: createReadStream(selected.thumbnailPath)
        }
      });
    }

    const captionId = await this.ensureCaption(youtube, videoId, render.manifestPath, null);
    await this.ensurePlaylist(youtube, videoId);

    const channel = await youtube.channels.list({ part: ['id'], mine: true });
    const channelId = channel.data.items?.[0]?.id ?? null;
    const now = new Date().toISOString();
    this.db.raw.prepare(`
      UPDATE publication_records SET channel_id = ?, video_id = ?, privacy_status = 'private',
        processing_status = 'uploaded', selected_package_id = ?, caption_id = ?,
        thumbnail_uploaded = ?, approval_hash = ?, error = NULL, updated_at = ?
      WHERE id = ?
    `).run(
      channelId,
      videoId,
      selected.id,
      captionId,
      Number(Boolean(selected.thumbnailPath)),
      approvalHash,
      now,
      publicationId
    );
    await this.waitForProcessing(youtube, projectId, videoId, publicationId);
    this.projects.states.transition(projectId, 'WAITING_FINAL_APPROVAL', {
      progress: 0.96,
      reason: 'YouTube reports a processed private video ready for operator review',
      prerequisites: { videoId }
    });
    return { videoId, url: `https://www.youtube.com/watch?v=${videoId}` };
  }

  private async uploadResumable(
    auth: Auth.OAuth2Client,
    publicationId: string,
    outputPath: string,
    storedSession: string | null,
    metadata: Record<string, unknown>,
    projectId: string
  ): Promise<string> {
    const size = statSync(outputPath).size;
    if (size <= 0) throw new Error('The final render is empty.');
    let session = storedSession ? validateUploadSession(storedSession) : null;
    let offset = 0;

    if (session) {
      try {
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
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
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
    existingCaptionId: string | null
  ): Promise<string | null> {
    if (existingCaptionId) return existingCaptionId;
    const captions = await youtube.captions.list({ part: ['id', 'snippet'], videoId });
    const reusableId = reusableEnglishCaptionId(captions.data.items, videoId);
    if (reusableId) return reusableId;
    if (!manifestPath || !existsSync(manifestPath)) throw new Error('Render manifest is missing for caption upload.');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { captions?: { srtPath?: string } };
    const srt = manifest.captions?.srtPath;
    if (!srt || !existsSync(srt)) throw new Error('Timed SRT caption track is missing.');
    const caption = await youtube.captions.insert({
      part: ['snippet'],
      requestBody: {
        snippet: { videoId, language: 'en', name: 'English', isDraft: false }
      },
      media: { mimeType: 'application/octet-stream', body: createReadStream(srt) }
    });
    return caption.data.id ?? null;
  }

  private async ensurePlaylist(youtube: youtube_v3.Youtube, videoId: string): Promise<void> {
    const playlistId = this.settings().youtubePlaylistId.trim();
    if (!playlistId) return;
    const existing = await youtube.playlistItems.list({
      part: ['id'], playlistId, videoId, maxResults: 1
    });
    if (existing.data.items?.length) return;
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
    publicationId: string
  ): Promise<void> {
    try {
      await awaitUsableYouTubeProcessing({
        readStatus: async () => {
          const result = await youtube.videos.list({ part: ['processingDetails', 'status'], id: [videoId] });
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

  async approve(
    projectId: string,
    action: 'keep_private' | 'publish' | 'schedule',
    scheduledAt?: string
  ): Promise<PublicationApprovalResult> {
    const project = this.projects.get(projectId);
    if (project.state !== 'WAITING_FINAL_APPROVAL') {
      throw new Error(`Publication approval is not allowed from project state ${project.state}.`);
    }
    if (!project.youtubeVideoId) {
      throw new Error('Project has not been uploaded to YouTube.');
    }

    const render = project.renders.find(item => item.kind === 'final' && item.state === 'SUCCEEDED');
    const selected = project.packaging.find(candidate => candidate.selected) ?? project.packaging[0];
    if (!render?.sha256 || !selected) throw new Error('Final render and packaging are required for approval.');
    const currentApprovalHash = approvalFingerprint({
      finalSha256: render.sha256,
      packageId: selected.id,
      title: selected.title,
      description: selected.description,
      chapters: selected.chapters,
      tags: selected.tags,
      thumbnailSha256: selected.thumbnailPath && existsSync(selected.thumbnailPath) ? fileSha256(selected.thumbnailPath) : null
    });
    const publication = this.db.raw.prepare(`
      SELECT approval_hash, processing_status, caption_id, thumbnail_uploaded
      FROM publication_records WHERE project_id = ? AND video_id = ?
    `).get(projectId, project.youtubeVideoId) as {
      approval_hash: string | null;
      processing_status: string | null;
      caption_id: string | null;
      thumbnail_uploaded: number;
    } | undefined;
    if (!publication?.approval_hash || publication.approval_hash !== currentApprovalHash) {
      throw new Error('The final render or publishing package changed after upload. Upload the current package before approval.');
    }
    if (publication.processing_status !== 'succeeded' || !publication.caption_id || !publication.thumbnail_uploaded) {
      throw new Error('YouTube processing, thumbnail, and timed captions must all succeed before approval.');
    }

    if (action === 'keep_private') {
      const now = new Date().toISOString();
      this.db.raw.transaction(() => {
        this.db.raw.prepare(`
          UPDATE publication_records SET privacy_status = 'private', approved_at = ?,
            approval_hash = ?, scheduled_at = NULL, published_at = NULL, updated_at = ?
          WHERE project_id = ? AND video_id = ?
        `).run(now, currentApprovalHash, now, projectId, project.youtubeVideoId);
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
      throw new Error('A valid future schedule time is required.');
    }

    const auth = await this.client();
    const status: youtube_v3.Schema$VideoStatus = action === 'publish'
      ? { privacyStatus: 'public' }
      : {
          privacyStatus: 'private',
          publishAt: scheduledAt
        };
    try {
      const responseStatus = await this.updatePublicationStatus(auth, project.youtubeVideoId, status);
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
      if (!isYouTubeStudioRestriction(error)) throw error;
      return this.routeToStudio(projectId, project.youtubeVideoId, action, scheduledAt, currentApprovalHash, error);
    }
    const now = new Date().toISOString();
    this.db.raw.prepare(`
      UPDATE publication_records SET privacy_status = ?, approved_at = ?, approval_hash = ?,
        scheduled_at = ?, published_at = ?, updated_at = ?
      WHERE project_id = ? AND video_id = ?
    `).run(
      action === 'publish' ? 'public' : 'private',
      now,
      currentApprovalHash,
      action === 'schedule' ? scheduledAt : null,
      action === 'publish' ? now : null,
      now,
      projectId,
      project.youtubeVideoId
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
    videoId: string,
    action: 'publish' | 'schedule',
    scheduledAt: string | undefined,
    approvalHash: string,
    error: unknown
  ): Promise<PublicationApprovalResult> {
    const url = studioVideoUrl(videoId);
    let opened = false;
    let openError: string | null = null;
    try {
      await this.openExternal(url);
      opened = true;
    } catch (cause) {
      openError = cause instanceof Error ? cause.message : String(cause);
    }
    const details = googleErrorDetails(error);
    const now = new Date().toISOString();
    this.db.raw.transaction(() => {
      this.db.raw.prepare(`
        UPDATE publication_records SET privacy_status = 'private', approved_at = ?,
          approval_hash = ?, scheduled_at = NULL, published_at = NULL, error = ?, updated_at = ?
        WHERE project_id = ? AND video_id = ?
      `).run(
        now,
        approvalHash,
        `API ${action} restriction; manual Studio action required.`,
        now,
        projectId,
        videoId
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
