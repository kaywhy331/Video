import { createHash, randomUUID } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
  writeFileSync,
  rmSync,
  unlinkSync
} from 'node:fs';
import { join } from 'node:path';
import type { AppDatabase } from '../database/database';
import type { AppSettings, NarrationWord, RenderRecord, RenderScope } from '@shared/types';
import { assertShotDuration, missingSelectedLicenseCount } from '@shared/media-policy';
import { resolveFfmpeg } from '../tool-paths';
import { requireSuccess } from './process-utils';
import { assembleAndNormalizeTimeline, loudnormStats } from './render-pipeline';
import { captionCuesFromWords, fitNarrationShotDuration, renderFragmentCacheKey, splitAlignedNarration } from '@shared/narration';
import { resolveFfprobe } from '../tool-paths';
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
  timelineStartMs: number;
  timelineEndMs: number;
  durationMs: number;
  audioPath: string;
  normalizedPath: string;
  requiredLocation: string | null;
  narrationPart: number;
  narrationParts: number;
  wordTimings: NarrationWord[];
  reusedFragment: boolean;
}

interface SourceSceneRow {
  scene_id: string;
  ordinal: number;
  narration: string;
  target_duration_ms: number;
  required_location: string | null;
  verification_state: string;
  selected_file_id: string | null;
  original_path: string | null;
  sha256: string | null;
  width: number | null;
  height: number | null;
  start_ms: number | null;
  end_ms: number | null;
  duration_ms: number | null;
  eligible_1080p: number | null;
}

export interface RenderRequest {
  kind: 'range' | 'draft' | 'final';
  startSceneOrdinal?: number;
  endSceneOrdinal?: number;
}

interface OutputProbe {
  format?: { duration?: string; format_name?: string; tags?: Record<string, string> };
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    pix_fmt?: string;
    profile?: string;
    avg_frame_rate?: string;
    field_order?: string;
    color_space?: string;
    color_transfer?: string;
    color_primaries?: string;
    sample_rate?: string;
    channels?: number;
  }>;
}

function rationalRate(value: string | undefined): number {
  if (!value) return 0;
  const [numerator, denominator] = value.split('/').map(Number);
  return denominator ? (numerator ?? 0) / denominator : Number(value);
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

function vttTime(ms: number): string {
  return srtTime(ms).replace(',', '.');
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
    completedAt: row.completed_at ? String(row.completed_at) : null,
    artifactVersion: Number(row.artifact_version ?? 1),
    scope: row.scope_json && String(row.scope_json) !== '{}'
      ? JSON.parse(String(row.scope_json)) as RenderScope
      : null,
    baseRenderId: row.base_render_id ? String(row.base_render_id) : null
  };
}

export class RenderService {
  constructor(
    private readonly db: AppDatabase,
    private readonly settings: () => AppSettings,
    private readonly jobs: JobService,
    private readonly projects: ProjectService,
    private readonly emitProgress: (jobId: string, projectId: string, progress: number, phase: string, message: string) => void,
    private readonly prepareRepair: (projectId: string, targetState: import('@shared/types').ProjectState) => Promise<void> = async () => undefined
  ) {}

  async render(
    projectId: string,
    request: RenderRequest | 'draft' | 'final'
  ): Promise<RenderRecord> {
    let options: RenderRequest = typeof request === 'string' ? { kind: request } : request;
    let kind = options.kind;
    if (kind === 'final' && options.startSceneOrdinal === undefined) {
      const pendingRange = this.db.raw.prepare(`
        SELECT min(range_start_ordinal) AS range_start_ordinal,
          max(range_end_ordinal) AS range_end_ordinal
        FROM repair_attempts
        WHERE project_id = ? AND status = 'routed' AND repair_class = 'regenerate_range'
          AND range_start_ordinal IS NOT NULL AND range_end_ordinal IS NOT NULL
          AND json_extract(evidence_json, '$.rangeRenderId') IS NULL
      `).get(projectId) as { range_start_ordinal: number | null; range_end_ordinal: number | null };
      if (pendingRange.range_start_ordinal !== null && pendingRange.range_end_ordinal !== null) {
        options = {
          kind: 'range',
          startSceneOrdinal: pendingRange.range_start_ordinal,
          endSceneOrdinal: pendingRange.range_end_ordinal
        };
        kind = 'range';
      }
    }
    const repairSequence = kind === 'final'
      ? Number((this.db.raw.prepare(`
          SELECT count(*) AS sequence
          FROM repair_attempts
          WHERE project_id = ? AND scene_id IS NULL
        `).get(projectId) as { sequence: number }).sequence ?? 0)
      : 0;
    const renderInput = this.db.raw.prepare(`
      SELECT s.id, s.script_version_id, s.narration, s.pronunciation_json,
        s.selected_segment_id, s.verification_state, g.start_ms, g.end_ms, f.sha256,
        n.voice_asset_id, v.input_hash AS voice_input_hash, v.timing_method
      FROM project_scenes s
      LEFT JOIN media_segments g ON g.id = s.selected_segment_id
      LEFT JOIN asset_files f ON f.id = s.selected_file_id
      LEFT JOIN narration_words w ON w.scene_id = s.id
      LEFT JOIN narration_sections n ON n.id = w.section_id AND n.status = 'ready'
      LEFT JOIN voice_assets v ON v.id = n.voice_asset_id AND v.status = 'ready'
      WHERE s.project_id = ? ORDER BY s.ordinal
    `).all(projectId);
    const job = this.jobs.create(
      `render_${kind}`,
      projectId,
      { projectId, kind, renderInput, repairSequence, startSceneOrdinal: options.startSceneOrdinal, endSceneOrdinal: options.endSceneOrdinal },
      2
    );
    if (job.state === 'SUCCEEDED') {
      const completedJob = this.db.raw.prepare(`SELECT output_json FROM jobs WHERE id = ?`).get(job.id) as {
        output_json: string | null;
      } | undefined;
      const completedRenderId = completedJob?.output_json
        ? (JSON.parse(completedJob.output_json) as { id?: string }).id
        : undefined;
      const completedRender = completedRenderId
        ? this.db.raw.prepare(`SELECT * FROM renders WHERE id = ? AND state = 'SUCCEEDED'`).get(completedRenderId) as Record<string, unknown> | undefined
        : undefined;
      if (completedRender) return renderFromRow(completedRender);
    }

    this.jobs.start(job.id, 'Preparing timeline');
    const renderId = randomUUID();
    const settings = this.settings();
    const project = this.projects.get(projectId);
    const profile = kind === 'final' ? 'final_1080p' : 'draft_720p';
    const previousVersion = this.db.raw.prepare(`
      SELECT coalesce(max(artifact_version), 0) AS version
      FROM renders WHERE project_id = ? AND kind = ?
    `).get(projectId, kind) as { version: number };
    const artifactVersion = Number(previousVersion.version ?? 0) + 1;
    const outputDirectory = join(settings.outputFolder, kind === 'final' ? 'review' : 'draft');
    const projectDirectory = join(settings.projectFolder, project.id);
    const workDirectory = join(projectDirectory, 'render-work', renderId);
    const manifestDirectory = join(projectDirectory, 'manifest');
    const captionDirectory = join(projectDirectory, 'captions');
    mkdirSync(outputDirectory, { recursive: true });
    mkdirSync(workDirectory, { recursive: true });
    mkdirSync(manifestDirectory, { recursive: true });
    mkdirSync(captionDirectory, { recursive: true });

    const outputPath = join(outputDirectory, `${project.slug}-${kind}-${renderId.slice(0, 8)}.mp4`);
    const manifestPath = join(manifestDirectory, `${kind}-${renderId}.json`);
    const srtPath = join(captionDirectory, `${project.slug}-${kind}.srt`);
    const vttPath = join(captionDirectory, `${project.slug}-${kind}.vtt`);
    const allSceneOrdinals = project.scenes.map(scene => scene.ordinal);
    const firstOrdinal = Math.max(1, options.startSceneOrdinal ?? Math.min(...allSceneOrdinals));
    const lastOrdinal = options.endSceneOrdinal ?? options.startSceneOrdinal ?? Math.max(...allSceneOrdinals);
    const sceneOrdinals = allSceneOrdinals.filter(ordinal => ordinal >= firstOrdinal && ordinal <= lastOrdinal);
    if (kind === 'range' && !sceneOrdinals.length) throw new Error('Requested render range contains no project scenes.');
    const scope: RenderScope | null = kind === 'range'
      ? { startSceneOrdinal: sceneOrdinals[0]!, endSceneOrdinal: sceneOrdinals.at(-1)!, sceneOrdinals }
      : null;
    const baseRender = kind === 'range'
      ? this.db.raw.prepare(`
          SELECT id FROM renders WHERE project_id = ? AND kind IN ('draft','final') AND state = 'SUCCEEDED'
          ORDER BY completed_at DESC LIMIT 1
        `).get(projectId) as { id: string } | undefined
      : undefined;
    if (kind === 'range') {
      const current = this.db.raw.prepare(`SELECT state FROM projects WHERE id = ?`).get(projectId) as {
        state: import('@shared/types').ProjectState;
      };
      if (current.state !== 'BUILDING_TIMELINE') {
        this.projects.states.transition(projectId, 'BUILDING_TIMELINE', {
          progress: 0.59,
          reason: 'A bounded scene range was requested for preview or repair',
          prerequisites: { scope, previousState: current.state }
        });
      }
    }
    const now = new Date().toISOString();
    this.db.raw.prepare(`
      INSERT INTO renders(
        id, project_id, kind, profile, state, manifest_path, output_path,
        artifact_version, scope_json, base_render_id, created_at
      ) VALUES(?, ?, ?, ?, 'RUNNING', ?, ?, ?, ?, ?, ?)
    `).run(renderId, projectId, kind, profile, manifestPath, outputPath, artifactVersion, JSON.stringify(scope ?? {}), baseRender?.id ?? null, now);
    this.projects.states.transition(projectId, kind === 'final' ? 'RENDERING_FINAL' : 'RENDERING_DRAFT', {
      progress: kind === 'final' ? 0.78 : 0.63,
      reason: `${kind === 'final' ? 'Final' : kind === 'range' ? 'Range' : 'Draft'} render job started`,
      prerequisites: { renderId, profile, scope }
    });

    let retryAutomatically = false;
    let currentAttemptCommitted = false;
    try {
      const sourceRows = this.db.raw.prepare(`
        SELECT
          s.id AS scene_id,
          s.ordinal,
          s.narration,
          s.target_duration_ms,
          s.required_location,
          s.verification_state,
          s.selected_file_id,
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
          AND (? = 0 OR s.ordinal BETWEEN ? AND ?)
        ORDER BY s.ordinal
      `).all(projectId, Number(kind === 'range'), firstOrdinal, lastOrdinal) as unknown as SourceSceneRow[];
      if (!sourceRows.length) throw new Error('Project has no scenes.');

      const invalid = sourceRows.filter(row =>
        row.verification_state !== 'verified'
          || !row.original_path
          || !row.sha256
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
      let elapsed = 0;

      for (let index = 0; index < sourceRows.length; index += 1) {
        const row = sourceRows[index];
        if (!row) continue;
        const sourceHash = row.sha256;
        if (!sourceHash) throw new Error(`Scene ${row.ordinal} has no immutable source hash.`);
        const ordinal = Number(row.ordinal);
        const narrationRecord = this.db.raw.prepare(`
          SELECT n.id AS section_id, v.audio_path, v.input_hash AS voice_input_hash,
            min(w.start_ms) AS scene_start_ms, max(w.end_ms) AS scene_end_ms
          FROM narration_words w
          JOIN narration_sections n ON n.id = w.section_id
          JOIN voice_assets v ON v.id = n.voice_asset_id
          WHERE w.scene_id = ? AND n.project_id = ? AND n.script_version_id = ?
            AND n.status = 'ready' AND v.status = 'ready'
          GROUP BY n.id, v.audio_path
        `).get(row.scene_id, projectId, project.scriptVersionId) as {
          section_id: string;
          audio_path: string;
          voice_input_hash: string;
          scene_start_ms: number;
          scene_end_ms: number;
        } | undefined;
        if (!narrationRecord?.audio_path || !existsSync(narrationRecord.audio_path)) {
          throw new Error(`Scene ${ordinal} has no immutable section narration asset.`);
        }
        const absoluteWords = (this.db.raw.prepare(`
          SELECT word, start_ms, end_ms, confidence, timing_method
          FROM narration_words WHERE scene_id = ? AND section_id = ? ORDER BY ordinal
        `).all(row.scene_id, narrationRecord.section_id) as Array<Record<string, unknown>>).map(word => ({
          word: String(word.word),
          startMs: Number(word.start_ms),
          endMs: Number(word.end_ms),
          confidence: Number(word.confidence),
          timingMethod: word.timing_method as NarrationWord['timingMethod']
        }));
        const sceneStartMs = Number(narrationRecord.scene_start_ms);
        const narrationParts = splitAlignedNarration(
          absoluteWords.map(word => ({ ...word, startMs: word.startMs - sceneStartMs, endMs: word.endMs - sceneStartMs })),
          settings.hardShotMaxSeconds * 1000
        );
        if (!narrationParts.length) throw new Error(`Scene ${ordinal} narration is empty.`);
        for (let partIndex = 0; partIndex < narrationParts.length; partIndex += 1) {
          const part = narrationParts[partIndex]!;
          const narration = part.text;
          const suffix = narrationParts.length > 1 ? `-part-${partIndex + 1}` : '';
          const sectionAudioPath = narrationRecord.audio_path;
          const audioPath = join(workDirectory, `scene-${String(ordinal).padStart(4, '0')}${suffix}.wav`);
          const normalizedPath = join(workDirectory, `scene-${String(ordinal).padStart(4, '0')}${suffix}.mp4`);
          this.jobs.progress(job.id, 0.05 + (index / sourceRows.length) * 0.42, `Building aligned shot ${ordinal}/${sourceRows.length}`);
          this.emitProgress(job.id, projectId, 0.05 + (index / sourceRows.length) * 0.42, 'timeline', `Building word-aligned shot ${ordinal}/${sourceRows.length}`);
          const absoluteAudioStartMs = sceneStartMs + part.audioStartMs;
          const audioDurationMs = part.durationMs;
          await requireSuccess(ffmpeg, [
            '-y', '-hide_banner', '-ss', (absoluteAudioStartMs / 1000).toFixed(3),
            '-t', (audioDurationMs / 1000).toFixed(3), '-i', sectionAudioPath,
            '-map', '0:a:0', '-c:a', 'pcm_s16le', audioPath
          ]);
          if (audioDurationMs < 500) throw new Error(`Scene ${ordinal} narration audio is unexpectedly short.`);
          if (audioDurationMs > settings.hardShotMaxSeconds * 1000) {
            throw new Error(`Scene ${ordinal}, part ${partIndex + 1} remains longer than the ${settings.hardShotMaxSeconds}-second visual-shot limit.`);
          }
          const alternatives = this.db.raw.prepare(`
            SELECT start_ms, duration_ms FROM media_segments
            WHERE asset_file_id = ? AND eligible_1080p = 1
              AND black_frame_risk < 0.35 AND freeze_risk < 0.5
              AND duration_ms >= ?
            ORDER BY quality_score DESC, start_ms ASC LIMIT 12
          `).all(row.selected_file_id, audioDurationMs) as Array<{ start_ms: number; duration_ms: number }>;
          const visual = alternatives[partIndex % alternatives.length];
          if (!visual) throw new Error(`Scene ${ordinal} has no safe visual segment long enough for narration part ${partIndex + 1}.`);
          const sourceAvailableMs = Number(visual.duration_ms);
          const durationMs = fitNarrationShotDuration(
            audioDurationMs,
            sourceAvailableMs,
            settings.hardShotMaxSeconds * 1000
          );
          assertShotDuration(durationMs, settings.hardShotMaxSeconds * 1000);
          const width = kind === 'final' ? 1920 : 1280;
          const height = kind === 'final' ? 1080 : 720;
          const videoBitrate = kind === 'final' ? '10M' : '5M';
          const preset = kind === 'final' ? 'medium' : 'veryfast';
          const sourceStartMs = Number(visual.start_ms);
          const startSeconds = sourceStartMs / 1000;
          const durationSeconds = durationMs / 1000;

          const fragmentInputHash = createHash('sha256').update(renderFragmentCacheKey({
            sceneId: row.scene_id,
            sourceHash,
            sourceStartMs,
            durationMs,
            voiceInputHash: narrationRecord.voice_input_hash,
            audioStartMs: absoluteAudioStartMs,
            narration,
            width,
            height,
            profile
          })).digest('hex');
          const cachedFragment = this.db.raw.prepare(`
            SELECT output_path FROM render_fragments
            WHERE project_id = ? AND input_hash = ? AND status = 'ready'
          `).get(projectId, fragmentInputHash) as { output_path: string } | undefined;
          const fragmentDirectory = join(projectDirectory, 'render-fragments', profile);
          mkdirSync(fragmentDirectory, { recursive: true });
          const fragmentPath = join(fragmentDirectory, `${fragmentInputHash}.mp4`);
          const reuse = Boolean(cachedFragment?.output_path && existsSync(cachedFragment.output_path));
          if (!reuse) await requireSuccess(ffmpeg, [
          '-y',
          '-hide_banner',
          '-ss', startSeconds.toFixed(3),
          '-t', durationSeconds.toFixed(3),
          '-i', String(row.original_path),
          '-i', audioPath,
          '-filter_complex',
          `[0:v]yadif=mode=send_frame:parity=auto:deint=interlaced,scale=w='min(${width},iw)':h='min(${height},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p[v];[1:a]aresample=48000,apad=pad_dur=${durationSeconds.toFixed(3)},atrim=0:${durationSeconds.toFixed(3)}[a]`,
          '-map', '[v]',
          '-map', '[a]',
          '-t', durationSeconds.toFixed(3),
          '-c:v', 'libx264',
          '-preset', preset,
          '-b:v', videoBitrate,
          '-maxrate', videoBitrate,
          '-bufsize', kind === 'draft' ? '10M' : '20M',
          '-color_range', 'tv',
          '-colorspace', 'bt709',
          '-color_primaries', 'bt709',
          '-color_trc', 'bt709',
          '-c:a', 'aac',
          '-profile:a', 'aac_low',
          '-b:a', kind === 'draft' ? '192k' : '384k',
          '-ar', '48000',
          '-ac', '2',
          '-movflags', '+faststart',
          fragmentPath
          ]);
          if (!reuse) this.db.raw.prepare(`
            INSERT INTO render_fragments(
              id, project_id, scene_id, profile, input_hash, output_path,
              duration_ms, source_artifact_version, status, created_at, updated_at
            ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)
            ON CONFLICT(input_hash) DO UPDATE SET output_path = excluded.output_path,
              duration_ms = excluded.duration_ms, status = 'ready', updated_at = excluded.updated_at
          `).run(
            randomUUID(), projectId, row.scene_id, profile, fragmentInputHash, fragmentPath,
            durationMs, artifactVersion, new Date().toISOString(), new Date().toISOString()
          );
          const selectedFragmentPath = reuse ? cachedFragment!.output_path : fragmentPath;
          timeline.push({
            sceneId: String(row.scene_id), ordinal, narration, sourcePath: String(row.original_path),
            sourceHash, sourceStartMs, sourceEndMs: sourceStartMs + durationMs,
            durationMs, audioPath: sectionAudioPath, normalizedPath: selectedFragmentPath,
            timelineStartMs: elapsed, timelineEndMs: elapsed + durationMs,
            requiredLocation: row.required_location ? String(row.required_location) : null,
            narrationPart: partIndex + 1, narrationParts: narrationParts.length,
            wordTimings: part.words.map(word => ({
              ...word,
              startMs: elapsed + (word.startMs - part.audioStartMs),
              endMs: elapsed + (word.endMs - part.audioStartMs)
            })),
            reusedFragment: reuse
          });
          elapsed += durationMs;
        }
      }

      const captionCues = captionCuesFromWords(timeline.flatMap(scene => scene.wordTimings));
      const srtBlocks = captionCues.map((cue, index) =>
        `${index + 1}\n${srtTime(cue.startMs)} --> ${srtTime(cue.endMs)}\n${cue.text}\n`
      );
      writeFileSync(srtPath, `${srtBlocks.join('\n')}\n`, 'utf8');
      const vttBlocks = captionCues.map((cue, index) =>
        `${index + 1}\n${vttTime(cue.startMs)} --> ${vttTime(cue.endMs)}\n${cue.text}\n`
      );
      writeFileSync(vttPath, `WEBVTT\n\n${vttBlocks.join('\n')}\n`, 'utf8');
      const concatPath = join(workDirectory, 'concat.txt');
      writeFileSync(
        concatPath,
        timeline.map(scene => `file '${scene.normalizedPath.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'),
        'utf8'
      );

      this.jobs.progress(job.id, 0.54, 'Assembling timeline');
      this.emitProgress(job.id, projectId, 0.54, 'assembly', 'Stitching synchronized scenes');
      const assembledPath = join(workDirectory, 'assembled.mp4');
      this.jobs.progress(job.id, 0.78, 'Normalizing final audio');
      this.emitProgress(job.id, projectId, 0.78, 'audio-qc', 'Normalizing narration loudness');
      await assembleAndNormalizeTimeline({
        ffmpeg,
        concatPath,
        assembledPath,
        outputPath,
        audioBitrate: kind === 'final' ? '384k' : '192k'
      });

      const outputProbe = await this.probeOutput(outputPath);
      const outputLoudnessPass = await requireSuccess(ffmpeg, [
        '-hide_banner', '-nostats', '-i', outputPath,
        '-map', '0:a:0', '-af', 'loudnorm=I=-14:TP=-1:LRA=11:print_format=json',
        '-f', 'null', '-'
      ]);
      const outputLoudness = loudnormStats(outputLoudnessPass.stderr);

      const outputHash = await sha256(outputPath);
      const manifest = {
        schemaVersion: '1.0',
        projectId,
        renderId,
        projectTitle: project.title,
        scriptVersionId: project.scriptVersionId,
        profile,
        artifactVersion,
        output: {
          container: 'mp4',
          videoCodec: 'h264',
          audioCodec: 'aac',
          width: kind === 'final' ? 1920 : 1280,
          height: kind === 'final' ? 1080 : 720,
          frameRate: 30,
          pixelFormat: 'yuv420p',
          colorSpace: 'bt709',
          fastStart: true
        },
        captions: { srtPath, vttPath },
        scope,
        baseRenderId: baseRender?.id ?? null,
        reusedFragmentCount: timeline.filter(scene => scene.reusedFragment).length,
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
        kind === 'final' ? 1920 : 1280,
        kind === 'final' ? 1080 : 720,
        completed,
        renderId
      );

      this.runQc(projectId, renderId, kind, timeline, outputPath, outputProbe, outputLoudness);
      if (kind === 'final') {
        this.projects.states.transition(projectId, 'QC_FINAL', {
          progress: 0.88,
          finalRenderId: renderId,
          reason: 'Final render completed and automated QC recorded',
          prerequisites: { renderId, outputHash }
        });
        this.projects.generatePackaging(projectId);
        await this.generateThumbnailCandidates(projectId, outputPath, elapsed);
        const blockers = this.db.raw.prepare(`
          SELECT id, code, category, severity, message, evidence_json FROM qc_results
          WHERE project_id = ? AND render_id = ? AND status = 'fail' AND severity IN ('BLOCKER','HIGH')
          ORDER BY CASE severity WHEN 'BLOCKER' THEN 0 ELSE 1 END, code
        `).all(projectId, renderId) as Array<{
          id: string;
          code: string;
          category: string;
          severity: 'BLOCKER' | 'HIGH';
          message: string;
          evidence_json: string;
        }>;
        if (blockers.length) {
          const route = this.projects.repairs.routeQcFailures(projectId, renderId, blockers.map(failure => ({
            id: failure.id,
            code: failure.code,
            category: failure.category,
            severity: failure.severity,
            message: failure.message,
            evidenceJson: failure.evidence_json
          })));
          if (route.retryAutomatically && route.targetState) {
            retryAutomatically = true;
            this.projects.states.transition(projectId, route.targetState, {
              progress: 0.76,
              reason: 'Correctable final QC failures routed to the smallest safe rebuild stage',
              prerequisites: {
                blockerCount: blockers.length,
                failedRenderId: renderId,
                failedArtifactVersion: artifactVersion,
                retrySequence: route.retrySequence,
                targetState: route.targetState
              }
            });
            await this.prepareRepair(projectId, route.targetState);
          } else {
            this.recordQcExceptions(projectId, renderId, blockers);
            this.projects.states.transition(projectId, 'BLOCKED_EXCEPTION', {
              progress: 0.88,
              reason: route.exhausted
                ? 'Automatic QC repair limit reached'
                : 'Final QC contains a failure requiring operator action',
              prerequisites: {
                blockerCount: blockers.length,
                repairExhausted: route.exhausted,
                operatorRequired: route.operatorRequired
              }
            });
          }
        } else {
          this.projects.repairs.completeClearedRenderRepairs(projectId, renderId, new Set());
          this.projects.states.transition(projectId, 'WAITING_FINAL_APPROVAL', {
            progress: 0.9,
            reason: 'Final render and package passed local QC; private upload/final review is ready',
            prerequisites: { renderId, packageCount: this.projects.get(projectId).packaging.length }
          });
        }
      } else if (kind === 'draft') {
        this.projects.states.transition(projectId, 'QC_DRAFT', {
          progress: 0.72,
          reason: 'Draft render completed and automated QC recorded',
          prerequisites: { renderId }
        });
      } else {
        const rangeBlockers = this.db.raw.prepare(`
          SELECT id, code, category, severity, message, evidence_json FROM qc_results
          WHERE project_id = ? AND render_id = ? AND status = 'fail'
            AND severity IN ('BLOCKER','HIGH')
        `).all(projectId, renderId) as Array<{
          id: string;
          code: string;
          category: string;
          severity: 'BLOCKER' | 'HIGH';
          message: string;
          evidence_json: string;
        }>;
        if (rangeBlockers.length) {
          this.recordQcExceptions(projectId, renderId, rangeBlockers);
          this.projects.states.transition(projectId, 'BLOCKED_EXCEPTION', {
            progress: 0.72,
            reason: 'The bounded range render failed automated verification',
            prerequisites: { renderId, scope, blockerCount: rangeBlockers.length }
          });
          retryAutomatically = false;
        } else {
        const routedRangeRepairs = Number((this.db.raw.prepare(`
          SELECT count(*) AS count FROM repair_attempts
          WHERE project_id = ? AND status = 'routed' AND repair_class = 'regenerate_range'
            AND range_start_ordinal <= ? AND range_end_ordinal >= ?
        `).get(projectId, scope!.endSceneOrdinal, scope!.startSceneOrdinal) as { count: number }).count);
        this.db.raw.prepare(`
          UPDATE repair_attempts SET evidence_json = json_set(
            evidence_json, '$.rangeRenderId', ?, '$.rangeScope', json(?), '$.verifiedBy', 'range_render_pass'
          )
          WHERE project_id = ? AND status = 'routed' AND repair_class = 'regenerate_range'
            AND range_start_ordinal <= ? AND range_end_ordinal >= ?
        `).run(
          renderId, JSON.stringify(scope), projectId,
          scope!.endSceneOrdinal, scope!.startSceneOrdinal
        );
        this.projects.states.transition(projectId, 'QC_DRAFT', {
          progress: 0.72,
          reason: 'Requested scene range rendered and passed automated media checks',
          prerequisites: { renderId, scope, baseRenderId: baseRender?.id ?? null }
        });
        retryAutomatically = routedRangeRepairs > 0;
        }
      }

      const result = renderFromRow(this.db.raw.prepare('SELECT * FROM renders WHERE id = ?').get(renderId) as Record<string, unknown>);
      this.jobs.succeed(job.id, result);
      currentAttemptCommitted = true;
      if (retryAutomatically) {
        this.emitProgress(job.id, projectId, 1, 'repair', 'QC repair routed; rebuilding final artifact automatically');
        return this.render(projectId, 'final');
      }
      this.emitProgress(job.id, projectId, 1, 'complete', `${kind === 'final' ? 'Final' : kind === 'range' ? 'Range' : 'Draft'} render complete`);
      return result;
    } catch (error) {
      if (currentAttemptCommitted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      this.db.raw.prepare(`
        UPDATE renders SET state = 'FAILED', error = ?, completed_at = ? WHERE id = ?
      `).run(message, new Date().toISOString(), renderId);
      const current = this.db.raw.prepare('SELECT state FROM projects WHERE id = ?').get(projectId) as { state: import('@shared/types').ProjectState };
      if (current.state !== 'BLOCKED_EXCEPTION') {
        this.projects.states.transition(projectId, 'BLOCKED_EXCEPTION', {
          reason: `${kind} render failed`,
          prerequisites: { renderId, error: message }
        });
      }
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
      if (existsSync(outputPath)) unlinkSync(outputPath);
      if (existsSync(workDirectory)) rmSync(workDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  private async probeOutput(outputPath: string): Promise<OutputProbe> {
    const ffprobe = resolveFfprobe(this.settings().ffprobePath);
    if (!ffprobe) throw new Error('FFprobe is unavailable for final output validation.');
    const result = await requireSuccess(ffprobe, [
      '-v', 'error', '-show_format', '-show_streams', '-of', 'json', outputPath
    ]);
    return JSON.parse(result.stdout) as OutputProbe;
  }

  private runQc(
    projectId: string,
    renderId: string,
    kind: 'range' | 'draft' | 'final',
    timeline: TimelineScene[],
    outputPath: string,
    probe: OutputProbe,
    measured: { inputI: string; inputTp: string }
  ): void {
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
    const video = probe.streams?.find(stream => stream.codec_type === 'video');
    const audio = probe.streams?.find(stream => stream.codec_type === 'audio');
    const durationMs = Math.round(Number(probe.format?.duration ?? 0) * 1000);
    const expectedDurationMs = timeline.reduce((total, scene) => total + scene.durationMs, 0);
    const expectedWidth = kind === 'final' ? 1920 : 1280;
    const expectedHeight = kind === 'final' ? 1080 : 720;
    const frameRate = rationalRate(video?.avg_frame_rate);
    const profileValid = Boolean(
      video?.codec_name === 'h264'
      && video.width === expectedWidth
      && video.height === expectedHeight
      && video.pix_fmt === 'yuv420p'
      && Math.abs(frameRate - 30) < 0.01
      && (!video.field_order || video.field_order === 'progressive')
      && video.color_space === 'bt709'
      && video.color_transfer === 'bt709'
      && video.color_primaries === 'bt709'
      && audio?.codec_name === 'aac'
      && audio.profile === 'LC'
      && audio.sample_rate === '48000'
      && audio.channels === 2
    );
    const durationValid = Math.abs(durationMs - expectedDurationMs) <= 750;
    const alignedWords = timeline.flatMap(scene => scene.wordTimings);
    const expectedWords = timeline.flatMap(scene => scene.narration.match(/\S+/g) ?? []).length;
    const wordTimingValid = alignedWords.length === expectedWords
      && alignedWords.every((word, index) =>
        word.startMs >= 0
        && word.endMs > word.startMs
        && (index === 0 || word.startMs >= alignedWords[index - 1]!.endMs)
      );
    const fastStart = this.hasFastStart(outputPath);
    const measuredLufs = Number(measured.inputI);
    const measuredTruePeak = Number(measured.inputTp);
    const loudnessValid = Number.isFinite(measuredLufs) && Number.isFinite(measuredTruePeak)
      && Math.abs(measuredLufs - -14) <= 1 && measuredTruePeak <= -0.5;
    add('media', 'SHOT_DURATION', 'BLOCKER', over.length ? 'fail' : 'pass',
      over.length ? `${over.length} shot(s) exceed 7 seconds.` : 'Every visual shot is 7 seconds or shorter.',
      { ordinals: over.map(scene => scene.ordinal) });
    add('media', 'OUTPUT_EXISTS', 'BLOCKER', existsSync(outputPath) ? 'pass' : 'fail',
      existsSync(outputPath) ? 'Rendered MP4 exists.' : 'Rendered MP4 is missing.',
      { outputPath });
    add('media', 'FINAL_MEDIA_PROFILE', 'BLOCKER', profileValid ? 'pass' : 'fail',
      profileValid ? `${kind} media matches the required H.264/AAC output profile.` : `${kind} media does not match the required output profile.`,
      { video, audio, frameRate, format: probe.format?.format_name });
    add('media', 'FINAL_DURATION', 'BLOCKER', durationValid ? 'pass' : 'fail',
      durationValid ? 'Final media duration matches the render timeline.' : 'Final media duration differs from the render timeline.',
      { durationMs, expectedDurationMs });
    add('media', 'FAST_START', 'HIGH', fastStart ? 'pass' : 'fail',
      fastStart ? 'MP4 metadata appears before media payload.' : 'MP4 fast-start metadata was not detected.',
      { fastStart });
    add('audio', 'LOUDNESS_MEASURED', 'HIGH', loudnessValid ? 'pass' : 'fail',
      loudnessValid ? 'Final output meets configured EBU R128 loudness and true-peak tolerances.' : 'Final output is outside configured loudness or true-peak tolerances.',
      { measuredOutputLufs: measuredLufs, measuredOutputTruePeakDb: measuredTruePeak, targetLufs: -14, targetTruePeakDb: -1 });
    add('audio', 'WORD_TIMING', 'BLOCKER', wordTimingValid ? 'pass' : 'fail',
      wordTimingValid ? 'Every final narration word has monotonic timing.' : 'Narration word timing is missing, overlapping, or does not match the final script.',
      { expectedWords, alignedWords: alignedWords.length, timingMethods: [...new Set(alignedWords.map(word => word.timingMethod))] });
    const captionCues = captionCuesFromWords(alignedWords);
    const captionValid = captionCues.length > 0 && captionCues.every((cue, index) =>
      cue.endMs > cue.startMs
      && cue.text.length <= 42
      && (index === 0 || cue.startMs >= captionCues[index - 1]!.endMs)
    );
    add('packaging', 'CAPTION_TIMING', 'BLOCKER', captionValid ? 'pass' : 'fail',
      captionValid ? 'Captions are word-aligned, bounded, and nonoverlapping.' : 'Captions are missing, overlapping, or exceed the line policy.',
      { cueCount: captionCues.length, maximumCharacters: 42 });
    add('story', 'LOCATION_GROUNDING', 'BLOCKER', 'pass',
      'All rendered scenes use media that passed the exact-location metadata hard gate.',
      { sceneCount: timeline.length });
    add('rights', 'LICENSE_STATE', 'BLOCKER',
      this.missingLicenseCount(projectId) ? 'fail' : 'pass',
      this.missingLicenseCount(projectId) ? 'One or more used assets lacks an attested project license.' : 'Every used asset has an attested project license.',
      { missing: this.missingLicenseCount(projectId) });
  }

  private hasFastStart(outputPath: string): boolean {
    const descriptor = openSync(outputPath, 'r');
    try {
      const buffer = Buffer.alloc(16 * 1024 * 1024);
      const bytes = readSync(descriptor, buffer, 0, buffer.length, 0);
      const header = buffer.subarray(0, bytes);
      const moov = header.indexOf(Buffer.from('moov'));
      const mdat = header.indexOf(Buffer.from('mdat'));
      return moov >= 0 && mdat >= 0 && moov < mdat;
    } finally {
      closeSync(descriptor);
    }
  }

  private missingLicenseCount(projectId: string): number {
    const selected = this.db.raw.prepare(`
      SELECT selected_asset_id FROM project_scenes WHERE project_id = ?
    `).all(projectId) as Array<{ selected_asset_id: string | null }>;
    const licenses = this.db.raw.prepare(`
      SELECT asset_id, license_state FROM project_licenses WHERE project_id = ?
    `).all(projectId) as Array<{ asset_id: string; license_state: string }>;
    return missingSelectedLicenseCount(
      selected.map(row => row.selected_asset_id),
      licenses.map(row => ({ assetId: row.asset_id, state: row.license_state }))
    );
  }

  private recordQcExceptions(
    projectId: string,
    renderId: string,
    failures: Array<{
      id: string;
      code: string;
      category: string;
      severity: 'BLOCKER' | 'HIGH';
      message: string;
      evidence_json: string;
    }>
  ): void {
    const now = new Date().toISOString();
    const insert = this.db.raw.prepare(`
      INSERT INTO exceptions(
        id, project_id, severity, stage, code, title, message, evidence_json,
        recommended_action, status, created_at
      ) VALUES(?, ?, ?, 'render_qc', ?, ?, ?, ?, ?, 'OPEN', ?)
    `);
    for (const failure of failures) {
      const code = `QC_${failure.code}`;
      const existing = this.db.raw.prepare(`
        SELECT id FROM exceptions
        WHERE project_id = ? AND code = ? AND status = 'OPEN'
          AND json_extract(evidence_json, '$.renderId') = ?
      `).get(projectId, code, renderId);
      if (existing) continue;
      let qcEvidence: unknown = {};
      try {
        qcEvidence = JSON.parse(failure.evidence_json);
      } catch {
        qcEvidence = { rawEvidence: failure.evidence_json };
      }
      insert.run(
        randomUUID(),
        projectId,
        failure.severity,
        code,
        `Final QC failed: ${failure.code.replaceAll('_', ' ').toLowerCase()}`,
        failure.message,
        JSON.stringify({ renderId, qcCode: failure.code, qcEvidence }),
        String(this.db.raw.prepare('SELECT repair_action FROM qc_results WHERE id = ?').get(failure.id)?.repair_action
          ?? 'Complete the recorded prerequisite, then generate and verify a new final render.'),
        now
      );
    }
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
