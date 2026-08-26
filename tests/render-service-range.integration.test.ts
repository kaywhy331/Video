import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { AppDatabase } from '@main/database/database';
import { JobService } from '@main/services/job-service';
import { ProjectService } from '@main/services/project-service';
import { RenderService } from '@main/services/render-service';
import { MediaService } from '@main/services/media-service';
import { requireSuccess } from '@main/services/process-utils';
import type { AppSettings } from '@shared/types';

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
    const sourceProbe = await requireSuccess(ffprobeStatic.path, [
      '-v', 'error', '-show_format', '-show_streams', '-of', 'json', sourcePath
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
      hardShotMaxSeconds: 7,
      defaultOutput: 'qualified_4k'
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

  it('generates and validates the final package before the automatic private-upload handoff', async () => {
    const supersededRender = db.raw.prepare(`
      SELECT id FROM renders WHERE project_id = 'project-1' AND kind = 'draft' AND state = 'SUCCEEDED'
      ORDER BY completed_at DESC LIMIT 1
    `).get() as { id: string };
    const now = new Date().toISOString();
    for (const [id, stage, code] of [
      ['stale-render-exception', 'render', 'RENDER_FAILED'],
      ['stale-qc-exception', 'render_qc', 'QC_STALE_TEST']
    ] as const) {
      db.raw.prepare(`
        INSERT INTO exceptions(
          id, project_id, severity, stage, code, title, message,
          evidence_json, recommended_action, status, created_at
        ) VALUES(?, 'project-1', 'BLOCKER', ?, ?, 'Prior render failed',
          'Prior artifact requires replacement', ?, 'Render and verify a replacement.', 'OPEN', ?)
      `).run(id, stage, code, JSON.stringify({ renderId: supersededRender.id }), now);
    }
    db.raw.prepare(`
      INSERT INTO exceptions(
        id, project_id, severity, stage, code, title, message,
        evidence_json, recommended_action, status, created_at
      ) VALUES('unrelated-media-exception', 'project-1', 'HIGH', 'media',
        'MEDIA_TEST', 'Media exception', 'Still requires operator work', '{}',
        'Resolve media evidence.', 'OPEN', ?)
    `).run(now);

    const final = await service.render('project-1', 'final');
    expect(final.state).toBe('SUCCEEDED');
    expect(final.profile).toBe('final_1080p');
    expect(existsSync(final.outputPath!)).toBe(true);
    expect(db.raw.prepare(`SELECT state FROM projects WHERE id = 'project-1'`).get())
      .toEqual({ state: 'QC_FINAL' });
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
    expect(db.raw.prepare(`
      SELECT id, status FROM exceptions
      WHERE id IN ('stale-render-exception','stale-qc-exception','unrelated-media-exception')
      ORDER BY id
    `).all()).toEqual([
      { id: 'stale-qc-exception', status: 'RESOLVED' },
      { id: 'stale-render-exception', status: 'RESOLVED' },
      { id: 'unrelated-media-exception', status: 'OPEN' }
    ]);
    expect(db.raw.prepare(`
      SELECT count(*) AS count FROM audit_log
      WHERE project_id = 'project-1' AND action = 'exception.auto_resolved'
    `).get()).toEqual({ count: 2 });
  }, 60_000);

  it('reports exact 4K blockers and falls back truthfully to the 1080p final profile', async () => {
    const blockers = service.fourKBlockers('project-1');
    expect(blockers).toEqual([
      expect.objectContaining({
        sceneOrdinal: 1,
        effectiveWidth: 1920,
        effectiveHeight: 1080,
        reason: expect.stringContaining('below 3840×2160')
      })
    ]);
    expect(db.raw.prepare(`
      SELECT profile, width, height FROM renders
      WHERE project_id = 'project-1' AND kind = 'final' AND state = 'SUCCEEDED'
      ORDER BY completed_at DESC LIMIT 1
    `).get()).toEqual({ profile: 'final_1080p', width: 1920, height: 1080 });
  });

  it('reuses an identical verified final artifact during an automatic repair', async () => {
    const original = db.raw.prepare(`
      SELECT id, sha256, output_path FROM renders
      WHERE project_id = 'project-1' AND kind = 'final' AND state = 'SUCCEEDED'
      ORDER BY completed_at DESC LIMIT 1
    `).get() as { id: string; sha256: string; output_path: string };
    const now = new Date().toISOString();
    db.raw.prepare(`
      INSERT INTO repair_attempts(
        id, project_id, render_id, failure_code, repair_class, action, status,
        attempt_number, maximum_attempts, target_state, evidence_json, created_at
      ) VALUES('identical-final-repair', 'project-1', ?, 'FINAL_MEDIA_PROFILE',
        'automatic', 'Rebuild the final artifact.', 'routed', 1, 2,
        'QC_DRAFT', '{}', ?)
    `).run(original.id, now);
    db.raw.prepare(`UPDATE projects SET state = 'QC_DRAFT', updated_at = ? WHERE id = 'project-1'`).run(now);

    const repaired = await service.render('project-1', 'final');

    expect(repaired).toMatchObject({
      id: original.id,
      sha256: original.sha256,
      outputPath: original.output_path,
      state: 'SUCCEEDED'
    });
    expect(db.raw.prepare(`
      SELECT count(*) AS count FROM renders
      WHERE project_id = 'project-1' AND kind = 'final'
    `).get()).toEqual({ count: 1 });
    expect(db.raw.prepare(`
      SELECT status FROM repair_attempts WHERE id = 'identical-final-repair'
    `).get()).toEqual({ status: 'verified' });
    expect(db.raw.prepare(`
      SELECT count(*) AS count FROM audit_log
      WHERE project_id = 'project-1' AND action = 'render.identical_artifact_reused'
    `).get()).toEqual({ count: 1 });
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
    const graphicProjects = new ProjectService(
      db,
      {} as never,
      {} as never,
      () => ({
        outputFolder: join(root, 'output'), projectFolder: join(root, 'projects'),
        ffmpegPath, ffprobePath: ffprobeStatic.path, hardShotMaxSeconds: 7,
        defaultOutput: 'qualified_4k', channelName: 'Fixture Channel', channelShort: 'FC'
      } as unknown as AppSettings),
      {} as never
    );
    const graphicService = new RenderService(
      db,
      () => ({
        outputFolder: join(root, 'output'), projectFolder: join(root, 'projects'),
        ffmpegPath, ffprobePath: ffprobeStatic.path, hardShotMaxSeconds: 7,
        defaultOutput: 'qualified_4k',
        channelName: 'Fixture Channel', channelShort: 'FC'
      } as unknown as AppSettings),
      new JobService(db),
      graphicProjects,
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
    const final = await graphicService.render('project-graphic', 'final');
    expect(final).toMatchObject({ profile: 'final_4k', width: 3840, height: 2160, state: 'SUCCEEDED' });
    expect(db.raw.prepare(`
      SELECT code FROM qc_results WHERE render_id = ? AND status = 'fail' AND severity IN ('BLOCKER','HIGH')
    `).all(final.id)).toEqual([]);
  }, 480_000);
});
