import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { AppDatabase } from '@main/database/database';
import { JobService } from '@main/services/job-service';
import { MediaService } from '@main/services/media-service';
import { ProjectService } from '@main/services/project-service';
import { RenderService } from '@main/services/render-service';
import { requireSuccess } from '@main/services/process-utils';
import type { AppSettings } from '@shared/types';

type RenderProgress = (
  jobId: string,
  projectId: string,
  progress: number,
  phase: string,
  message: string
) => void;

export interface OpenRenderCrashFixture {
  db: AppDatabase;
  jobs: JobService;
  render: RenderService;
  settings: AppSettings;
}

export async function seedRenderCrashFixture(root: string): Promise<void> {
  if (!ffmpegPath) throw new Error('ffmpeg-static binary is unavailable.');
  mkdirSync(root, { recursive: true });
  const sourcePath = join(root, 'source.mp4');
  const narrationPath = join(root, 'voice.wav');
  await requireSuccess(ffmpegPath, [
    '-y', '-hide_banner',
    '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=2.4',
    '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-movflags', '+faststart', sourcePath
  ]);
  await requireSuccess(ffmpegPath, [
    '-y', '-hide_banner',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1.2',
    '-c:a', 'pcm_s16le', narrationPath
  ]);
  const sourceProbe = await requireSuccess(ffprobeStatic.path, [
    '-v', 'error', '-show_format', '-show_streams', '-of', 'json', sourcePath
  ]);

  const db = new AppDatabase(join(root, 'videofactory.sqlite'));
  try {
    const now = new Date().toISOString();
    const sourceHash = createHash('sha256').update(readFileSync(sourcePath)).digest('hex');
    db.raw.prepare(`
      INSERT INTO projects(
        id, sequence, slug, title, topic, state, progress, envato_project_name,
        target_duration_ms, script_version_id, created_at, updated_at
      ) VALUES('project-1', 1, 'crash-fixture', 'Crash Fixture', 'Fixture',
        'BUILDING_TIMELINE', 0.6, 'YT-CRASH-0001', 1800, 'script-1', ?, ?)
    `).run(now, now);
    db.raw.prepare(`
      INSERT INTO script_versions(
        id, project_id, version_number, title, topic, script_json,
        generation_reason, provider, model, input_hash, locked, script_type,
        locked_at, created_at
      ) VALUES('script-1', 'project-1', 1, 'Crash Fixture', 'Fixture', '{}',
        'integration test', 'mock', 'mock', 'script-input', 1, 'final', ?, ?)
    `).run(now, now);
    db.raw.prepare(`
      INSERT INTO assets(
        id, stable_key, title, country, city, location_name, orientation,
        location_granularity, location_confidence, verification_status,
        availability_status, raw_row_json, imported_at, updated_at
      ) VALUES('asset-1', 'asset-1', 'Fixture footage', 'Mexico', 'Oaxaca',
        'Zocalo', 'landscape', 'landmark', 1, 'human_verified', 'available',
        '{}', ?, ?)
    `).run(now, now);
    db.raw.prepare(`
      INSERT INTO asset_files(
        id, asset_id, sha256, original_path, original_file_name, file_size_bytes,
        duration_ms, width, height, frame_rate, codec, audio_present,
        raw_ffprobe_json, pipeline_version, created_at
      ) VALUES('file-1', 'asset-1', ?, ?, 'source.mp4', 1, 2400, 1920, 1080,
        30, 'h264', 0, ?, ?, ?)
    `).run(sourceHash, sourcePath, sourceProbe.stdout, MediaService.PIPELINE_VERSION, now);
    db.raw.prepare(`
      INSERT INTO media_segments(
        id, asset_file_id, start_ms, end_ms, duration_ms, quality_score,
        black_frame_risk, freeze_risk, effective_width, effective_height,
        eligible_1080p, eligible_4k, pipeline_version, created_at
      ) VALUES('segment-1', 'file-1', 0, 2200, 2200, 1, 0, 0,
        1920, 1080, 1, 0, ?, ?)
    `).run(MediaService.PIPELINE_VERSION, now);
    db.raw.prepare(`
      INSERT INTO project_scenes(
        id, project_id, script_version_id, ordinal, chapter, narration,
        target_duration_ms, required_country, required_city, required_location,
        required_granularity, required_objects_json, required_activities_json,
        preferred_shots_json, visual_treatment, selected_asset_id,
        selected_file_id, selected_segment_id, score_explanation_json,
        verification_state, created_at, updated_at
      ) VALUES('scene-1', 'project-1', 'script-1', 1, 'Opening', 'Oaxaca.',
        1800, 'Mexico', 'Oaxaca', 'Zocalo', 'landmark', '[]', '[]', '[]',
        'EXACT_LOCATION_FOOTAGE', 'asset-1', 'file-1', 'segment-1', '[]',
        'verified', ?, ?)
    `).run(now, now);
    db.raw.prepare(`
      INSERT INTO project_licenses(
        id, project_id, asset_id, license_state, envato_project_name,
        operator_attested_at, verified_at, created_at, updated_at
      ) VALUES('license-1', 'project-1', 'asset-1', 'VERIFIED',
        'YT-CRASH-0001', ?, ?, ?, ?)
    `).run(now, now, now, now);
    db.raw.prepare(`
      INSERT INTO voice_assets(
        id, project_id, provider, model, voice_id, settings_json,
        pronunciation_hash, input_hash, text, audio_path, duration_ms,
        timing_method, status, created_at, updated_at
      ) VALUES('voice-1', 'project-1', 'test', 'test', 'test', '{}',
        'pronunciation', 'voice-input', 'Oaxaca.', ?, 1200,
        'provider_word', 'ready', ?, ?)
    `).run(narrationPath, now, now);
    db.raw.prepare(`
      INSERT INTO narration_sections(
        id, project_id, script_version_id, voice_asset_id, ordinal, chapter,
        scene_ids_json, text, pronunciation_json, duration_ms, status,
        created_at, updated_at
      ) VALUES('section-1', 'project-1', 'script-1', 'voice-1', 1, 'Opening',
        '["scene-1"]', 'Oaxaca.', '{}', 1200, 'ready', ?, ?)
    `).run(now, now);
    db.raw.prepare(`
      INSERT INTO narration_words(
        id, section_id, scene_id, ordinal, word, start_ms, end_ms,
        confidence, timing_method
      ) VALUES('word-1', 'section-1', 'scene-1', 1, 'Oaxaca.', 100, 900,
        0.99, 'provider_word')
    `).run();
  } finally {
    db.close();
  }
}

export function openRenderCrashFixture(
  root: string,
  emitProgress: RenderProgress = () => undefined
): OpenRenderCrashFixture {
  if (!ffmpegPath) throw new Error('ffmpeg-static binary is unavailable.');
  const settings = {
    outputFolder: join(root, 'output'),
    projectFolder: join(root, 'projects'),
    ffmpegPath,
    ffprobePath: ffprobeStatic.path,
    hardShotMaxSeconds: 7,
    defaultOutput: '1080p',
    musicEnabled: false,
    channelName: 'Fixture Channel',
    channelShort: 'FC'
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
  return {
    db,
    jobs,
    render: new RenderService(db, () => settings, jobs, projects, emitProgress),
    settings
  };
}
