import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { AppDatabase } from '@main/database/database';
import { JobService } from '@main/services/job-service';
import { ProjectStateService } from '@main/services/project-state-service';
import { ProjectService } from '@main/services/project-service';
import { RenderService } from '@main/services/render-service';
import { requireSuccess } from '@main/services/process-utils';
import type { AppSettings, ProjectDetail } from '@shared/types';

const root = mkdtempSync(join(tmpdir(), 'videofactory-range-render-'));
const sourcePath = join(root, 'source.mp4');
const narrationPath = join(root, 'voice.wav');
let db: AppDatabase;
let service: RenderService;

describe('real range render fragment reuse', () => {
  beforeAll(async () => {
    if (!ffmpegPath) throw new Error('ffmpeg-static binary is unavailable.');
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

    db = new AppDatabase(join(root, 'videofactory.sqlite'));
    const now = new Date().toISOString();
    const sourceHash = createHash('sha256').update(readFileSync(sourcePath)).digest('hex');
    db.raw.prepare(`
      INSERT INTO projects(
        id, sequence, slug, title, topic, state, progress, envato_project_name,
        target_duration_ms, script_version_id, created_at, updated_at
      ) VALUES('project-1', 1, 'range-fixture', 'Range Fixture', 'Fixture',
        'BUILDING_TIMELINE', 0.6, 'YT-RANGE-0001', 1800, 'script-1', ?, ?)
    `).run(now, now);
    db.raw.prepare(`
      INSERT INTO script_versions(
        id, project_id, version_number, title, topic, script_json,
        generation_reason, provider, model, input_hash, locked, script_type,
        locked_at, created_at
      ) VALUES('script-1', 'project-1', 1, 'Range Fixture', 'Fixture', '{}',
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
        30, 'h264', 0, '{}', 'integration', ?)
    `).run(sourceHash, sourcePath, now);
    db.raw.prepare(`
      INSERT INTO media_segments(
        id, asset_file_id, start_ms, end_ms, duration_ms, quality_score,
        black_frame_risk, freeze_risk, effective_width, effective_height,
        eligible_1080p, eligible_4k, pipeline_version, created_at
      ) VALUES('segment-1', 'file-1', 0, 2200, 2200, 1, 0, 0,
        1920, 1080, 1, 0, 'integration', ?)
    `).run(now);
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
        'YT-RANGE-0001', ?, ?, ?, ?)
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

    const settings = {
      outputFolder: join(root, 'output'),
      projectFolder: join(root, 'projects'),
      ffmpegPath,
      ffprobePath: ffprobeStatic.path,
      hardShotMaxSeconds: 7
    } as unknown as AppSettings;
    const projects = new ProjectService(
      db,
      {} as never,
      {} as never,
      () => settings,
      {} as never
    );
    service = new RenderService(
      db,
      () => settings,
      new JobService(db),
      projects,
      () => undefined
    );
  }, 60_000);

  afterAll(() => {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('reuses the cached full-render fragment in an explicit scene range', async () => {
    const draft = await service.render('project-1', 'draft');
    expect(draft.state).toBe('SUCCEEDED');
    expect(existsSync(draft.outputPath!)).toBe(true);
    expect(db.raw.prepare(`SELECT count(*) AS count FROM render_fragments`).get()).toEqual({ count: 1 });

    const range = await service.render('project-1', {
      kind: 'range',
      startSceneOrdinal: 1,
      endSceneOrdinal: 1
    });

    expect(range.state).toBe('SUCCEEDED');
    expect(range.scope).toEqual({ startSceneOrdinal: 1, endSceneOrdinal: 1, sceneOrdinals: [1] });
    expect(range.baseRenderId).toBe(draft.id);
    expect(existsSync(range.outputPath!)).toBe(true);
    expect(db.raw.prepare(`SELECT count(*) AS count FROM render_fragments`).get()).toEqual({ count: 1 });
    const manifest = JSON.parse(readFileSync(range.manifestPath!, 'utf8')) as {
      reusedFragmentCount: number;
      scenes: Array<{ reusedFragment: boolean }>;
    };
    expect(manifest.reusedFragmentCount).toBe(1);
    expect(manifest.scenes).toEqual([expect.objectContaining({ reusedFragment: true })]);
    expect(db.raw.prepare(`
      SELECT code, evidence_json FROM qc_results
      WHERE render_id = ? AND status = 'fail' AND severity IN ('BLOCKER','HIGH')
      ORDER BY code
    `).all(range.id)).toEqual([]);
    expect(db.raw.prepare(`SELECT state FROM projects WHERE id = 'project-1'`).get())
      .toEqual({ state: 'QC_DRAFT' });
  }, 60_000);

  it('generates and validates the final package before entering approval', async () => {
    const final = await service.render('project-1', 'final');
    expect(final.state).toBe('SUCCEEDED');
    expect(final.profile).toBe('final_1080p');
    expect(existsSync(final.outputPath!)).toBe(true);
    expect(db.raw.prepare(`SELECT state FROM projects WHERE id = 'project-1'`).get())
      .toEqual({ state: 'WAITING_FINAL_APPROVAL' });
    expect(db.raw.prepare(`
      SELECT ordinal, risk_status, thumbnail_path FROM packaging_candidates
      WHERE project_id = 'project-1' ORDER BY ordinal
    `).all()).toEqual([
      expect.objectContaining({ ordinal: 1, risk_status: 'pass', thumbnail_path: expect.stringMatching(/concept-1\.jpg$/) }),
      expect.objectContaining({ ordinal: 2, risk_status: 'pass', thumbnail_path: expect.stringMatching(/concept-2\.jpg$/) }),
      expect.objectContaining({ ordinal: 3, risk_status: 'pass', thumbnail_path: expect.stringMatching(/concept-3\.jpg$/) })
    ]);
    expect(db.raw.prepare(`
      SELECT code FROM qc_results WHERE render_id = ? AND status = 'fail'
        AND severity IN ('BLOCKER','HIGH') ORDER BY code
    `).all(final.id)).toEqual([]);
    expect(db.raw.prepare(`
      SELECT code FROM qc_results WHERE render_id = ? AND code IN (
        'PACKAGE_COUNT','PACKAGE_PROMISE_UNSUPPORTED','CHAPTER_TIMESTAMPS','THUMBNAIL_FILE_LIMIT'
      ) ORDER BY code
    `).all(final.id)).toEqual([
      { code: 'CHAPTER_TIMESTAMPS' },
      { code: 'PACKAGE_COUNT' },
      { code: 'PACKAGE_PROMISE_UNSUPPORTED' },
      { code: 'THUMBNAIL_FILE_LIMIT' }
    ]);
  }, 60_000);

  it('renders a coordinate-backed generated graphic without stock media', async () => {
    const now = new Date().toISOString();
    db.raw.prepare(`
      INSERT INTO projects(
        id, sequence, slug, title, topic, destination, state, progress,
        envato_project_name, target_duration_ms, script_version_id, created_at, updated_at
      ) VALUES('project-graphic', 2, 'graphic-fixture', 'Graphic Fixture', 'Oaxaca', 'Oaxaca',
        'BUILDING_TIMELINE', 0.6, 'YT-GRAPHIC-0001', 1800, 'script-graphic', ?, ?)
    `).run(now, now);
    db.raw.prepare(`
      INSERT INTO script_versions(
        id, project_id, version_number, title, topic, script_json, generation_reason,
        provider, model, input_hash, locked, script_type, locked_at, created_at
      ) VALUES('script-graphic', 'project-graphic', 1, 'Graphic Fixture', 'Oaxaca', '{}',
        'integration test', 'mock', 'mock', 'graphic-input', 1, 'final', ?, ?)
    `).run(now, now);
    db.raw.prepare(`
      INSERT INTO places(
        id, stable_key, name, normalized_name, place_type, country_code,
        latitude, longitude, created_at, updated_at
      ) VALUES('place-graphic', 'landmark|oaxaca', 'Zocalo', 'zocalo', 'landmark',
        'MX', 17.0609, -96.7253, ?, ?)
    `).run(now, now);
    db.raw.prepare(`
      INSERT INTO project_scenes(
        id, project_id, script_version_id, ordinal, chapter, narration,
        target_duration_ms, required_country, required_city, required_location,
        required_place_id, required_granularity, required_objects_json,
        required_activities_json, preferred_shots_json, visual_treatment,
        score_explanation_json, verification_state, created_at, updated_at
      ) VALUES('scene-graphic', 'project-graphic', 'script-graphic', 1, 'Orientation',
        'Oaxaca.', 1800, 'Mexico', 'Oaxaca', 'Zocalo', 'place-graphic', 'landmark',
        '[]', '[]', '[]', 'MAP_OR_GRAPHIC', '[]', 'graphic', ?, ?)
    `).run(now, now);
    db.raw.prepare(`
      INSERT INTO voice_assets(
        id, project_id, provider, model, voice_id, settings_json, pronunciation_hash,
        input_hash, text, audio_path, duration_ms, timing_method, status, created_at, updated_at
      ) VALUES('voice-graphic', 'project-graphic', 'test', 'test', 'test', '{}',
        'pronunciation', 'voice-graphic-input', 'Oaxaca.', ?, 1200, 'provider_word', 'ready', ?, ?)
    `).run(narrationPath, now, now);
    db.raw.prepare(`
      INSERT INTO narration_sections(
        id, project_id, script_version_id, voice_asset_id, ordinal, chapter,
        scene_ids_json, text, pronunciation_json, duration_ms, status, created_at, updated_at
      ) VALUES('section-graphic', 'project-graphic', 'script-graphic', 'voice-graphic', 1,
        'Orientation', '["scene-graphic"]', 'Oaxaca.', '{}', 1200, 'ready', ?, ?)
    `).run(now, now);
    db.raw.prepare(`
      INSERT INTO narration_words(
        id, section_id, scene_id, ordinal, word, start_ms, end_ms, confidence, timing_method
      ) VALUES('word-graphic', 'section-graphic', 'scene-graphic', 1, 'Oaxaca.', 100, 900, 0.99, 'provider_word')
    `).run();
    const graphicProject = {
      id: 'project-graphic', slug: 'graphic-fixture', title: 'Graphic Fixture',
      topic: 'Oaxaca', destination: 'Oaxaca', description: null,
      scriptVersionId: 'script-graphic',
      scenes: [{ id: 'scene-graphic', ordinal: 1, chapter: 'Orientation', targetDurationMs: 1800 }],
      packaging: []
    } as unknown as ProjectDetail;
    const states = new ProjectStateService(db);
    const graphicService = new RenderService(
      db,
      () => ({
        outputFolder: join(root, 'output'), projectFolder: join(root, 'projects'),
        ffmpegPath, ffprobePath: ffprobeStatic.path, hardShotMaxSeconds: 7,
        channelName: 'Fixture Channel', channelShort: 'FC'
      } as unknown as AppSettings),
      new JobService(db),
      { states, get: () => graphicProject } as never,
      () => undefined
    );
    const draft = await graphicService.render('project-graphic', 'draft');
    expect(draft.state).toBe('SUCCEEDED');
    expect(existsSync(draft.outputPath!)).toBe(true);
    const manifest = JSON.parse(readFileSync(draft.manifestPath!, 'utf8')) as {
      scenes: Array<{ visualTreatment: string; editingPlan: { sourceKind: string; mapMode: string } }>;
    };
    expect(manifest.scenes).toEqual([
      expect.objectContaining({
        visualTreatment: 'MAP_OR_GRAPHIC',
        editingPlan: expect.objectContaining({ sourceKind: 'generated_graphic', mapMode: 'coordinate_plot' })
      })
    ]);
    expect(db.raw.prepare(`
      SELECT code FROM qc_results WHERE render_id = ? AND status = 'fail' AND severity IN ('BLOCKER','HIGH')
    `).all(draft.id)).toEqual([]);
  }, 60_000);
});
