import { createHash, randomUUID } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  renameSync,
  copyFileSync,
  unlinkSync,
  statSync
} from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { AppDatabase } from '../database/database';
import type {
  AppSettings,
  AssetFile,
  MediaSegment,
  SemanticVerificationRetryResult
} from '@shared/types';
import { calculateEffectiveResolution, generateSlidingWindows } from '@shared/media-policy';
import {
  intervalCoverage,
  normalizedRotation,
  parseBlackIntervals,
  parseFreezeIntervals,
  type TimeInterval
} from '@shared/media-analysis';
import { resolveFfmpeg, resolveFfprobe } from '../tool-paths';
import { requireSuccess, requireSuccessBinary, runProcess } from './process-utils';
import { ProjectStateService } from './project-state-service';
import { RepairService } from './repair-service';
import type { FootageVerificationService } from './footage-verification-service';
import { cropRetainedPixels, qualifiesOutputPixels } from '@shared/output-profile';
import {
  assertSupportedSourceColor,
  MEDIA_PIPELINE_VERSION,
  type SourceColorTreatment
} from '@shared/color-policy';
import { canTransitionProject } from '@shared/state-machine';
import { differenceHash } from '@shared/perceptual-hash';
import { invalidatePublicationSnapshots } from './active-final-service';

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  pix_fmt?: string;
  color_space?: string;
  color_transfer?: string;
  color_primaries?: string;
  sample_rate?: string;
  channels?: number;
  tags?: Record<string, string>;
  side_data_list?: Array<{ rotation?: number }>;
}

interface ProbeOutput {
  format?: {
    duration?: string;
    size?: string;
    format_name?: string;
  };
  streams?: ProbeStream[];
}

function rational(value?: string): number {
  if (!value) return 0;
  if (!value.includes('/')) return Number(value) || 0;
  const [left, right] = value.split('/').map(Number);
  return left && right ? left / right : 0;
}

async function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function movePreservingBytes(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true });
  if (existsSync(destination)) return;
  try {
    renameSync(source, destination);
  } catch {
    copyFileSync(source, destination);
    const sourceHash = statSync(source).size;
    const destinationHash = statSync(destination).size;
    if (sourceHash !== destinationHash) {
      unlinkSync(destination);
      throw new Error('Copied file size did not match source.');
    }
    unlinkSync(source);
  }
}

function toAssetFile(row: Record<string, unknown>): AssetFile {
  return {
    id: String(row.id),
    assetId: String(row.asset_id),
    sha256: String(row.sha256),
    originalPath: String(row.original_path),
    proxyPath: row.proxy_path ? String(row.proxy_path) : null,
    contactSheetPath: row.contact_sheet_path ? String(row.contact_sheet_path) : null,
    fileName: String(row.original_file_name),
    fileSizeBytes: Number(row.file_size_bytes),
    durationMs: Number(row.duration_ms),
    width: Number(row.width),
    height: Number(row.height),
    frameRate: Number(row.frame_rate),
    codec: String(row.codec),
    pixelFormat: row.pixel_format ? String(row.pixel_format) : null,
    colorSpace: row.color_space ? String(row.color_space) : null,
    perceptualHash: row.perceptual_hash ? String(row.perceptual_hash) : null,
    audioPresent: Boolean(row.audio_present),
    createdAt: String(row.created_at)
  };
}

export class MediaService {
  static readonly PIPELINE_VERSION = MEDIA_PIPELINE_VERSION;

  constructor(
    private readonly db: AppDatabase,
    private readonly settings: () => AppSettings,
    private readonly footageVerification: FootageVerificationService,
    private readonly progress: (projectId: string | null, phase: string, progress: number, message: string) => void,
    private readonly finalizeProduction: (projectId: string) => Promise<void> = async projectId => {
      this.projectStates.transition(projectId, 'GENERATING_VOICE', {
        progress: 0.54,
        reason: 'Final script locked for narration'
      });
      this.projectStates.transition(projectId, 'BUILDING_TIMELINE', {
        progress: 0.59,
        reason: 'Narration and timeline inputs are ready'
      });
    }
  ) {
    this.projectStates = new ProjectStateService(db);
    this.repairs = new RepairService(db);
  }

  private readonly projectStates: ProjectStateService;
  private readonly repairs: RepairService;

  async probe(path: string): Promise<ProbeOutput> {
    const ffprobe = resolveFfprobe(this.settings().ffprobePath);
    if (!ffprobe) throw new Error('FFprobe is not configured or bundled.');
    const result = await requireSuccess(ffprobe, [
      '-v', 'error',
      '-show_format',
      '-show_streams',
      '-of', 'json',
      path
    ]);
    return JSON.parse(result.stdout) as ProbeOutput;
  }

  private async createProxy(
    originalPath: string,
    proxyPath: string,
    audioPresent: boolean,
    color: SourceColorTreatment
  ): Promise<void> {
    const ffmpeg = resolveFfmpeg(this.settings().ffmpegPath);
    if (!ffmpeg) throw new Error('FFmpeg is not configured or bundled.');
    mkdirSync(dirname(proxyPath), { recursive: true });
    const args = [
      '-y',
      '-hide_banner',
      '-i', originalPath,
      '-map', '0:v:0',
      ...(audioPresent ? ['-map', '0:a:0?'] : []),
      '-vf',
      [
        color.videoFilter,
        "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
        'setsar=1',
        'fps=30',
        'format=yuv420p'
      ].filter(Boolean).join(','),
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '24',
      ...(audioPresent ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']),
      '-movflags', '+faststart',
      proxyPath
    ];
    await requireSuccess(ffmpeg, args);
  }

  private async createContactSheet(
    originalPath: string,
    contactSheetPath: string,
    color: SourceColorTreatment
  ): Promise<void> {
    const ffmpeg = resolveFfmpeg(this.settings().ffmpegPath);
    if (!ffmpeg) throw new Error('FFmpeg is not configured or bundled.');
    mkdirSync(dirname(contactSheetPath), { recursive: true });
    await requireSuccess(ffmpeg, [
      '-y',
      '-hide_banner',
      '-i', originalPath,
      '-vf', [
        color.videoFilter,
        'fps=1/4',
        'scale=320:-1:force_original_aspect_ratio=decrease',
        'tile=4x3:padding=6:margin=6'
      ].filter(Boolean).join(','),
      '-frames:v', '1',
      contactSheetPath
    ]);
  }

  private async createPerceptualHash(
    originalPath: string,
    durationMs: number,
    color: SourceColorTreatment
  ): Promise<string | null> {
    const ffmpeg = resolveFfmpeg(this.settings().ffmpegPath);
    if (!ffmpeg) throw new Error('FFmpeg is not configured or bundled.');
    const result = await requireSuccessBinary(ffmpeg, [
      '-hide_banner',
      '-loglevel', 'error',
      '-ss', (Math.max(0, durationMs / 2) / 1000).toFixed(3),
      '-i', originalPath,
      '-frames:v', '1',
      '-vf', [color.videoFilter, 'scale=9:8:flags=bicubic', 'format=gray'].filter(Boolean).join(','),
      '-an',
      '-f', 'rawvideo',
      'pipe:1'
    ]);
    return result.stdout.length >= 72 ? differenceHash(result.stdout.subarray(0, 72)) : null;
  }

  private segmentRows(
    fileId: string,
    durationMs: number,
    width: number,
    height: number,
    rotation: 0 | 90 | 180 | 270,
    blackIntervals: TimeInterval[],
    freezeIntervals: TimeInterval[]
  ): MediaSegment[] {
    const effective = calculateEffectiveResolution({
      sourceWidth: width,
      sourceHeight: height,
      rotation,
      treatment: 'full_screen'
    });
    return generateSlidingWindows(durationMs).map((window, index) => {
      const blackFrameRisk = intervalCoverage(window.startMs, window.endMs, blackIntervals);
      const freezeRisk = intervalCoverage(window.startMs, window.endMs, freezeIntervals);
      return {
        id: randomUUID(),
        assetFileId: fileId,
        startMs: window.startMs,
        endMs: window.endMs,
        durationMs: window.durationMs,
        qualityScore: Math.max(0, 1 - index * 0.02 - blackFrameRisk * 0.8 - freezeRisk * 0.7),
        blackFrameRisk,
        freezeRisk,
        effectiveWidth: effective.effectiveWidth,
        effectiveHeight: effective.effectiveHeight,
        eligible1080p: effective.eligible1080p,
        eligible4k: effective.eligible4k,
        previewPath: null
      };
    }).sort((left, right) => right.qualityScore - left.qualityScore || left.startMs - right.startMs);
  }

  private async analyzeVisualRisks(path: string, durationMs: number): Promise<{
    blackIntervals: TimeInterval[];
    freezeIntervals: TimeInterval[];
  }> {
    const ffmpeg = resolveFfmpeg(this.settings().ffmpegPath);
    if (!ffmpeg) throw new Error('FFmpeg is not configured or bundled.');
    const result = await runProcess(ffmpeg, [
      '-hide_banner', '-nostats', '-i', path,
      '-vf', 'blackdetect=d=0.20:pix_th=0.10,freezedetect=n=-50dB:d=0.50',
      '-an', '-f', 'null', '-'
    ]);
    if (result.code !== 0) throw new Error(`FFmpeg visual analysis failed: ${result.stderr.slice(-2000)}`);
    return {
      blackIntervals: parseBlackIntervals(result.stderr),
      freezeIntervals: parseFreezeIntervals(result.stderr, durationMs)
    };
  }

  staleDerivativeCount(): number {
    const row = this.db.raw.prepare(`
      SELECT count(*) AS count
      FROM asset_files f
      WHERE f.pipeline_version <> ?
        OR NOT EXISTS (
          SELECT 1 FROM media_segments s
          WHERE s.asset_file_id = f.id AND s.pipeline_version = ?
        )
    `).get(MediaService.PIPELINE_VERSION, MediaService.PIPELINE_VERSION) as { count: number };
    return Number(row.count);
  }

  async refreshStaleDerivatives(): Promise<number> {
    const rows = this.db.raw.prepare(`
      SELECT f.* FROM asset_files f
      WHERE f.pipeline_version <> ?
        OR NOT EXISTS (
          SELECT 1 FROM media_segments s
          WHERE s.asset_file_id = f.id AND s.pipeline_version = ?
        )
      ORDER BY f.created_at, f.id
    `).all(MediaService.PIPELINE_VERSION, MediaService.PIPELINE_VERSION) as Array<Record<string, unknown>>;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      this.progress(
        null,
        'media-pipeline-refresh',
        rows.length ? index / rows.length : 1,
        `Regenerating media derivatives ${index + 1}/${rows.length}`
      );
      const affected = this.db.raw.prepare(`
        SELECT DISTINCT s.project_id, p.state, p.resume_state
        FROM project_scenes s
        JOIN projects p ON p.id = s.project_id
        WHERE s.selected_file_id = ?
          AND p.state NOT IN ('SCHEDULED','PUBLISHED','ANALYTICS_ACTIVE','CANCELLED','FAILED','ARCHIVED')
        ORDER BY s.project_id
      `).all(row.id) as Array<{
        project_id: string;
        state: import('@shared/types').ProjectState;
        resume_state: import('@shared/types').ProjectState | null;
      }>;
      const segments = await this.regenerateFileDerivatives(row);
      for (const project of affected) {
        await this.assignSegments(project.project_id, String(row.asset_id), String(row.id), segments);
        this.invalidateProjectsForMediaRefresh(project.project_id, String(row.id));
      }
    }
    if (rows.length) {
      this.progress(null, 'media-pipeline-refresh', 1, `Regenerated ${rows.length} stale media derivative set(s)`);
    }
    return rows.length;
  }

  private async regenerateFileDerivatives(row: Record<string, unknown>): Promise<MediaSegment[]> {
    const originalPath = String(row.original_path ?? '');
    if (!originalPath || !existsSync(originalPath)) {
      throw new Error(`Original media is missing for derivative regeneration: ${originalPath || String(row.id)}`);
    }
    const probe = await this.probe(originalPath);
    const video = probe.streams?.find(stream => stream.codec_type === 'video');
    if (!video?.width || !video.height || !video.codec_name) {
      throw new Error(`Original media ${originalPath} has no usable video stream.`);
    }
    const durationMs = Math.round(Number(probe.format?.duration ?? 0) * 1000);
    if (!durationMs) throw new Error(`Original media ${originalPath} has no measurable duration.`);
    const audioPresent = probe.streams?.some(stream => stream.codec_type === 'audio') ?? false;
    const frameRate = rational(video.avg_frame_rate || video.r_frame_rate) || 30;
    const rotation = normalizedRotation(video.tags, video.side_data_list);
    const color = assertSupportedSourceColor({
      colorSpace: video.color_space,
      colorTransfer: video.color_transfer,
      colorPrimaries: video.color_primaries
    });
    const settings = this.settings();
    const sha256 = String(row.sha256);
    const proxyPath = join(settings.mediaLibraryFolder, 'proxies', sha256.slice(0, 2), `${sha256}.mp4`);
    const contactSheetPath = join(settings.mediaLibraryFolder, 'keyframes', sha256.slice(0, 2), `${sha256}-contact.jpg`);
    await this.createProxy(originalPath, proxyPath, audioPresent, color);
    let contactSheetReady = false;
    try {
      await this.createContactSheet(originalPath, contactSheetPath, color);
      contactSheetReady = existsSync(contactSheetPath);
    } catch {
      contactSheetReady = false;
    }
    const perceptualHash = await this.createPerceptualHash(originalPath, durationMs, color);
    const risks = await this.analyzeVisualRisks(originalPath, durationMs);
    const generated = this.segmentRows(
      String(row.id), durationMs, video.width, video.height, rotation,
      risks.blackIntervals, risks.freezeIntervals
    );
    const prior = this.db.raw.prepare(`
      SELECT id, start_ms, end_ms FROM media_segments WHERE asset_file_id = ?
    `).all(row.id) as Array<{ id: string; start_ms: number; end_ms: number }>;
    const priorIds = new Map(prior.map(segment => [`${segment.start_ms}:${segment.end_ms}`, segment.id]));
    const segments = generated.map(segment => ({
      ...segment,
      id: priorIds.get(`${segment.startMs}:${segment.endMs}`) ?? segment.id
    }));
    const ids = new Set(segments.map(segment => segment.id));
    const obsoleteIds = prior.filter(segment => !ids.has(segment.id)).map(segment => segment.id);
    const now = new Date().toISOString();
    this.db.raw.transaction(() => {
      if (obsoleteIds.length) {
        this.db.raw.prepare(`
          UPDATE project_scenes SET selected_segment_id = NULL, verification_state = 'metadata_only', updated_at = ?
          WHERE selected_file_id = ? AND selected_segment_id IN (${obsoleteIds.map(() => '?').join(',')})
        `).run(now, row.id, ...obsoleteIds);
        this.db.raw.prepare(`
          DELETE FROM media_segments WHERE asset_file_id = ? AND id IN (${obsoleteIds.map(() => '?').join(',')})
        `).run(row.id, ...obsoleteIds);
      }
      this.db.raw.prepare(`
        UPDATE project_scenes SET verification_state = 'metadata_only', updated_at = ?
        WHERE selected_file_id = ?
          AND project_id IN (
            SELECT id FROM projects
            WHERE state NOT IN ('SCHEDULED','PUBLISHED','ANALYTICS_ACTIVE','CANCELLED','FAILED','ARCHIVED')
          )
      `).run(now, row.id);
      this.db.raw.prepare(`
        UPDATE asset_files SET proxy_path = ?, contact_sheet_path = ?, file_size_bytes = ?,
          duration_ms = ?, width = ?, height = ?, frame_rate = ?, codec = ?,
          pixel_format = ?, color_space = ?, perceptual_hash = ?, audio_present = ?, raw_ffprobe_json = ?, pipeline_version = ?
        WHERE id = ?
      `).run(
        proxyPath,
        contactSheetReady ? contactSheetPath : null,
        Number(probe.format?.size ?? statSync(originalPath).size),
        durationMs,
        video.width,
        video.height,
        frameRate,
        video.codec_name,
        video.pix_fmt ?? null,
        video.color_space ?? null,
        perceptualHash,
        Number(audioPresent),
        JSON.stringify(probe),
        MediaService.PIPELINE_VERSION,
        row.id
      );
      const upsert = this.db.raw.prepare(`
        INSERT INTO media_segments(
          id, asset_file_id, start_ms, end_ms, duration_ms, quality_score,
          black_frame_risk, freeze_risk, effective_width, effective_height,
          eligible_1080p, eligible_4k, preview_path, pipeline_version, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          start_ms = excluded.start_ms, end_ms = excluded.end_ms,
          duration_ms = excluded.duration_ms, quality_score = excluded.quality_score,
          black_frame_risk = excluded.black_frame_risk, freeze_risk = excluded.freeze_risk,
          effective_width = excluded.effective_width, effective_height = excluded.effective_height,
          eligible_1080p = excluded.eligible_1080p, eligible_4k = excluded.eligible_4k,
          preview_path = excluded.preview_path, pipeline_version = excluded.pipeline_version
      `);
      for (const segment of segments) {
        upsert.run(
          segment.id, segment.assetFileId, segment.startMs, segment.endMs, segment.durationMs,
          segment.qualityScore, segment.blackFrameRisk, segment.freezeRisk,
          segment.effectiveWidth, segment.effectiveHeight, Number(segment.eligible1080p),
          Number(segment.eligible4k), segment.previewPath, MediaService.PIPELINE_VERSION, now
        );
      }
    })();
    return segments;
  }

  private invalidateProjectsForMediaRefresh(projectId: string, fileId: string): void {
    const sceneIds = (this.db.raw.prepare(`
      SELECT id FROM project_scenes WHERE project_id = ? AND selected_file_id = ?
    `).all(projectId, fileId) as Array<{ id: string }>).map(row => row.id);
    if (!sceneIds.length) return;
    const now = new Date().toISOString();
    this.db.raw.transaction(() => {
      this.db.raw.prepare(`
        UPDATE render_fragments SET status = 'stale', updated_at = ?
        WHERE project_id = ? AND scene_id IN (${sceneIds.map(() => '?').join(',')}) AND status = 'ready'
      `).run(now, projectId, ...sceneIds);
      this.db.raw.prepare(`
        UPDATE projects SET final_render_id = NULL, youtube_video_id = NULL, updated_at = ? WHERE id = ?
      `).run(now, projectId);
      this.db.raw.prepare(`UPDATE packaging_candidates SET risk_status = 'blocked' WHERE project_id = ?`).run(projectId);
      invalidatePublicationSnapshots(
        this.db,
        projectId,
        'A selected source file changed after rendering. The prior private publication snapshot is stale.',
        'media_pipeline_refresh',
        now
      );
      this.db.raw.prepare(`
        INSERT INTO audit_log(project_id, action, actor, entity_type, entity_id, after_json, metadata_json, created_at)
        VALUES(?, 'media.pipeline_refreshed', 'system', 'asset_file', ?, ?, ?, ?)
      `).run(
        projectId,
        fileId,
        JSON.stringify({ pipelineVersion: MediaService.PIPELINE_VERSION, affectedSceneIds: sceneIds }),
        JSON.stringify({ finalAndPublicationPointersInvalidated: true }),
        now
      );
    })();
    const project = this.db.raw.prepare(`SELECT state, resume_state FROM projects WHERE id = ?`).get(projectId) as {
      state: import('@shared/types').ProjectState;
      resume_state: import('@shared/types').ProjectState | null;
    };
    const unverified = this.db.raw.prepare(`
      SELECT count(*) AS count FROM project_scenes
      WHERE project_id = ? AND verification_state NOT IN ('verified','graphic')
    `).get(projectId) as { count: number };
    if (Number(unverified.count)) return;
    const downstreamStates = new Set<import('@shared/types').ProjectState>([
      'BUILDING_TIMELINE', 'RENDERING_DRAFT', 'QC_DRAFT', 'RENDERING_FINAL', 'QC_FINAL',
      'UPLOADING_PRIVATE', 'WAITING_YOUTUBE_PROCESSING', 'WAITING_FINAL_APPROVAL'
    ]);
    if (project.state === 'PAUSED') {
      if (project.resume_state && downstreamStates.has(project.resume_state)) {
        this.db.raw.prepare(`UPDATE projects SET resume_state = 'BUILDING_TIMELINE', updated_at = ? WHERE id = ?`)
          .run(now, projectId);
      }
      return;
    }
    if (!downstreamStates.has(project.state) || project.state === 'BUILDING_TIMELINE') return;
    if (!canTransitionProject(project.state, 'BUILDING_TIMELINE')) {
      this.projectStates.transition(projectId, 'BLOCKED_EXCEPTION', {
        reason: 'Media pipeline regeneration invalidated downstream artifacts',
        prerequisites: { fileId, affectedSceneIds: sceneIds, pipelineVersion: MediaService.PIPELINE_VERSION }
      });
    }
    this.projectStates.transition(projectId, 'BUILDING_TIMELINE', {
      reason: 'Media derivatives were regenerated and reverified under the current pipeline',
      prerequisites: { fileId, affectedSceneIds: sceneIds, pipelineVersion: MediaService.PIPELINE_VERSION }
    });
  }

  async ingestAcquisition(acquisitionId: string, detectedPath: string): Promise<AssetFile> {
    const acquisition = this.db.raw.prepare(`
      SELECT a.*, p.id AS project_id, x.title AS asset_title,
        x.declared_width, x.declared_height, x.declared_duration_ms
      FROM acquisition_items a
      JOIN projects p ON p.id = a.project_id
      JOIN assets x ON x.id = a.asset_id
      WHERE a.id = ?
    `).get(acquisitionId) as Record<string, unknown> | undefined;
    if (!acquisition) throw new Error('Acquisition item not found.');
    const projectId = String(acquisition.project_id);
    const assetId = String(acquisition.asset_id);
    const settings = this.settings();
    const now = new Date().toISOString();

    const currentProject = this.db.raw.prepare('SELECT state FROM projects WHERE id = ?').get(projectId) as { state: import('@shared/types').ProjectState };
    if (currentProject.state === 'WAITING_FOR_DOWNLOADS') {
      this.projectStates.transition(projectId, 'INGESTING_MEDIA', {
        progress: 0.3,
        reason: 'Stable acquisition file mapped for ingest',
        prerequisites: { acquisitionId }
      });
    }

    this.progress(projectId, 'hashing', 0.08, `Hashing ${String(acquisition.asset_title)}`);
    const sha256 = await hashFile(detectedPath);
    const existing = this.db.raw.prepare('SELECT * FROM asset_files WHERE sha256 = ?').get(sha256) as
      | Record<string, unknown>
      | undefined;
    if (existing) {
      const expectedAssetId = String(existing.asset_id);
      if (expectedAssetId !== assetId) {
        const quarantinePath = join(settings.mediaLibraryFolder, 'quarantine', `${sha256.slice(0, 12)}-${basename(detectedPath)}`);
        movePreservingBytes(detectedPath, quarantinePath);
        throw new Error(`This physical file is already assigned to a different catalog asset and was quarantined at ${quarantinePath}.`);
      }
      if (
        existing.pipeline_version !== MediaService.PIPELINE_VERSION
        || !(this.db.raw.prepare(`
          SELECT 1 FROM media_segments WHERE asset_file_id = ? AND pipeline_version = ? LIMIT 1
        `).get(existing.id, MediaService.PIPELINE_VERSION))
      ) {
        await this.regenerateFileDerivatives(existing);
      }
      const current = this.db.raw.prepare('SELECT * FROM asset_files WHERE id = ?').get(existing.id) as Record<string, unknown>;
      const file = toAssetFile(current);
      if (existsSync(detectedPath)) unlinkSync(detectedPath);
      await this.attachExisting(acquisitionId, assetId, projectId, file.id);
      return file;
    }

    const sourceFileName = basename(detectedPath);
    const extension = extname(detectedPath).toLowerCase() || '.mov';
    const originalPath = join(settings.mediaLibraryFolder, 'originals', sha256.slice(0, 2), sha256.slice(2, 4), `${sha256}${extension}`);

    this.progress(projectId, 'probing', 0.2, 'Inspecting actual media metadata');
    let probe: ProbeOutput;
    try {
      probe = await this.probe(detectedPath);
    } catch (error) {
      const quarantinePath = join(settings.mediaLibraryFolder, 'quarantine', `${sha256.slice(0, 12)}-${sourceFileName}`);
      movePreservingBytes(detectedPath, quarantinePath);
      throw new Error(`Downloaded media is corrupt or unsupported and was quarantined at ${quarantinePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const video = probe.streams?.find(stream => stream.codec_type === 'video');
    if (!video?.width || !video.height || !video.codec_name) {
      throw new Error('Downloaded file contains no usable video stream.');
    }
    const videoWidth = video.width;
    const videoHeight = video.height;
    const audio = probe.streams?.some(stream => stream.codec_type === 'audio') ?? false;
    const durationMs = Math.round(Number(probe.format?.duration ?? 0) * 1000);
    if (!durationMs) throw new Error('Video duration could not be determined.');
    const frameRate = rational(video.avg_frame_rate || video.r_frame_rate) || 30;
    const rotation = normalizedRotation(video.tags, video.side_data_list);
    const color = assertSupportedSourceColor({
      colorSpace: video.color_space,
      colorTransfer: video.color_transfer,
      colorPrimaries: video.color_primaries
    });
    movePreservingBytes(detectedPath, originalPath);
    const preservedHash = await hashFile(originalPath);
    if (preservedHash !== sha256) throw new Error('Original file hash changed during centralization.');
    const fileId = randomUUID();
    const proxyPath = join(settings.mediaLibraryFolder, 'proxies', sha256.slice(0, 2), `${sha256}.mp4`);
    const contactSheetPath = join(settings.mediaLibraryFolder, 'keyframes', sha256.slice(0, 2), `${sha256}-contact.jpg`);

    this.progress(projectId, 'proxy', 0.34, 'Creating 720p planning proxy');
    await this.createProxy(originalPath, proxyPath, audio, color);
    this.progress(projectId, 'contact-sheet', 0.52, 'Extracting representative frames');
    try {
      await this.createContactSheet(originalPath, contactSheetPath, color);
    } catch {
      // The proxy remains useful even if a highly unusual source prevents a contact sheet.
    }
    const perceptualHash = await this.createPerceptualHash(originalPath, durationMs, color);

    this.progress(projectId, 'visual-analysis', 0.64, 'Detecting black and frozen intervals');
    const risks = await this.analyzeVisualRisks(originalPath, durationMs);
    const segments = this.segmentRows(
      fileId, durationMs, videoWidth, videoHeight, rotation,
      risks.blackIntervals, risks.freezeIntervals
    );
    const transaction = this.db.raw.transaction(() => {
      this.db.raw.prepare(`
        INSERT INTO asset_files(
          id, asset_id, sha256, original_path, proxy_path, contact_sheet_path,
          original_file_name, file_size_bytes, duration_ms, width, height,
          frame_rate, codec, pixel_format, color_space, perceptual_hash, audio_present,
          raw_ffprobe_json, pipeline_version, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        fileId,
        assetId,
        sha256,
        originalPath,
        proxyPath,
        existsSync(contactSheetPath) ? contactSheetPath : null,
        sourceFileName,
        Number(probe.format?.size ?? statSync(originalPath).size),
        durationMs,
        videoWidth,
        videoHeight,
        frameRate,
        video.codec_name,
        video.pix_fmt ?? null,
        video.color_space ?? null,
        perceptualHash,
        Number(audio),
        JSON.stringify(probe),
        MediaService.PIPELINE_VERSION,
        now
      );
      const insertSegment = this.db.raw.prepare(`
        INSERT INTO media_segments(
          id, asset_file_id, start_ms, end_ms, duration_ms, quality_score,
          black_frame_risk, freeze_risk, effective_width, effective_height,
          eligible_1080p, eligible_4k, preview_path, pipeline_version, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const segment of segments) {
        insertSegment.run(
          segment.id,
          segment.assetFileId,
          segment.startMs,
          segment.endMs,
          segment.durationMs,
          segment.qualityScore,
          segment.blackFrameRisk,
          segment.freezeRisk,
          segment.effectiveWidth,
          segment.effectiveHeight,
          Number(segment.eligible1080p),
          Number(segment.eligible4k),
          segment.previewPath,
          MediaService.PIPELINE_VERSION,
          now
        );
      }
      this.db.raw.prepare(`
        UPDATE assets SET local_file_id = ?, updated_at = ? WHERE id = ?
      `).run(fileId, now, assetId);
      this.db.raw.prepare(`
        UPDATE acquisition_items SET
          state = 'COMPLETE', mapped_file_id = ?, mapping_confidence = 1,
          updated_at = ?, error = NULL
        WHERE id = ?
      `).run(fileId, now, acquisitionId);
      this.recordMetadataConflict(acquisition, projectId, assetId, {
        width: videoWidth,
        height: videoHeight,
        durationMs,
        rotation
      });
    });
    transaction();
    this.progress(projectId, 'semantic-verification', 0.78, 'Verifying footage against current scene contracts');
    await this.assignSegments(projectId, assetId, fileId, segments);
    this.repairs.reconcileFootageRepairs(projectId);
    this.progress(projectId, 'verification-complete', 0.9, 'Footage ingest and scene-contract verification completed');
    await this.updateProjectAfterAcquisition(projectId);
    return toAssetFile(this.db.raw.prepare('SELECT * FROM asset_files WHERE id = ?').get(fileId) as Record<string, unknown>);
  }

  private async assignSegments(
    projectId: string,
    assetId: string,
    fileId: string,
    segments: MediaSegment[]
  ): Promise<void> {
    const scenes = this.db.raw.prepare(`
      SELECT DISTINCT s.id, s.ordinal, s.selected_asset_id
      FROM project_scenes s
      LEFT JOIN shot_candidates c ON c.scene_id = s.id AND c.asset_id = ?
      WHERE s.project_id = ? AND (s.selected_asset_id = ? OR c.asset_id IS NOT NULL)
      ORDER BY ordinal
    `).all(assetId, projectId, assetId) as Array<{ id: string; ordinal: number; selected_asset_id: string | null }>;
    const selectedScenes = scenes.filter(scene => scene.selected_asset_id === assetId);
    const profile = this.projectOutputDimensions(projectId);
    const eligible = segments.filter(segment => {
      return qualifiesOutputPixels(segment.effectiveWidth, segment.effectiveHeight, profile.width, profile.height)
        && segment.blackFrameRisk < 0.35
        && segment.freezeRisk < 0.5;
    });
    if (!eligible.length) {
      const now = new Date().toISOString();
      for (const scene of selectedScenes) {
        const route = this.repairs.routeFootageFailure(projectId, scene.id, 'NO_SAFE_SEGMENT', {
          assetId,
          fileId,
          sceneId: scene.id,
          sceneOrdinal: scene.ordinal,
          failure: `No segment satisfies the ${profile.width}×${profile.height} crop-retained pixel, black-frame, and freeze limits.`
        });
        if (route.status === 'verified') continue;
        this.db.raw.prepare(`
          UPDATE project_scenes SET verification_state = ?, updated_at = ? WHERE id = ?
        `).run(route.status === 'waiting_acquisition' ? 'download_required' : 'rejected', now, scene.id);
        if (route.status !== 'waiting_acquisition') {
          this.recordUnrepairableScene(projectId, scene.id, scene.ordinal, assetId, fileId, route);
        }
      }
      return;
    }

    const decisions = new Map<string, Awaited<ReturnType<FootageVerificationService['verifyScene']>>>();
    for (const scene of scenes) {
      const decision = await this.footageVerification.verifyScene(projectId, scene.id, assetId, fileId);
      decisions.set(scene.id, decision);
      const pendingAlternate = this.db.raw.prepare(`
        SELECT 1 FROM repair_attempts
        WHERE project_id = ? AND scene_id = ? AND replacement_asset_id = ?
          AND status = 'waiting_acquisition'
        LIMIT 1
      `).get(projectId, scene.id, assetId);
      if (
        pendingAlternate
        && (decision.status === 'provider_required' || decision.status === 'error')
      ) {
        this.recordSemanticVerificationBlocker(projectId, scene, assetId, fileId, decision);
      }
    }

    selectedScenes.forEach((scene, index) => {
      const segment = eligible[index % eligible.length];
      if (!segment) return;
      const decision = decisions.get(scene.id);
      if (decision?.status !== 'verified') {
        if (!decision || decision.status === 'provider_required' || decision.status === 'error') {
          this.recordSemanticVerificationBlocker(projectId, scene, assetId, fileId, decision);
          this.db.raw.prepare(`
            UPDATE project_scenes SET verification_state = 'rejected', updated_at = ? WHERE id = ?
          `).run(new Date().toISOString(), scene.id);
          return;
        }
        const route = this.repairs.routeFootageFailure(
          projectId,
          scene.id,
          'SEMANTIC_FOOTAGE_VERIFICATION',
          {
            assetId,
            fileId,
            sceneId: scene.id,
            sceneOrdinal: scene.ordinal,
            verificationId: decision?.id ?? null,
            verificationStatus: decision?.status ?? 'error',
            verificationReasons: decision?.reasons ?? ['No semantic verification decision was produced.']
          }
        );
        if (route.status === 'verified') return;
        this.db.raw.prepare(`
          UPDATE project_scenes SET verification_state = ?, updated_at = ? WHERE id = ?
        `).run(route.status === 'waiting_acquisition' ? 'download_required' : 'rejected', new Date().toISOString(), scene.id);
        return;
      }
      this.db.raw.prepare(`
        UPDATE project_scenes SET
          selected_file_id = ?,
          selected_segment_id = ?,
          target_duration_ms = min(target_duration_ms, ?),
          verification_state = 'verified',
          updated_at = ?
        WHERE id = ?
      `).run(
        fileId,
        segment.id,
        Math.min(7000, segment.durationMs),
        new Date().toISOString(),
        scene.id
      );
    });
  }

  private recordSemanticVerificationBlocker(
    projectId: string,
    scene: { id: string; ordinal: number },
    assetId: string,
    fileId: string,
    decision?: Awaited<ReturnType<FootageVerificationService['verifyScene']>>
  ): void {
    const existing = this.db.raw.prepare(`
      SELECT id FROM exceptions
      WHERE project_id = ? AND status = 'OPEN' AND code = 'SEMANTIC_PROVIDER_REQUIRED'
        AND json_extract(evidence_json, '$.sceneId') = ?
      LIMIT 1
    `).get(projectId, scene.id);
    if (existing) return;
    this.db.raw.prepare(`
      INSERT INTO exceptions(
        id, project_id, severity, stage, code, title, message, evidence_json,
        recommended_action, safe_alternatives_json, status, created_at
      ) VALUES(?, ?, 'BLOCKER', 'media', 'SEMANTIC_PROVIDER_REQUIRED',
        'Footage semantic verification is unavailable',
        'This scene cannot be marked verified without a valid semantic provider result or human-verified scene evidence.',
        ?, 'Configure the semantic vision provider and retry verification, or human-verify the footage/place evidence.',
        ?, 'OPEN', ?)
    `).run(
      randomUUID(),
      projectId,
      JSON.stringify({
        sceneId: scene.id,
        sceneOrdinal: scene.ordinal,
        assetId,
        fileId,
        verificationId: decision?.id ?? null,
        verificationStatus: decision?.status ?? 'error',
        reasons: decision?.reasons ?? ['No semantic verification decision was produced.']
      }),
      JSON.stringify(['Configure provider and retry', 'Human-verify evidence', 'Use a truthful graphic treatment']),
      new Date().toISOString()
    );
  }

  private recordMetadataConflict(
    acquisition: Record<string, unknown>,
    projectId: string,
    assetId: string,
    actual: { width: number; height: number; durationMs: number; rotation: number }
  ): void {
    const declaredWidth = Number(acquisition.declared_width ?? 0);
    const declaredHeight = Number(acquisition.declared_height ?? 0);
    const declaredDurationMs = Number(acquisition.declared_duration_ms ?? 0);
    const resolutionConflict = declaredWidth > 0 && declaredHeight > 0
      && (Math.abs(declaredWidth - actual.width) > 4 || Math.abs(declaredHeight - actual.height) > 4);
    const durationConflict = declaredDurationMs > 0
      && Math.abs(declaredDurationMs - actual.durationMs) > Math.max(1_000, declaredDurationMs * 0.1);
    if (!resolutionConflict && !durationConflict) return;
    this.db.raw.prepare(`
      INSERT INTO exceptions(
        id, project_id, severity, stage, code, title, message, evidence_json,
        recommended_action, status, created_at
      ) VALUES(?, ?, 'HIGH', 'media', 'DECLARED_ACTUAL_METADATA_CONFLICT',
        'Downloaded media differs from catalog metadata',
        'FFprobe metadata is authoritative for rendering; review this catalog asset before reuse.',
        ?, 'Review and correct the catalog metadata or map the intended file.', 'OPEN', ?)
    `).run(randomUUID(), projectId, JSON.stringify({
      assetId,
      declared: { width: declaredWidth || null, height: declaredHeight || null, durationMs: declaredDurationMs || null },
      actual
    }), new Date().toISOString());
  }

  private async attachExisting(acquisitionId: string, assetId: string, projectId: string, fileId: string): Promise<void> {
    const rows = this.db.raw.prepare(`
      SELECT * FROM media_segments WHERE asset_file_id = ? ORDER BY quality_score DESC
    `).all(fileId) as Array<Record<string, unknown>>;
    const segments: MediaSegment[] = rows.map(row => ({
      id: String(row.id),
      assetFileId: String(row.asset_file_id),
      startMs: Number(row.start_ms),
      endMs: Number(row.end_ms),
      durationMs: Number(row.duration_ms),
      qualityScore: Number(row.quality_score),
      blackFrameRisk: Number(row.black_frame_risk),
      freezeRisk: Number(row.freeze_risk),
      effectiveWidth: Number(row.effective_width),
      effectiveHeight: Number(row.effective_height),
      eligible1080p: Boolean(row.eligible_1080p),
      eligible4k: Boolean(row.eligible_4k),
      previewPath: row.preview_path ? String(row.preview_path) : null
    }));
    const now = new Date().toISOString();
    const transaction = this.db.raw.transaction(() => {
      this.db.raw.prepare(`
        UPDATE assets SET local_file_id = ?, updated_at = ? WHERE id = ?
      `).run(fileId, now, assetId);
      this.db.raw.prepare(`
        UPDATE acquisition_items SET state = 'COMPLETE', mapped_file_id = ?,
          mapping_confidence = 1, updated_at = ?, error = NULL
        WHERE id = ?
      `).run(fileId, now, acquisitionId);
    });
    transaction();
    await this.assignSegments(projectId, assetId, fileId, segments);
    this.repairs.reconcileFootageRepairs(projectId);
    await this.updateProjectAfterAcquisition(projectId);
  }

  async verifyLocalAsset(projectId: string, assetId: string, fileId: string): Promise<void> {
    const rows = this.db.raw.prepare(`
      SELECT * FROM media_segments WHERE asset_file_id = ? ORDER BY quality_score DESC, start_ms
    `).all(fileId) as Array<Record<string, unknown>>;
    const segments: MediaSegment[] = rows.map(row => ({
      id: String(row.id),
      assetFileId: String(row.asset_file_id),
      startMs: Number(row.start_ms),
      endMs: Number(row.end_ms),
      durationMs: Number(row.duration_ms),
      qualityScore: Number(row.quality_score),
      blackFrameRisk: Number(row.black_frame_risk),
      freezeRisk: Number(row.freeze_risk),
      effectiveWidth: Number(row.effective_width),
      effectiveHeight: Number(row.effective_height),
      eligible1080p: Boolean(row.eligible_1080p),
      eligible4k: Boolean(row.eligible_4k),
      previewPath: row.preview_path ? String(row.preview_path) : null
    }));
    await this.assignSegments(projectId, assetId, fileId, segments);
    this.repairs.reconcileFootageRepairs(projectId);
    await this.updateProjectAfterAcquisition(projectId);
  }

  async reconcileAcquisition(projectId: string): Promise<void> {
    const project = this.db.raw.prepare('SELECT state FROM projects WHERE id = ?').get(projectId) as
      | { state: import('@shared/types').ProjectState }
      | undefined;
    if (!project || !['WAITING_FOR_DOWNLOADS', 'INGESTING_MEDIA', 'VERIFYING_FOOTAGE', 'BLOCKED_EXCEPTION'].includes(project.state)) return;
    await this.updateProjectAfterAcquisition(projectId);
  }

  async recoverPendingSemanticAlternates(): Promise<number> {
    const rows = this.db.raw.prepare(`
      SELECT DISTINCT r.project_id, r.scene_id, r.replacement_asset_id,
        coalesce(q.mapped_file_id, a.local_file_id) AS file_id
      FROM repair_attempts r
      JOIN assets a ON a.id = r.replacement_asset_id
      LEFT JOIN acquisition_items q
        ON q.project_id = r.project_id AND q.asset_id = r.replacement_asset_id
      WHERE r.status = 'waiting_acquisition'
        AND r.scene_id IS NOT NULL
        AND coalesce(q.mapped_file_id, a.local_file_id) IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM footage_verifications v
          WHERE v.scene_id = r.scene_id
            AND v.asset_file_id = coalesce(q.mapped_file_id, a.local_file_id)
        )
      ORDER BY r.project_id, r.scene_id
    `).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      await this.verifyLocalAsset(
        String(row.project_id),
        String(row.replacement_asset_id),
        String(row.file_id)
      );
    }
    return rows.length;
  }

  async retrySemanticVerification(exceptionId: string): Promise<SemanticVerificationRetryResult> {
    const exception = this.db.raw.prepare(`
      SELECT * FROM exceptions WHERE id = ?
    `).get(exceptionId) as Record<string, unknown> | undefined;
    if (!exception) throw new Error('Semantic verification exception not found.');
    if (exception.code !== 'SEMANTIC_PROVIDER_REQUIRED') {
      throw new Error('Only semantic provider exceptions support this retry action.');
    }
    if (exception.status !== 'OPEN') throw new Error('This semantic verification exception is already closed.');
    const evidence = (() => {
      try {
        const parsed = JSON.parse(String(exception.evidence_json ?? '{}'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : {};
      } catch {
        return {};
      }
    })();
    const projectId = String(exception.project_id ?? '');
    const sceneId = String(evidence.sceneId ?? '');
    const assetId = String(evidence.assetId ?? '');
    const fileId = String(evidence.fileId ?? '');
    if (!projectId || !sceneId || !assetId || !fileId) {
      throw new Error('Semantic verification exception is missing its persisted scene/file evidence.');
    }
    const target = this.db.raw.prepare(`
      SELECT 1
      FROM project_scenes s
      JOIN asset_files f ON f.id = ? AND f.asset_id = ?
      WHERE s.id = ? AND s.project_id = ?
    `).get(fileId, assetId, sceneId, projectId);
    if (!target) throw new Error('The semantic verification target no longer exists.');

    this.progress(projectId, 'semantic-verification-retry', 0.5, 'Retrying semantic footage verification');
    const decision = await this.footageVerification.verifyScene(projectId, sceneId, assetId, fileId);
    let exceptionResolved = false;
    if (decision.status === 'verified') {
      const segment = this.bestEligibleSegment(fileId, projectId);
      if (!segment) throw new Error('Semantic evidence passed, but no technically safe segment remains for this footage.');
      const now = new Date().toISOString();
      this.db.raw.transaction(() => {
        this.db.raw.prepare(`
          UPDATE project_scenes SET selected_file_id = ?, selected_segment_id = ?,
            target_duration_ms = min(target_duration_ms, ?), verification_state = 'verified',
            updated_at = ?
          WHERE id = ? AND project_id = ? AND selected_asset_id = ?
        `).run(fileId, segment.id, Math.min(7000, segment.durationMs), now, sceneId, projectId, assetId);
        this.db.raw.prepare(`
          UPDATE exceptions SET status = 'RESOLVED', resolved_at = ?, resolution_json = ?
          WHERE id = ? AND status = 'OPEN'
        `).run(now, JSON.stringify({ method: 'semantic_verification_retry', verificationId: decision.id }), exceptionId);
        this.db.raw.prepare(`
          INSERT INTO audit_log(
            project_id, action, actor, entity_type, entity_id,
            before_json, after_json, metadata_json, created_at
          ) VALUES(?, 'semantic_verification.retry_succeeded', 'operator', 'scene', ?, ?, ?, ?, ?)
        `).run(
          projectId,
          sceneId,
          JSON.stringify({ verificationState: 'rejected', exceptionStatus: 'OPEN' }),
          JSON.stringify({ verificationState: 'verified', exceptionStatus: 'RESOLVED' }),
          JSON.stringify({ exceptionId, verificationId: decision.id, assetId, fileId }),
          now
        );
      })();
      exceptionResolved = true;
      this.repairs.reconcileFootageRepairs(projectId);
      await this.updateProjectAfterAcquisition(projectId);
    } else if (decision.status !== 'provider_required' && decision.status !== 'error') {
      const activeAlternate = this.db.raw.prepare(`
        SELECT failure_code FROM repair_attempts
        WHERE project_id = ? AND scene_id = ? AND replacement_asset_id = ?
          AND status = 'waiting_acquisition'
        ORDER BY attempt_number DESC LIMIT 1
      `).get(projectId, sceneId, assetId) as { failure_code: string } | undefined;
      const repairEvidence = {
        assetId,
        fileId,
        sceneId,
        verificationId: decision.id,
        verificationStatus: decision.status,
        verificationReasons: decision.reasons,
        trigger: 'operator_retry'
      };
      const route = this.repairs.routeFootageFailure(
        projectId,
        sceneId,
        activeAlternate?.failure_code ?? 'SEMANTIC_FOOTAGE_VERIFICATION',
        repairEvidence
      );
      const now = new Date().toISOString();
      this.db.raw.transaction(() => {
        if (!activeAlternate && route.status !== 'verified') {
          this.db.raw.prepare(`
            UPDATE project_scenes SET verification_state = ?, updated_at = ? WHERE id = ?
          `).run(route.status === 'waiting_acquisition' ? 'download_required' : 'rejected', now, sceneId);
        }
        this.db.raw.prepare(`
          UPDATE exceptions SET status = 'RESOLVED', resolved_at = ?, resolution_json = ?
          WHERE id = ? AND status = 'OPEN'
        `).run(now, JSON.stringify({
          method: 'semantic_provider_responded',
          verificationId: decision.id,
          verificationStatus: decision.status,
          repairAttemptId: route.attemptId
        }), exceptionId);
      })();
      exceptionResolved = true;
      await this.updateProjectAfterAcquisition(projectId);
    } else {
      this.db.raw.prepare(`
        UPDATE exceptions SET evidence_json = ? WHERE id = ?
      `).run(JSON.stringify({
        ...evidence,
        verificationId: decision.id,
        verificationStatus: decision.status,
        reasons: decision.reasons,
        lastRetryAt: new Date().toISOString()
      }), exceptionId);
    }
    const project = this.db.raw.prepare('SELECT state FROM projects WHERE id = ?').get(projectId) as {
      state: SemanticVerificationRetryResult['projectState'];
    };
    this.progress(projectId, 'semantic-verification-retry', 1, exceptionResolved
      ? 'Semantic footage verification passed'
      : 'Semantic footage verification remains blocked');
    return {
      exceptionId,
      projectId,
      sceneId,
      verificationId: decision.id,
      status: decision.status,
      reasons: decision.reasons,
      exceptionResolved,
      projectState: project.state
    };
  }

  private bestEligibleSegment(fileId: string, projectId: string): MediaSegment | null {
    const profile = this.projectOutputDimensions(projectId);
    const rows = this.db.raw.prepare(`
      SELECT * FROM media_segments
      WHERE asset_file_id = ?
        AND black_frame_risk < 0.35 AND freeze_risk < 0.5
      ORDER BY quality_score DESC, start_ms, id
    `).all(fileId) as Array<Record<string, unknown>>;
    const row = rows.find(candidate => {
      return qualifiesOutputPixels(
        Number(candidate.effective_width), Number(candidate.effective_height), profile.width, profile.height
      );
    });
    return row ? {
      id: String(row.id),
      assetFileId: String(row.asset_file_id),
      startMs: Number(row.start_ms),
      endMs: Number(row.end_ms),
      durationMs: Number(row.duration_ms),
      qualityScore: Number(row.quality_score),
      blackFrameRisk: Number(row.black_frame_risk),
      freezeRisk: Number(row.freeze_risk),
      effectiveWidth: Number(row.effective_width),
      effectiveHeight: Number(row.effective_height),
      eligible1080p: Boolean(row.eligible_1080p),
      eligible4k: Boolean(row.eligible_4k),
      previewPath: row.preview_path ? String(row.preview_path) : null
    } : null;
  }

  private projectOutputDimensions(projectId: string): { width: number; height: number } {
    const row = this.db.raw.prepare(`
      SELECT output_profile_snapshot_json FROM projects WHERE id = ?
    `).get(projectId) as { output_profile_snapshot_json: string | null } | undefined;
    try {
      const snapshot = row?.output_profile_snapshot_json
        ? JSON.parse(row.output_profile_snapshot_json) as { width?: number; height?: number }
        : null;
      if (snapshot && Number(snapshot.width) > 0 && Number(snapshot.height) > 0) {
        return { width: Number(snapshot.width), height: Number(snapshot.height) };
      }
    } catch {
      // Legacy project snapshots stay on the safe 1080p landscape default.
    }
    return { width: 1920, height: 1080 };
  }


  private async updateProjectAfterAcquisition(projectId: string): Promise<void> {
    const pending = this.db.raw.prepare(`
      SELECT count(*) AS count FROM acquisition_items
      WHERE project_id = ? AND (
        state NOT IN ('COMPLETE','SKIPPED')
        OR (state <> 'SKIPPED' AND license_state NOT IN (
          'NOT_REQUIRED','OPERATOR_ATTESTED','CERTIFICATE_ATTACHED','VERIFIED'
        ))
      )
    `).get(projectId) as { count: number };
    if (pending.count > 0) {
      const counts = this.db.raw.prepare(`
        SELECT count(*) AS total,
          sum(CASE WHEN state = 'COMPLETE' AND license_state IN (
            'NOT_REQUIRED','OPERATOR_ATTESTED','CERTIFICATE_ATTACHED','VERIFIED'
          ) THEN 1 ELSE 0 END) AS complete
        FROM acquisition_items WHERE project_id = ?
      `).get(projectId) as { total: number; complete: number | null };
      const progress = 0.27 + 0.25 * (Number(counts.complete ?? 0) / Math.max(1, counts.total));
      const state = this.db.raw.prepare('SELECT state FROM projects WHERE id = ?').get(projectId) as { state: import('@shared/types').ProjectState };
      if (state.state === 'BLOCKED_EXCEPTION') {
        this.projectStates.resume(projectId, 'Semantic provider prerequisite cleared; pending acquisitions remain', 'WAITING_FOR_DOWNLOADS');
      } else if (state.state === 'INGESTING_MEDIA') {
        this.projectStates.transition(projectId, 'WAITING_FOR_DOWNLOADS', {
          progress,
          reason: 'Additional mandatory acquisition files are still pending',
          prerequisites: { pending: pending.count }
        });
      } else {
        this.db.raw.prepare('UPDATE projects SET progress = ?, updated_at = ? WHERE id = ?')
          .run(progress, new Date().toISOString(), projectId);
      }
      return;
    }

    const unresolved = this.db.raw.prepare(`
      SELECT
        sum(CASE WHEN verification_state = 'rejected' THEN 1 ELSE 0 END) AS rejected,
        sum(CASE WHEN verification_state NOT IN ('verified','graphic') THEN 1 ELSE 0 END) AS unresolved
      FROM project_scenes WHERE project_id = ?
    `).get(projectId) as { rejected: number | null; unresolved: number | null };
    const rejectedCount = Number(unresolved.rejected ?? 0);
    const unresolvedCount = Number(unresolved.unresolved ?? 0);
    const providerBlockers = this.db.raw.prepare(`
      SELECT count(*) AS count FROM exceptions
      WHERE project_id = ? AND status = 'OPEN' AND code = 'SEMANTIC_PROVIDER_REQUIRED'
    `).get(projectId) as { count: number };
    const providerBlockerCount = Number(providerBlockers.count ?? 0);
    const waitingRepair = unresolvedCount > 0 && rejectedCount === 0 && providerBlockerCount === 0;
    const current = this.db.raw.prepare('SELECT state FROM projects WHERE id = ?').get(projectId) as { state: import('@shared/types').ProjectState };
    if (current.state === 'BLOCKED_EXCEPTION' && providerBlockerCount === 0) {
      this.projectStates.resume(projectId, 'Previously blocked footage evidence is ready for verification', 'VERIFYING_FOOTAGE');
    } else if (current.state === 'WAITING_FOR_DOWNLOADS') {
      this.projectStates.transition(projectId, 'INGESTING_MEDIA', {
        progress: 0.48,
        reason: 'All mandatory acquisition files are mapped and ingested'
      });
    }
    this.projectStates.transition(projectId, 'VERIFYING_FOOTAGE', {
      progress: 0.5,
      reason: 'All ingested footage has technical and location candidates'
    });
    this.projectStates.transition(
      projectId,
      unresolvedCount ? (waitingRepair ? 'WAITING_FOR_DOWNLOADS' : 'BLOCKED_EXCEPTION') : 'FINALIZING_SCRIPT',
      {
        progress: unresolvedCount ? 0.5 : 0.53,
        reason: waitingRepair
          ? 'A verified alternate was queued for failed footage'
          : providerBlockerCount
            ? 'Semantic verification requires a configured and responsive provider'
          : rejectedCount
            ? 'One or more scenes exhausted safe footage repair'
            : 'Every scene has a verified visual treatment',
        prerequisites: {
          rejectedScenes: rejectedCount,
          unresolvedScenes: unresolvedCount,
          semanticProviderBlockers: providerBlockerCount
        }
      }
    );
    if (!unresolvedCount) {
      await this.finalizeProduction(projectId);
    }
  }

  private recordUnrepairableScene(
    projectId: string,
    sceneId: string,
    sceneOrdinal: number,
    assetId: string,
    fileId: string,
    route: { status: string; attemptId: string | null; replacementAssetId: string | null }
  ): void {
    const existing = this.db.raw.prepare(`
      SELECT id FROM exceptions
      WHERE project_id = ? AND status = 'OPEN' AND stage = 'media'
        AND code = 'NO_SAFE_FOOTAGE_ALTERNATE'
        AND json_extract(evidence_json, '$.sceneId') = ?
      LIMIT 1
    `).get(projectId, sceneId);
    if (existing) return;
    this.db.raw.prepare(`
      INSERT INTO exceptions(
        id, project_id, severity, stage, code, title, message, evidence_json,
        recommended_action, safe_alternatives_json, status, created_at
      ) VALUES(?, ?, 'BLOCKER', 'media', 'NO_SAFE_FOOTAGE_ALTERNATE',
        'No safe footage alternate remains',
        'The source failed technical verification and bounded alternate selection could not produce verified replacement footage.',
        ?, 'Acquire a new exact-location candidate, use a truthful inset/graphic treatment, or rewrite the affected beat.',
        ?, 'OPEN', ?)
    `).run(
      randomUUID(),
      projectId,
      JSON.stringify({ sceneId, sceneOrdinal, assetId, fileId, repairAttemptId: route.attemptId }),
      JSON.stringify(['Acquire exact-location alternate', 'Use non-upscaled graphic treatment', 'Rewrite affected narration beat']),
      new Date().toISOString()
    );
  }
}
