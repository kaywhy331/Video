import { createHash } from 'node:crypto';
import { mkdirSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { AppDatabase } from '@main/database/database';
import { JobService } from '@main/services/job-service';
import { ProjectService } from '@main/services/project-service';
import type { SecretStore } from '@main/secret-store';
import { WorkflowService } from '@main/services/workflow-service';
import {
  YouTubeService,
  youtubeCredentialFingerprint,
  type YouTubeApiRuntime
} from '@main/services/youtube-service';
import type { AppSettings } from '@shared/types';

export type UploadCrashMode = 'session_persisted' | 'remote_committed';

export const UPLOAD_CRASH_MARKERS: Record<UploadCrashMode, string> = {
  session_persisted: 'VIDEOFACTORY_UPLOAD_SESSION_PERSISTED',
  remote_committed: 'VIDEOFACTORY_UPLOAD_REMOTE_COMMITTED'
};

export const UPLOAD_FIXTURE_VIDEO_ID = 'fixture-video-1';
const UPLOAD_FIXTURE_CREATE_URL = 'https://www.googleapis.com/upload/youtube/v3/videos';
export const UPLOAD_FIXTURE_SESSION =
  'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=videofactory-fixture-session';

export interface UploadProtocolState {
  session_creates: number;
  status_queries: number;
  chunk_attempts: number;
  remote_bytes: number;
  remote_video_id: string | null;
  last_content_range: string | null;
}

export interface OpenUploadCrashFixture {
  db: AppDatabase;
  jobs: JobService;
  projects: ProjectService;
  workflow: WorkflowService;
  youtube: YouTubeService;
  settings: AppSettings;
  finalSizeBytes: number;
}

function requestHeader(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== 'object') return null;
  const values = headers as Record<string, unknown>;
  const entry = Object.entries(values).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1] === undefined || entry?.[1] === null ? null : String(entry[1]);
}

async function consumeBody(data: unknown): Promise<number> {
  if (!data || typeof (data as AsyncIterable<unknown>)[Symbol.asyncIterator] !== 'function') {
    throw new Error('Upload fixture expected an async iterable media body.');
  }
  let bytes = 0;
  for await (const chunk of data as AsyncIterable<unknown>) {
    if (typeof chunk === 'string') bytes += Buffer.byteLength(chunk);
    else if (chunk instanceof Uint8Array) bytes += chunk.byteLength;
    else throw new Error('Upload fixture received an unsupported media chunk.');
  }
  return bytes;
}

function terminateAt(mode: UploadCrashMode): never {
  writeSync(1, `${UPLOAD_CRASH_MARKERS[mode]}\n`);
  process.kill(process.pid, 'SIGKILL');
  throw new Error(`Upload crash fixture could not terminate at ${mode}.`);
}

function uploadRuntime(db: AppDatabase, crashMode: UploadCrashMode | null): YouTubeApiRuntime {
  const request = async (input: {
    url?: string;
    method?: string;
    headers?: Record<string, unknown>;
    data?: unknown;
  }) => {
    const method = input.method?.toUpperCase();
    const contentRange = requestHeader(input.headers, 'content-range');
    if (method === 'POST') {
      if (input.url !== UPLOAD_FIXTURE_CREATE_URL) {
        throw new Error(`Upload fixture received an unexpected session endpoint: ${input.url ?? ''}`);
      }
      db.raw.prepare(`
        UPDATE upload_crash_fixture_state
        SET session_creates = session_creates + 1 WHERE singleton_id = 1
      `).run();
      return { status: 200, data: {}, headers: { location: UPLOAD_FIXTURE_SESSION } };
    }
    if (method !== 'PUT' || input.url !== UPLOAD_FIXTURE_SESSION || !contentRange) {
      throw new Error(`Upload fixture received an unexpected request: ${method ?? 'UNKNOWN'} ${input.url ?? ''}`);
    }
    if (contentRange.startsWith('bytes */')) {
      db.raw.prepare(`
        UPDATE upload_crash_fixture_state
        SET status_queries = status_queries + 1 WHERE singleton_id = 1
      `).run();
      const state = uploadProtocolState(db);
      return state.remote_video_id
        ? { status: 200, data: { id: state.remote_video_id }, headers: {} }
        : {
            status: 308,
            data: {},
            headers: state.remote_bytes > 0 ? { range: `bytes=0-${state.remote_bytes - 1}` } : {}
          };
    }

    const parsed = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange);
    if (!parsed) throw new Error(`Upload fixture received an invalid content range: ${contentRange}`);
    const start = Number(parsed[1]);
    const end = Number(parsed[2]);
    const size = Number(parsed[3]);
    db.raw.prepare(`
      UPDATE upload_crash_fixture_state
      SET chunk_attempts = chunk_attempts + 1, last_content_range = ?
      WHERE singleton_id = 1
    `).run(contentRange);
    if (crashMode === 'session_persisted') terminateAt(crashMode);

    const bytes = await consumeBody(input.data);
    if (bytes !== end - start + 1 || end + 1 !== size) {
      throw new Error(`Upload fixture received ${bytes} bytes for ${contentRange}.`);
    }
    db.raw.prepare(`
      UPDATE upload_crash_fixture_state
      SET remote_bytes = ?, remote_video_id = ? WHERE singleton_id = 1
    `).run(end + 1, UPLOAD_FIXTURE_VIDEO_ID);
    if (crashMode === 'remote_committed') terminateAt(crashMode);
    return { status: 200, data: { id: UPLOAD_FIXTURE_VIDEO_ID }, headers: {} };
  };

  const oauthClient = {
    setCredentials: () => undefined,
    on: () => oauthClient,
    request
  };
  const youtubeClient = {
    videos: {
      update: async () => ({ data: {} }),
      list: async () => ({
        data: { items: [{ processingDetails: { processingStatus: 'succeeded' } }] }
      })
    },
    thumbnails: {
      set: async ({ media }: { media?: { body?: unknown } }) => {
        await consumeBody(media?.body);
        return { data: {} };
      }
    },
    captions: {
      list: async ({ videoId }: { videoId: string }) => ({
        data: {
          items: [{
            id: 'fixture-caption-1',
            snippet: { language: 'en', videoId }
          }]
        }
      }),
      insert: async () => ({ data: { id: 'fixture-caption-1' } })
    },
    playlistItems: {
      list: async () => ({ data: { items: [] } }),
      insert: async () => ({ data: {} })
    }
  };
  return {
    createOAuthClient: () => oauthClient as never,
    createYouTubeClient: () => youtubeClient as never
  };
}

export function uploadProtocolState(db: AppDatabase): UploadProtocolState {
  return db.raw.prepare(`
    SELECT session_creates, status_queries, chunk_attempts, remote_bytes,
      remote_video_id, last_content_range
    FROM upload_crash_fixture_state WHERE singleton_id = 1
  `).get() as unknown as UploadProtocolState;
}

export function seedUploadCrashFixture(root: string): void {
  const outputFolder = join(root, 'output');
  mkdirSync(outputFolder, { recursive: true });
  const finalPath = join(outputFolder, 'fixture-final.mp4');
  const thumbnailPath = join(root, 'fixture-thumbnail.jpg');
  const finalBytes = Buffer.alloc(512 * 1024, 0x5a);
  writeFileSync(finalPath, finalBytes);
  writeFileSync(thumbnailPath, Buffer.from('fixture thumbnail bytes'));
  const finalSha = createHash('sha256').update(finalBytes).digest('hex');

  const db = new AppDatabase(join(root, 'videofactory.sqlite'));
  try {
    const now = new Date().toISOString();
    db.raw.exec(`
      CREATE TABLE upload_crash_fixture_state(
        singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
        session_creates INTEGER NOT NULL DEFAULT 0,
        status_queries INTEGER NOT NULL DEFAULT 0,
        chunk_attempts INTEGER NOT NULL DEFAULT 0,
        remote_bytes INTEGER NOT NULL DEFAULT 0,
        remote_video_id TEXT,
        last_content_range TEXT
      );
      INSERT INTO upload_crash_fixture_state(singleton_id) VALUES(1);
    `);
    db.raw.prepare(`
      INSERT INTO projects(
        id, sequence, slug, title, topic, state, progress, envato_project_name,
        target_duration_ms, final_render_id, created_at, updated_at
      ) VALUES('project-1', 1, 'upload-crash-fixture', 'Upload Crash Fixture',
        'Fixture', 'QC_FINAL', 0.9, 'YT-UPLOAD-CRASH-0001', 300000,
        'final-1', ?, ?)
    `).run(now, now);
    db.raw.prepare(`
      INSERT INTO renders(
        id, project_id, kind, profile, state, output_path, sha256,
        artifact_version, created_at, completed_at
      ) VALUES('final-1', 'project-1', 'final', 'final_1080p', 'SUCCEEDED',
        ?, ?, 1, ?, ?)
    `).run(finalPath, finalSha, now, now);
    db.raw.prepare(`
      INSERT INTO packaging_candidates(
        id, project_id, ordinal, title, angle, viewer_promise, thumbnail_path,
        description, chapters, tags_json, risk_status, selected, created_at
      ) VALUES('package-1', 'project-1', 1, 'Verified fixture title', 'Fixture angle',
        'Fixture promise', ?, 'Verified fixture description', '0:00 Opening',
        '["fixture","travel"]', 'pass', 1, ?)
    `).run(thumbnailPath, now);
    db.raw.prepare(`
      INSERT INTO youtube_connection_binding(
        singleton_id, channel_id, channel_title, credential_fingerprint, confirmed_at
      ) VALUES(1, 'UC-fixture', 'Fixture Channel', ?, ?)
    `).run(youtubeCredentialFingerprint('fixture-client-id', 'fixture-refresh-token'), now);
  } finally {
    db.close();
  }
}

export function openUploadCrashFixture(
  root: string,
  crashMode: UploadCrashMode | null = null
): OpenUploadCrashFixture {
  const settings = {
    outputFolder: join(root, 'output'),
    youtubeSyntheticMediaDisclosure: false,
    youtubeCategoryId: '19',
    youtubePlaylistId: ''
  } as unknown as AppSettings;
  const db = new AppDatabase(join(root, 'videofactory.sqlite'));
  const jobs = new JobService(db);
  const projects = new ProjectService(
    db,
    {} as never,
    {} as never,
    () => settings,
    {} as never
  );
  const secrets = {
    getAll: () => ({
      youtubeClientId: 'fixture-client-id',
      youtubeClientSecret: 'fixture-client-secret',
      youtubeRefreshToken: 'fixture-refresh-token'
    }),
    update: () => ({})
  } as unknown as SecretStore;
  const youtube = new YouTubeService(
    db,
    () => settings,
    secrets,
    projects,
    () => undefined,
    undefined,
    async () => undefined,
    undefined,
    undefined,
    uploadRuntime(db, crashMode)
  );
  const workflow = new WorkflowService(
    db,
    jobs,
    projects,
    {} as never,
    {} as never,
    {} as never,
    { get: () => ({ canUpload: true }) } as never,
    youtube,
    () => undefined,
    () => () => undefined
  );
  return {
    db,
    jobs,
    projects,
    workflow,
    youtube,
    settings,
    finalSizeBytes: statSync(join(root, 'output', 'fixture-final.mp4')).size
  };
}
