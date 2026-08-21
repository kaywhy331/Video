import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { AppDatabase } from '../database/database';
import type { AppSettings, MusicTrack, ProjectMusicSelection } from '@shared/types';
import { resolveFfprobe } from '../tool-paths';
import { requireSuccess } from './process-utils';
import { abruptMusicCut, validateMusicMixPolicy } from '@shared/audio-policy';

async function fileHash(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export interface MusicImportRequest {
  filePath: string;
  title: string;
  provider: string;
  licenseType: string;
  licenseReference: string;
  licenseDocumentPath?: string;
  moods: string[];
  tempoBpm?: number | null;
  loopable: boolean;
  licenseAttested: true;
}

export class MusicService {
  constructor(
    private readonly db: AppDatabase,
    private readonly settings: () => AppSettings
  ) {}

  async import(request: MusicImportRequest): Promise<MusicTrack> {
    if (!request.licenseAttested || !request.licenseReference.trim()) {
      throw new Error('Licensed music import requires an explicit license attestation and reference.');
    }
    if (!existsSync(request.filePath) || !statSync(request.filePath).isFile()) throw new Error('Music source file does not exist.');
    if (request.licenseDocumentPath && (!existsSync(request.licenseDocumentPath) || !statSync(request.licenseDocumentPath).isFile())) {
      throw new Error('Music license document does not exist.');
    }
    const ffprobe = resolveFfprobe(this.settings().ffprobePath);
    if (!ffprobe) throw new Error('FFprobe is required to validate music media.');
    const probeResult = await requireSuccess(ffprobe, [
      '-v', 'error', '-show_format', '-show_streams', '-of', 'json', request.filePath
    ]);
    const probe = JSON.parse(probeResult.stdout) as {
      streams?: Array<{ codec_type?: string }>;
      format?: { duration?: string };
    };
    if (!probe.streams?.some(stream => stream.codec_type === 'audio')) throw new Error('Music file contains no audio stream.');
    const durationMs = Math.round(Number(probe.format?.duration ?? 0) * 1000);
    if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('Music duration could not be determined.');
    const sha256 = await fileHash(request.filePath);
    const existing = this.db.raw.prepare('SELECT id FROM music_tracks WHERE sha256 = ?').get(sha256) as { id: string } | undefined;
    if (existing) return this.get(existing.id);
    const extension = extname(request.filePath).toLowerCase() || '.audio';
    const managedPath = join(this.settings().mediaLibraryFolder, 'music', sha256.slice(0, 2), `${sha256}${extension}`);
    mkdirSync(dirname(managedPath), { recursive: true });
    copyFileSync(request.filePath, managedPath);
    if (await fileHash(managedPath) !== sha256) throw new Error('Managed music copy failed checksum validation.');
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.raw.prepare(`
      INSERT INTO music_tracks(
        id, sha256, original_path, original_file_name, title, provider,
        license_type, license_reference, license_document_path,
        license_verified_at, mood_json, tempo_bpm, duration_ms, loopable,
        enabled, raw_probe_json, imported_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).run(
      id, sha256, managedPath, basename(request.filePath), request.title,
      request.provider, request.licenseType, request.licenseReference,
      request.licenseDocumentPath ?? null, now, JSON.stringify(request.moods),
      request.tempoBpm ?? null, durationMs, Number(request.loopable),
      JSON.stringify(probe), now, now
    );
    return this.get(id);
  }

  list(): MusicTrack[] {
    return (this.db.raw.prepare('SELECT id FROM music_tracks ORDER BY enabled DESC, imported_at DESC').all() as Array<{ id: string }>).map(row => this.get(row.id));
  }

  getSelection(projectId: string): ProjectMusicSelection | null {
    const row = this.db.raw.prepare('SELECT * FROM project_music_selections WHERE project_id = ?').get(projectId) as Record<string, unknown> | undefined;
    return row ? this.selection(row) : null;
  }

  select(projectId: string, trackId: string, selectedBy: 'automatic' | 'human' = 'human'): ProjectMusicSelection {
    if (!this.db.raw.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) throw new Error('Music project not found.');
    const track = this.get(trackId);
    if (!track.enabled || !track.licenseVerifiedAt || !track.licenseReference) throw new Error('Only enabled license-verified music can be selected.');
    const settings = this.settings();
    const fadeInMs = 750;
    const fadeOutMs = 1_000;
    validateMusicMixPolicy({
      targetGainDb: settings.musicTargetGainDb,
      duckingDb: settings.musicDuckingDb,
      fadeInMs,
      fadeOutMs
    }, track.durationMs);
    if (abruptMusicCut(track.durationMs, fadeOutMs)) throw new Error('Selected music would end without a safe fade.');
    const id = randomUUID();
    const now = new Date().toISOString();
    const licenseSnapshot = {
      sha256: track.sha256,
      provider: track.provider,
      licenseType: track.licenseType,
      licenseReference: track.licenseReference,
      licenseDocumentPath: track.licenseDocumentPath,
      verifiedAt: track.licenseVerifiedAt
    };
    this.db.raw.prepare(`
      INSERT INTO project_music_selections(
        id, project_id, music_track_id, selected_by, target_gain_db,
        ducking_db, fade_in_ms, fade_out_ms, license_snapshot_json,
        created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        music_track_id = excluded.music_track_id,
        selected_by = excluded.selected_by,
        target_gain_db = excluded.target_gain_db,
        ducking_db = excluded.ducking_db,
        fade_in_ms = excluded.fade_in_ms,
        fade_out_ms = excluded.fade_out_ms,
        license_snapshot_json = excluded.license_snapshot_json,
        updated_at = excluded.updated_at
    `).run(
      id, projectId, trackId, selectedBy, settings.musicTargetGainDb,
      settings.musicDuckingDb, fadeInMs, fadeOutMs,
      JSON.stringify(licenseSnapshot), now, now
    );
    const row = this.db.raw.prepare('SELECT * FROM project_music_selections WHERE project_id = ?').get(projectId) as Record<string, unknown>;
    return this.selection(row);
  }

  selectionForProject(projectId: string): (ProjectMusicSelection & { track: MusicTrack }) | null {
    const selection = this.getSelection(projectId);
    if (!selection) return null;
    return { ...selection, track: this.get(selection.musicTrackId) };
  }

  private get(id: string): MusicTrack {
    const row = this.db.raw.prepare('SELECT * FROM music_tracks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error('Music track not found.');
    return {
      id: String(row.id), sha256: String(row.sha256), originalPath: String(row.original_path),
      originalFileName: String(row.original_file_name), title: String(row.title), provider: String(row.provider),
      licenseType: String(row.license_type), licenseReference: String(row.license_reference),
      licenseDocumentPath: row.license_document_path ? String(row.license_document_path) : null,
      licenseVerifiedAt: String(row.license_verified_at), moods: JSON.parse(String(row.mood_json)),
      tempoBpm: row.tempo_bpm === null ? null : Number(row.tempo_bpm), durationMs: Number(row.duration_ms),
      loopable: Boolean(row.loopable), enabled: Boolean(row.enabled), importedAt: String(row.imported_at)
    };
  }

  private selection(row: Record<string, unknown>): ProjectMusicSelection {
    return {
      id: String(row.id), projectId: String(row.project_id), musicTrackId: String(row.music_track_id),
      selectedBy: row.selected_by as ProjectMusicSelection['selectedBy'], targetGainDb: Number(row.target_gain_db),
      duckingDb: Number(row.ducking_db), fadeInMs: Number(row.fade_in_ms), fadeOutMs: Number(row.fade_out_ms),
      licenseSnapshot: JSON.parse(String(row.license_snapshot_json))
    };
  }
}
