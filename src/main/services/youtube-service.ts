import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { shell } from 'electron';
import { google, type Auth, type youtube_v3 } from 'googleapis';
import type { AppDatabase } from '../database/database';
import type { AppSettings, YouTubeConnectionStatus } from '@shared/types';
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
  'https://www.googleapis.com/auth/youtube.readonly'
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

interface ResumableVideoResponse {
  id?: string;
}

function responseHeader(headers: Record<string, unknown>, name: string): string | null {
  const get = (headers as { get?: (key: string) => unknown }).get;
  const value = typeof get === 'function'
    ? get.call(headers, name)
    : headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
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

function retryDelay(attempt: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt + Math.floor(Math.random() * 350)));
}

export class YouTubeService {
  constructor(
    private readonly db: AppDatabase,
    private readonly settings: () => AppSettings,
    private readonly secrets: SecretStore,
    private readonly projects: ProjectService,
    private readonly progress: (projectId: string, progress: number, message: string) => void
  ) {}

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
    if (!['WAITING_FINAL_APPROVAL', 'WAITING_YOUTUBE_PROCESSING', 'UPLOADING_PRIVATE'].includes(project.state)) {
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
    if (existing && existing.project_id !== projectId) {
      throw new Error('This final render hash is already assigned to a different project upload.');
    }

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
          status: {
            privacyStatus: 'private',
            selfDeclaredMadeForKids: false,
            containsSyntheticMedia: this.settings().youtubeSyntheticMediaDisclosure
          }
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
        status: {
          privacyStatus: 'private',
          selfDeclaredMadeForKids: false,
          containsSyntheticMedia: this.settings().youtubeSyntheticMediaDisclosure
        }
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
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const result = await youtube.videos.list({ part: ['processingDetails', 'status'], id: [videoId] });
      const video = result.data.items?.[0];
      const status = video?.processingDetails?.processingStatus;
      if (status === 'succeeded') {
        this.db.raw.prepare(`
          UPDATE publication_records SET processing_status = 'succeeded', error = NULL,
            updated_at = ? WHERE id = ?
        `).run(new Date().toISOString(), publicationId);
        return;
      }
      if (status === 'failed' || status === 'terminated') {
        this.db.raw.prepare(`
          UPDATE publication_records SET processing_status = ?, error = ?, updated_at = ? WHERE id = ?
        `).run(status, `YouTube processing ${status}.`, new Date().toISOString(), publicationId);
        throw new Error(`YouTube processing ${status}.`);
      }
      this.progress(projectId, attempt / 20, `Waiting for YouTube processing (${status ?? 'pending'})`);
      await new Promise(resolve => setTimeout(resolve, 15_000));
    }
    throw new Error('YouTube processing did not finish within five minutes. Retry will not create a duplicate upload.');
  }

  async approve(
    projectId: string,
    action: 'keep_private' | 'publish' | 'schedule',
    scheduledAt?: string
  ): Promise<void> {
    const project = this.projects.get(projectId);
    if (project.state !== 'WAITING_FINAL_APPROVAL') {
      throw new Error(`Publication approval is not allowed from project state ${project.state}.`);
    }
    if (!project.youtubeVideoId) {
      if (action === 'keep_private') return;
      throw new Error('Project has not been uploaded to YouTube.');
    }
    if (action === 'keep_private') {
      return;
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

    const auth = await this.client();
    const youtube = google.youtube({ version: 'v3', auth });
    const status: youtube_v3.Schema$VideoStatus = action === 'publish'
      ? { privacyStatus: 'public' }
      : {
          privacyStatus: 'private',
          publishAt: scheduledAt
        };
    if (action === 'schedule') {
      if (!scheduledAt || new Date(scheduledAt).getTime() <= Date.now()) {
        throw new Error('A future schedule time is required.');
      }
    }
    await youtube.videos.update({
      part: ['status'],
      requestBody: {
        id: project.youtubeVideoId,
        status
      }
    });
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
  }
}
