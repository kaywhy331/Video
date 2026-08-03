import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { shell } from 'electron';
import { google, type youtube_v3 } from 'googleapis';
import type { AppDatabase } from '../database/database';
import type { AppSettings, YouTubeConnectionStatus } from '@shared/types';
import type { SecretStore } from '../secret-store';
import type { ProjectService } from './project-service';

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.readonly'
];

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
    (client as any).on('tokens', tokens => {
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
    const render = project.renders.find(item => item.kind === 'final' && item.state === 'SUCCEEDED');
    if (!render?.outputPath || !render.sha256 || !existsSync(render.outputPath)) {
      throw new Error('A validated final render is required before upload.');
    }
    const selected = project.packaging.find(candidate => candidate.selected) ?? project.packaging[0];
    if (!selected) throw new Error('Packaging has not been generated.');

    const existing = this.db.raw.prepare(`
      SELECT video_id FROM publication_records
      WHERE final_sha256 = ? AND video_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 1
    `).get(render.sha256) as { video_id: string } | undefined;
    if (existing?.video_id) {
      return { videoId: existing.video_id, url: `https://www.youtube.com/watch?v=${existing.video_id}` };
    }

    const auth = await this.client();
    const youtube = google.youtube({ version: 'v3', auth });
    this.db.raw.prepare(`
      UPDATE projects SET state = 'UPLOADING_PRIVATE', progress = 0.93, updated_at = ?
      WHERE id = ?
    `).run(new Date().toISOString(), projectId);

    const response = await youtube.videos.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: {
          title: selected.title,
          description: selected.description,
          tags: selected.tags,
          categoryId: this.settings().youtubeCategoryId,
          defaultLanguage: 'en'
        },
        status: {
          privacyStatus: 'private',
          selfDeclaredMadeForKids: false
        }
      },
      media: {
        mimeType: 'video/mp4',
        body: createReadStream(render.outputPath)
      }
    }, {
      onUploadProgress: event => {
        const total = event.total ?? 0;
        const progress = total ? event.bytesRead / total : 0;
        this.progress(projectId, progress, `Uploading private video: ${Math.round(progress * 100)}%`);
      }
    });

    const videoId = response.data.id;
    if (!videoId) throw new Error('YouTube upload completed without a video ID.');

    if (selected.thumbnailPath && existsSync(selected.thumbnailPath)) {
      await youtube.thumbnails.set({
        videoId,
        media: {
          mimeType: 'image/jpeg',
          body: createReadStream(selected.thumbnailPath)
        }
      });
    }

    let captionId: string | null = null;
    if (render.manifestPath && existsSync(render.manifestPath)) {
      const manifest = JSON.parse(readFileSync(render.manifestPath, 'utf8')) as {
        captions?: { srtPath?: string };
      };
      const srt = manifest.captions?.srtPath;
      if (srt && existsSync(srt)) {
        const caption = await youtube.captions.insert({
          part: ['snippet'],
          requestBody: {
            snippet: {
              videoId,
              language: 'en',
              name: 'English',
              isDraft: false
            }
          },
          media: {
            mimeType: 'application/octet-stream',
            body: createReadStream(srt)
          }
        });
        captionId = caption.data.id ?? null;
      }
    }

    const channel = await youtube.channels.list({ part: ['id'], mine: true });
    const channelId = channel.data.items?.[0]?.id ?? null;
    const now = new Date().toISOString();
    this.db.raw.prepare(`
      INSERT INTO publication_records(
        id, project_id, channel_id, video_id, privacy_status, final_sha256,
        processing_status, selected_package_id, caption_id, thumbnail_uploaded,
        created_at, updated_at
      ) VALUES(?, ?, ?, ?, 'private', ?, 'uploaded', ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      projectId,
      channelId,
      videoId,
      render.sha256,
      selected.id,
      captionId,
      Number(Boolean(selected.thumbnailPath)),
      now,
      now
    );
    this.db.raw.prepare(`
      UPDATE projects SET youtube_video_id = ?, state = 'WAITING_FINAL_APPROVAL',
        progress = 0.96, updated_at = ?
      WHERE id = ?
    `).run(videoId, now, projectId);
    return { videoId, url: `https://www.youtube.com/watch?v=${videoId}` };
  }

  async approve(
    projectId: string,
    action: 'keep_private' | 'publish' | 'schedule',
    scheduledAt?: string
  ): Promise<void> {
    const project = this.projects.get(projectId);
    if (!project.youtubeVideoId) {
      if (action === 'keep_private') return;
      throw new Error('Project has not been uploaded to YouTube.');
    }
    if (action === 'keep_private') {
      this.db.raw.prepare(`
        UPDATE projects SET state = 'WAITING_FINAL_APPROVAL', updated_at = ? WHERE id = ?
      `).run(new Date().toISOString(), projectId);
      return;
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
      UPDATE publication_records SET privacy_status = ?, approved_at = ?,
        scheduled_at = ?, published_at = ?, updated_at = ?
      WHERE project_id = ? AND video_id = ?
    `).run(
      action === 'publish' ? 'public' : 'private',
      now,
      action === 'schedule' ? scheduledAt : null,
      action === 'publish' ? now : null,
      now,
      projectId,
      project.youtubeVideoId
    );
    this.db.raw.prepare(`
      UPDATE projects SET state = ?, progress = 1, published_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      action === 'schedule' ? 'SCHEDULED' : 'PUBLISHED',
      action === 'publish' ? now : null,
      now,
      projectId
    );
  }
}
