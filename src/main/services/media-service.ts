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
import type { AppSettings, AssetFile, MediaSegment } from '@shared/types';
import { calculateEffectiveResolution, generateSlidingWindows } from '@shared/media-policy';
import {
  intervalCoverage,
  normalizedRotation,
  parseBlackIntervals,
  parseFreezeIntervals,
  type TimeInterval
} from '@shared/media-analysis';
import { resolveFfmpeg, resolveFfprobe } from '../tool-paths';
import { requireSuccess, runProcess } from './process-utils';
import { ProjectStateService } from './project-state-service';

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
    audioPresent: Boolean(row.audio_present),
    createdAt: String(row.created_at)
  };
}

export class MediaService {
  static readonly PIPELINE_VERSION = 'media-v1';

  constructor(
    private readonly db: AppDatabase,
    private readonly settings: () => AppSettings,
    private readonly progress: (projectId: string | null, phase: string, progress: number, message: string) => void
  ) {
    this.projectStates = new ProjectStateService(db);
  }

  private readonly projectStates: ProjectStateService;

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
    audioPresent: boolean
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
      "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,fps=30,format=yuv420p",
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '24',
      ...(audioPresent ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']),
      '-movflags', '+faststart',
      proxyPath
    ];
    await requireSuccess(ffmpeg, args);
  }

  private async createContactSheet(originalPath: string, contactSheetPath: string): Promise<void> {
    const ffmpeg = resolveFfmpeg(this.settings().ffmpegPath);
    if (!ffmpeg) throw new Error('FFmpeg is not configured or bundled.');
    mkdirSync(dirname(contactSheetPath), { recursive: true });
    await requireSuccess(ffmpeg, [
      '-y',
      '-hide_banner',
      '-i', originalPath,
      '-vf', "fps=1/4,scale=320:-1:force_original_aspect_ratio=decrease,tile=4x3:padding=6:margin=6",
      '-frames:v', '1',
      contactSheetPath
    ]);
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
      const file = toAssetFile(existing);
      const expectedAssetId = String(existing.asset_id);
      if (expectedAssetId !== assetId) {
        const quarantinePath = join(settings.mediaLibraryFolder, 'quarantine', `${sha256.slice(0, 12)}-${basename(detectedPath)}`);
        movePreservingBytes(detectedPath, quarantinePath);
        throw new Error(`This physical file is already assigned to a different catalog asset and was quarantined at ${quarantinePath}.`);
      }
      if (existsSync(detectedPath)) unlinkSync(detectedPath);
      this.attachExisting(acquisitionId, assetId, projectId, file.id);
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
    movePreservingBytes(detectedPath, originalPath);
    const preservedHash = await hashFile(originalPath);
    if (preservedHash !== sha256) throw new Error('Original file hash changed during centralization.');
    const fileId = randomUUID();
    const proxyPath = join(settings.mediaLibraryFolder, 'proxies', sha256.slice(0, 2), `${sha256}.mp4`);
    const contactSheetPath = join(settings.mediaLibraryFolder, 'keyframes', sha256.slice(0, 2), `${sha256}-contact.jpg`);

    this.progress(projectId, 'proxy', 0.34, 'Creating 720p planning proxy');
    await this.createProxy(originalPath, proxyPath, audio);
    this.progress(projectId, 'contact-sheet', 0.52, 'Extracting representative frames');
    try {
      await this.createContactSheet(originalPath, contactSheetPath);
    } catch {
      // The proxy remains useful even if a highly unusual source prevents a contact sheet.
    }

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
          frame_rate, codec, pixel_format, color_space, audio_present,
          raw_ffprobe_json, pipeline_version, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      this.db.raw.prepare(`
        UPDATE project_licenses SET license_state = 'OPERATOR_ATTESTED',
          operator_attested_at = COALESCE(operator_attested_at, ?), updated_at = ?
        WHERE project_id = ? AND asset_id = ?
      `).run(now, now, projectId, assetId);
      this.assignSegments(projectId, assetId, fileId, segments);
      this.recordMetadataConflict(acquisition, projectId, assetId, {
        width: videoWidth,
        height: videoHeight,
        durationMs,
        rotation
      });
    });
    transaction();
    this.progress(projectId, 'verified', 0.9, 'Footage ingested and candidate segments created');
    this.updateProjectAfterAcquisition(projectId);
    return toAssetFile(this.db.raw.prepare('SELECT * FROM asset_files WHERE id = ?').get(fileId) as Record<string, unknown>);
  }

  private assignSegments(
    projectId: string,
    assetId: string,
    fileId: string,
    segments: MediaSegment[]
  ): void {
    const scenes = this.db.raw.prepare(`
      SELECT id, ordinal FROM project_scenes
      WHERE project_id = ? AND selected_asset_id = ?
      ORDER BY ordinal
    `).all(projectId, assetId) as Array<{ id: string; ordinal: number }>;
    const eligible = segments.filter(segment =>
      segment.eligible1080p && segment.blackFrameRisk < 0.35 && segment.freezeRisk < 0.5
    );
    if (!eligible.length) {
      this.db.raw.prepare(`
        UPDATE project_scenes SET verification_state = 'rejected', updated_at = ?
        WHERE project_id = ? AND selected_asset_id = ?
      `).run(new Date().toISOString(), projectId, assetId);
      this.db.raw.prepare(`
        INSERT INTO exceptions(
          id, project_id, severity, stage, code, title, message, evidence_json,
          recommended_action, status, created_at
        ) VALUES(?, ?, 'BLOCKER', 'media', 'NO_UPSCALE_BLOCK',
          'Source cannot fill 1080p without upscaling',
          'Downloaded footage has no segment that satisfies effective 1080p, black-frame, and freeze limits.',
          ?, 'Acquire a higher-resolution alternative or use the source as an inset graphic.',
          'OPEN', ?)
      `).run(
        randomUUID(),
        projectId,
        JSON.stringify({ assetId, fileId }),
        new Date().toISOString()
      );
      return;
    }

    scenes.forEach((scene, index) => {
      const segment = eligible[index % eligible.length];
      if (!segment) return;
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

  private attachExisting(acquisitionId: string, assetId: string, projectId: string, fileId: string): void {
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
      this.assignSegments(projectId, assetId, fileId, segments);
    });
    transaction();
    this.updateProjectAfterAcquisition(projectId);
  }

  private updateProjectAfterAcquisition(projectId: string): void {
    const pending = this.db.raw.prepare(`
      SELECT count(*) AS count FROM acquisition_items
      WHERE project_id = ? AND state NOT IN ('COMPLETE','SKIPPED')
    `).get(projectId) as { count: number };
    if (pending.count > 0) {
      const counts = this.db.raw.prepare(`
        SELECT count(*) AS total,
          sum(CASE WHEN state = 'COMPLETE' THEN 1 ELSE 0 END) AS complete
        FROM acquisition_items WHERE project_id = ?
      `).get(projectId) as { total: number; complete: number | null };
      const progress = 0.27 + 0.25 * (Number(counts.complete ?? 0) / Math.max(1, counts.total));
      const state = this.db.raw.prepare('SELECT state FROM projects WHERE id = ?').get(projectId) as { state: import('@shared/types').ProjectState };
      if (state.state === 'INGESTING_MEDIA') {
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

    const rejected = this.db.raw.prepare(`
      SELECT count(*) AS count FROM project_scenes
      WHERE project_id = ? AND verification_state = 'rejected'
    `).get(projectId) as { count: number };
    const current = this.db.raw.prepare('SELECT state FROM projects WHERE id = ?').get(projectId) as { state: import('@shared/types').ProjectState };
    if (current.state === 'WAITING_FOR_DOWNLOADS') {
      this.projectStates.transition(projectId, 'INGESTING_MEDIA', {
        progress: 0.48,
        reason: 'All mandatory acquisition files are mapped and ingested'
      });
    }
    this.projectStates.transition(projectId, 'VERIFYING_FOOTAGE', {
      progress: 0.5,
      reason: 'All ingested footage has technical and location candidates'
    });
    this.projectStates.transition(projectId, rejected.count ? 'BLOCKED_EXCEPTION' : 'FINALIZING_SCRIPT', {
      progress: rejected.count ? 0.5 : 0.53,
      reason: rejected.count ? 'One or more scenes failed footage verification' : 'Every scene has a verified visual treatment',
      prerequisites: { rejectedScenes: rejected.count }
    });
    if (!rejected.count) {
      this.projectStates.transition(projectId, 'GENERATING_VOICE', {
        progress: 0.54,
        reason: 'Metadata-grounded final script locked for narration'
      });
      this.projectStates.transition(projectId, 'BUILDING_TIMELINE', {
        progress: 0.55,
        reason: 'Verified scenes are ready for narration and timeline assembly'
      });
    }
  }
}
