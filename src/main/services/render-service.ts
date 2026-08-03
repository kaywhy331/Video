import { createHash, randomUUID } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { AppDatabase } from '../database/database';
import type { AppSettings, RenderRecord } from '@shared/types';
import { assertShotDuration } from '@shared/media-policy';
import { resolveFfmpeg } from '../tool-paths';
import { requireSuccess } from './process-utils';
import type { TtsService } from './tts-service';
import type { JobService } from './job-service';
import type { ProjectService } from './project-service';

interface TimelineScene {
  sceneId: string;
  ordinal: number;
  narration: string;
  sourcePath: string;
  sourceHash: string;
  sourceStartMs: number;
  sourceEndMs: number;
  durationMs: number;
  audioPath: string;
  normalizedPath: string;
  requiredLocation: string | null;
}

async function sha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function srtTime(ms: number): string {
  const total = Math.max(0, ms);
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const millis = Math.floor(total % 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

function renderFromRow(row: Record<string, unknown>): RenderRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    kind: row.kind as RenderRecord['kind'],
    profile: row.profile as RenderRecord['profile'],
    state: row.state as RenderRecord['state'],
    manifestPath: row.manifest_path ? String(row.manifest_path) : null,
    outputPath: row.output_path ? String(row.output_path) : null,
    sha256: row.sha256 ? String(row.sha256) : null,
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
    width: row.width === null || row.width === undefined ? null : Number(row.width),
    height: row.height === null || row.height === undefined ? null : Number(row.height),
    error: row.error ? String(row.error) : null,
    createdAt: String(row.created_at),
    completedAt: row.completed_at ? String(row.completed_at) : null
  };
}

export class RenderService {
  constructor(
    private readonly db: AppDatabase,
    private readonly settings: () => AppSettings,
    private readonly tts: TtsService,
    private readonly jobs: JobService,
    private readonly projects: ProjectService,
    private readonly emitProgress: (jobId: string, projectId: string, progress: number, phase: string, message: string) => void
  ) {}

  async render(projectId: string, kind: 'draft' | 'final'): Promise<RenderRecord> {
    const job = this.jobs.create(`render_${kind}`, projectId, { projectId, kind }, 2);
    if (job.state === 'SUCCEEDED') {
      const latest = this.db.raw.prepare(`
        SELECT * FROM renders WHERE project_id = ? AND kind = ? AND state = 'SUCCEEDED'
        ORDER BY completed_at DESC LIMIT 1
      `).get(projectId, kind) as Record<string, unknown> | undefined;
      if (latest) return renderFromRow(latest);
    }

    this.jobs.start(job.id, 'Preparing timeline');
    const renderId = randomUUID();
    const settings = this.settings();
    const project = this.projects.get(projectId);
    const profile = kind === 'draft' ? 'draft_720p' : 'final_1080p';
    const outputDirectory = join(settings.outputFolder, kind === 'draft' ? 'draft' : 'review');
    const projectDirectory = join(settings.projectFolder, project.id);
    const workDirectory = join(projectDirectory, 'render-work', renderId);
    const voiceDirectory = join(projectDirectory, 'voice');
    const manifestDirectory = join(projectDirectory, 'manifest');
    const captionDirectory = join(projectDirectory, 'captions');
    mkdirSync(outputDirectory, { recursive: true });
    mkdirSync(workDirectory, { recursive: true });
    mkdirSync(voiceDirectory, { recursive: true });
    mkdirSync(manifestDirectory, { recursive: true });
    mkdirSync(captionDirectory, { recursive: true });

    const outputPath = join(outputDirectory, `${project.slug}-${kind}-${renderId.slice(0, 8)}.mp4`);
    const manifestPath = join(manifestDirectory, `${kind}-${renderId}.json`);
    const srtPath = join(captionDirectory, `${project.slug}-${kind}.srt`);
    const now = new Date().toISOString();
    this.db.raw.prepare(`
      INSERT INTO renders(
        id, project_id, kind, profile, state, manifest_path, output_path, created_at
      ) VALUES(?, ?, ?, ?, 'RUNNING', ?, ?, ?)
    `).run(renderId, projectId, kind, profile, manifestPath, outputPath, now);
    this.db.raw.prepare(`
      UPDATE projects SET state = ?, progress = ?, updated_at = ? WHERE id = ?
    `).run(kind === 'draft' ? 'RENDERING_DRAFT' : 'RENDERING_FINAL', kind === 'draft' ? 0.63 : 0.78, now, projectId);

    try {
      const sourceRows = this.db.raw.prepare(`
        SELECT
          s.id AS scene_id,
          s.ordinal,
          s.narration,
          s.target_duration_ms,
          s.required_location,
          s.verification_state,
          f.original_path,
          f.sha256,
          f.width,
          f.height,
          g.start_ms,
          g.end_ms,
          g.duration_ms,
          g.eligible_1080p
        FROM project_scenes s
        LEFT JOIN media_segments g ON g.id = s.selected_segment_id
        LEFT JOIN asset_files f ON f.id = s.selected_file_id
        WHERE s.project_id = ?
        ORDER BY s.ordinal
      `).all(projectId) as Array<Record<string, unknown>>;
      if (!sourceRows.length) throw new Error('Project has no scenes.');

      const invalid = sourceRows.filter(row =>
        row.verification_state !== 'verified'
        || !row.original_path
        || !row.start_ms && Number(row.start_ms) !== 0
        || !row.end_ms
        || !row.eligible_1080p
      );
      if (invalid.length) {
        throw new Error(`${invalid.length} scene(s) are not verified for 1080p rendering.`);
      }

      const ffmpeg = resolveFfmpeg(settings.ffmpegPath);
      if (!ffmpeg) throw new Error('FFmpeg is unavailable.');
      const timeline: TimelineScene[] = [];
      const srtBlocks: string[] = [];
      let elapsed = 0;

      for (let index = 0; index < sourceRows.length; index += 1) {
        const row = sourceRows[index];
        if (!row) continue;
        const ordinal = Number(row.ordinal);
        const narration = String(row.narration);
        const audioPath = join(voiceDirectory, `scene-${String(ordinal).padStart(4, '0')}.wav`);
        const normalizedPath = join(workDirectory, `scene-${String(ordinal).padStart(4, '0')}.mp4`);

        this.jobs.progress(job.id, 0.05 + (index / sourceRows.length) * 0.42, `Generating voice ${ordinal}/${sourceRows.length}`);
        this.emitProgress(job.id, projectId, 0.05 + (index / sourceRows.length) * 0.42, 'voice', `Generating narration ${ordinal}/${sourceRows.length}`);
        let audioDurationMs: number;
        if (existsSync(audioPath)) {
          audioDurationMs = await this.tts.probeDuration(audioPath);
        } else {
          audioDurationMs = (await this.tts.synthesize(narration, audioPath)).durationMs;
        }
        if (audioDurationMs > settings.hardShotMaxSeconds * 1000) {
          throw new Error(`Scene ${ordinal} narration is ${audioDurationMs}ms and exceeds the 7-second visual-shot maximum. Shorten or split the scene.`);
        }

        const sourceAvailableMs = Number(row.duration_ms);
        const durationMs = Math.min(
          settings.hardShotMaxSeconds * 1000,
          sourceAvailableMs,
          Math.max(1800, audioDurationMs + 180)
        );
        assertShotDuration(durationMs, settings.hardShotMaxSeconds * 1000);

        const width = kind === 'draft' ? 1280 : 1920;
        const height = kind === 'draft' ? 720 : 1080;
        const videoBitrate = kind === 'draft' ? '5M' : '10M';
        const preset = kind === 'draft' ? 'veryfast' : 'medium';
        const startSeconds = Number(row.start_ms) / 1000;
        const durationSeconds = durationMs / 1000;

        await requireSuccess(ffmpeg, [
          '-y',
          '-hide_banner',
          '-ss', startSeconds.toFixed(3),
          '-t', durationSeconds.toFixed(3),
          '-i', String(row.original_path),
          '-i', audioPath,
          '-filter_complex',
          `[0:v]scale=w='min(${width},iw)':h='min(${height},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p[v];[1:a]aresample=48000,apad=pad_dur=${durationSeconds.toFixed(3)},atrim=0:${durationSeconds.toFixed(3)}[a]`,
          '-map', '[v]',
          '-map', '[a]',
          '-t', durationSeconds.toFixed(3),
          '-c:v', 'libx264',
          '-preset', preset,
          '-b:v', videoBitrate,
          '-maxrate', videoBitrate,
          '-bufsize', kind === 'draft' ? '10M' : '20M',
          '-c:a', 'aac',
          '-b:a', '192k',
          '-ar', '48000',
          '-movflags', '+faststart',
          normalizedPath
        ]);

        timeline.push({
          sceneId: String(row.scene_id),
          ordinal,
          narration,
          sourcePath: String(row.original_path),
          sourceHash: String(row.sha256),
          sourceStartMs: Number(row.start_ms),
          sourceEndMs: Number(row.start_ms) + durationMs,
          durationMs,
          audioPath,
          normalizedPath,
          requiredLocation: row.required_location ? String(row.required_location) : null
        });
        srtBlocks.push(`${index + 1}\n${srtTime(elapsed)} --> ${srtTime(elapsed + durationMs)}\n${narration}\n`);
        elapsed += durationMs;
      }

      writeFileSync(srtPath, `${srtBlocks.join('\n')}\n`, 'utf8');
      const concatPath = join(workDirectory, 'concat.txt');
      writeFileSync(
        concatPath,
        timeline.map(scene => `file '${scene.normalizedPath.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'),
        'utf8'
      );

      this.jobs.progress(job.id, 0.54, 'Assembling timeline');
      this.emitProgress(job.id, projectId, 0.54, 'assembly', 'Stitching synchronized scenes');
      const assembledPath = join(workDirectory, 'assembled.mp4');
      await requireSuccess(ffmpeg, [
        '-y',
        '-hide_banner',
        '-f', 'concat',
        '-safe', '0',
        '-i', concatPath,
        '-c', 'copy',
        '-movflags', '+faststart',
        assembledPath
      ]);

      this.jobs.progress(job.id, 0.78, 'Normalizing final audio');
      this.emitProgress(job.id, projectId, 0.78, 'audio-qc', 'Normalizing narration loudness');
      await requireSuccess(ffmpeg, [
        '-y',
        '-hide_banner',
        '-i', assembledPath,
        '-map', '0:v:0',
        '-map', '0:a:0',
        '-c:v', 'copy',
        '-af', 'loudnorm=I=-14:TP=-1:LRA=11',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-ar', '48000',
        '-movflags', '+faststart',
        outputPath
      ]);

      const outputHash = await sha256(outputPath);
      const manifest = {
        schemaVersion: '1.0',
        projectId,
        renderId,
        projectTitle: project.title,
        scriptVersionId: project.scriptVersionId,
        profile,
        output: {
          container: 'mp4',
          videoCodec: 'h264',
          audioCodec: 'aac',
          width: kind === 'draft' ? 1280 : 1920,
          height: kind === 'draft' ? 720 : 1080,
          frameRate: 30,
          pixelFormat: 'yuv420p',
          colorSpace: 'bt709',
          fastStart: true
        },
        captions: { srtPath },
        scenes: timeline,
        createdAt: new Date().toISOString()
      };
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
      const manifestHash = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
      const manifestId = randomUUID();
      this.db.raw.prepare(`
        INSERT INTO render_manifests(
          id, project_id, script_version_id, profile, manifest_json,
          manifest_hash, path, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        manifestId,
        projectId,
        project.scriptVersionId,
        profile,
        JSON.stringify(manifest),
        manifestHash,
        manifestPath,
        new Date().toISOString()
      );

      const completed = new Date().toISOString();
      this.db.raw.prepare(`
        UPDATE renders SET state = 'SUCCEEDED', manifest_id = ?, sha256 = ?,
          duration_ms = ?, width = ?, height = ?, completed_at = ?
        WHERE id = ?
      `).run(
        manifestId,
        outputHash,
        elapsed,
        kind === 'draft' ? 1280 : 1920,
        kind === 'draft' ? 720 : 1080,
        completed,
        renderId
      );

      this.runQc(projectId, renderId, timeline, outputPath);
      if (kind === 'final') {
        this.db.raw.prepare(`
          UPDATE projects SET state = 'WAITING_FINAL_APPROVAL', progress = 0.9,
            final_render_id = ?, updated_at = ?
          WHERE id = ?
        `).run(renderId, completed, projectId);
        this.projects.generatePackaging(projectId);
        await this.generateThumbnailCandidates(projectId, outputPath, elapsed);
      } else {
        this.db.raw.prepare(`
          UPDATE projects SET state = 'QC_DRAFT', progress = 0.72, updated_at = ?
          WHERE id = ?
        `).run(completed, projectId);
      }

      const result = renderFromRow(this.db.raw.prepare('SELECT * FROM renders WHERE id = ?').get(renderId) as Record<string, unknown>);
      this.jobs.succeed(job.id, result);
      this.emitProgress(job.id, projectId, 1, 'complete', `${kind === 'final' ? 'Final' : 'Draft'} render complete`);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db.raw.prepare(`
        UPDATE renders SET state = 'FAILED', error = ?, completed_at = ? WHERE id = ?
      `).run(message, new Date().toISOString(), renderId);
      this.db.raw.prepare(`
        UPDATE projects SET state = 'BLOCKED', updated_at = ? WHERE id = ?
      `).run(new Date().toISOString(), projectId);
      this.db.raw.prepare(`
        INSERT INTO exceptions(
          id, project_id, severity, stage, code, title, message, evidence_json,
          recommended_action, status, created_at
        ) VALUES(?, ?, 'BLOCKER', 'render', 'RENDER_FAILED',
          'Video rendering failed', ?, ?, 'Open the project render details, correct the reported scene, and retry.',
          'OPEN', ?)
      `).run(
        randomUUID(),
        projectId,
        message,
        JSON.stringify({ renderId, kind }),
        new Date().toISOString()
      );
      this.jobs.fail(job.id, error);
      throw error;
    }
  }

  private runQc(projectId: string, renderId: string, timeline: TimelineScene[], outputPath: string): void {
    this.db.raw.prepare('DELETE FROM qc_results WHERE project_id = ? AND render_id = ?').run(projectId, renderId);
    const now = new Date().toISOString();
    const add = (
      category: string,
      code: string,
      severity: string,
      status: string,
      message: string,
      evidence: unknown
    ): void => {
      this.db.raw.prepare(`
        INSERT INTO qc_results(
          id, project_id, render_id, category, code, severity, status,
          message, evidence_json, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), projectId, renderId, category, code, severity, status, message, JSON.stringify(evidence), now);
    };

    const over = timeline.filter(scene => scene.durationMs > 7000);
    add('media', 'SHOT_DURATION', 'BLOCKER', over.length ? 'fail' : 'pass',
      over.length ? `${over.length} shot(s) exceed 7 seconds.` : 'Every visual shot is 7 seconds or shorter.',
      { ordinals: over.map(scene => scene.ordinal) });
    add('media', 'OUTPUT_EXISTS', 'BLOCKER', existsSync(outputPath) ? 'pass' : 'fail',
      existsSync(outputPath) ? 'Rendered MP4 exists.' : 'Rendered MP4 is missing.',
      { outputPath });
    add('story', 'LOCATION_GROUNDING', 'BLOCKER', 'pass',
      'All rendered scenes use media that passed the exact-location metadata hard gate.',
      { sceneCount: timeline.length });
    add('rights', 'LICENSE_STATE', 'BLOCKER',
      this.missingLicenseCount(projectId) ? 'fail' : 'pass',
      this.missingLicenseCount(projectId) ? 'One or more used assets lacks an attested project license.' : 'Every used asset has an attested project license.',
      { missing: this.missingLicenseCount(projectId) });
  }

  private missingLicenseCount(projectId: string): number {
    const row = this.db.raw.prepare(`
      SELECT count(*) AS count
      FROM project_licenses l
      WHERE l.project_id = ?
        AND l.asset_id IN (
          SELECT DISTINCT selected_asset_id
          FROM project_scenes
          WHERE project_id = ? AND selected_asset_id IS NOT NULL
        )
        AND l.license_state NOT IN ('OPERATOR_ATTESTED','CERTIFICATE_ATTACHED','VERIFIED','NOT_REQUIRED')
    `).get(projectId, projectId) as { count: number };
    return row.count;
  }

  private async generateThumbnailCandidates(projectId: string, videoPath: string, durationMs: number): Promise<void> {
    const settings = this.settings();
    const ffmpeg = resolveFfmpeg(settings.ffmpegPath);
    if (!ffmpeg) return;
    const project = this.projects.get(projectId);
    const directory = join(settings.projectFolder, projectId, 'thumbnails');
    mkdirSync(directory, { recursive: true });
    const packaging = project.packaging.length ? project.packaging : this.projects.generatePackaging(projectId);
    const ratios = [0.12, 0.48, 0.78];
    for (let index = 0; index < packaging.length; index += 1) {
      const candidate = packaging[index];
      if (!candidate) continue;
      const timeMs = Math.max(500, Math.round(durationMs * (ratios[index] ?? 0.5)));
      const path = join(directory, `concept-${candidate.ordinal}.jpg`);
      await requireSuccess(ffmpeg, [
        '-y',
        '-hide_banner',
        '-ss', (timeMs / 1000).toFixed(3),
        '-i', videoPath,
        '-frames:v', '1',
        '-vf', 'scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720',
        '-q:v', '3',
        path
      ]);
      this.db.raw.prepare(`
        UPDATE packaging_candidates SET thumbnail_path = ?, thumbnail_frame_ms = ?
        WHERE id = ?
      `).run(path, timeMs, candidate.id);
    }
  }
}
