import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase } from '@main/database/database';
import { RepairService } from '@main/services/repair-service';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createDatabase(): { db: AppDatabase; repair: RepairService } {
  const root = mkdtempSync(join(tmpdir(), 'videofactory-repairs-'));
  roots.push(root);
  const db = new AppDatabase(join(root, 'videofactory.sqlite'));
  const now = new Date().toISOString();
  db.raw.prepare(`
    INSERT INTO projects(
      id, sequence, slug, title, topic, state, progress, envato_project_name,
      target_duration_ms, created_at, updated_at
    ) VALUES('project-1', 1, 'project-1', 'Project', 'Topic', 'VERIFYING_FOOTAGE', 0.5,
      'YT-TEST-0001', 300000, ?, ?)
  `).run(now, now);
  db.raw.prepare(`
    INSERT INTO script_versions(
      id, project_id, version_number, title, topic, script_json, generation_reason,
      provider, model, input_hash, locked, created_at
    ) VALUES('script-1', 'project-1', 1, 'Script', 'Topic', '{}', 'test',
      'mock', 'mock', 'input', 1, ?)
  `).run(now);
  return { db, repair: new RepairService(db) };
}

function addAsset(
  db: AppDatabase,
  id: string,
  options: { local?: boolean; availability?: string; url?: string } = {}
): void {
  const now = new Date().toISOString();
  db.raw.prepare(`
    INSERT INTO assets(
      id, stable_key, title, canonical_page_url, country, city, location_name,
      orientation, location_granularity,
      location_confidence, verification_status, availability_status, local_file_id,
      raw_row_json, imported_at, updated_at
    ) VALUES(?, ?, ?, ?, 'France', 'Paris', 'Eiffel Tower', 'landscape', 'landmark',
      0.95, 'human_verified', ?, ?, '{}', ?, ?)
  `).run(
    id,
    `stable-${id}`,
    `Asset ${id}`,
    options.url ?? `https://elements.envato.com/${id}`,
    options.availability ?? 'available',
    options.local ? `file-${id}` : null,
    now,
    now
  );
}

function addScene(db: AppDatabase): void {
  const now = new Date().toISOString();
  db.raw.prepare(`
    INSERT INTO project_scenes(
      id, project_id, script_version_id, ordinal, narration, target_duration_ms,
      required_country, required_city, required_location, required_granularity,
      required_objects_json, required_activities_json, preferred_shots_json,
      visual_treatment, selected_asset_id, selected_file_id, selected_segment_id,
      score, score_explanation_json, verification_state, created_at, updated_at
    ) VALUES('scene-1', 'project-1', 'script-1', 1, 'Scene narration', 4000,
      'France', 'Paris', 'Eiffel Tower', 'landmark', '[]', '[]', '[]',
      'EXACT_LOCATION_FOOTAGE', 'primary', NULL, NULL, 90, '[]', 'rejected', ?, ?)
  `).run(now, now);
}

function addCandidate(db: AppDatabase, assetId: string, rank: number, status = 'alternate'): void {
  const now = new Date().toISOString();
  db.raw.prepare(`
    INSERT INTO shot_candidates(
      id, project_id, scene_id, asset_id, candidate_rank, candidate_score,
      score_components_json, explanation_json, status, created_at, updated_at
    ) VALUES(?, 'project-1', 'scene-1', ?, ?, ?, '{}', ?, ?, ?, ?)
  `).run(
    `candidate-${assetId}`,
    assetId,
    rank,
    90 - rank,
    JSON.stringify([`Candidate rank ${rank}`]),
    status,
    now,
    now
  );
}

function addReadyMedia(db: AppDatabase, assetId: string): void {
  const now = new Date().toISOString();
  db.raw.prepare(`
    INSERT INTO asset_files(
      id, asset_id, sha256, original_path, original_file_name, file_size_bytes,
      duration_ms, width, height, frame_rate, codec, audio_present,
      raw_ffprobe_json, pipeline_version, created_at
    ) VALUES(?, ?, ?, ?, ?, 1024, 6000, 1920, 1080, 30, 'h264', 0, '{}', 'test', ?)
  `).run(`file-${assetId}`, assetId, `sha-${assetId}`, process.execPath, `${assetId}.mp4`, now);
  db.raw.prepare(`
    INSERT INTO media_segments(
      id, asset_file_id, start_ms, end_ms, duration_ms, quality_score,
      black_frame_risk, freeze_risk, effective_width, effective_height,
      eligible_1080p, eligible_4k, pipeline_version, created_at
    ) VALUES(?, ?, 0, 5000, 5000, 95, 0, 0, 1920, 1080, 1, 0, 'test', ?)
  `).run(`segment-${assetId}`, `file-${assetId}`, now);
  db.raw.prepare(`
    INSERT INTO project_licenses(
      id, project_id, asset_id, license_state, envato_project_name,
      created_at, updated_at
    ) VALUES(?, 'project-1', ?, 'VERIFIED', 'YT-TEST-0001', ?, ?)
  `).run(`license-${assetId}`, assetId, now, now);
}

describe('automated repair service', () => {
  it('promotes only a downloaded, safe, licensed alternate and records provenance', () => {
    const { db, repair } = createDatabase();
    addAsset(db, 'primary');
    addAsset(db, 'alternate', { local: true });
    addScene(db);
    addCandidate(db, 'primary', 1, 'selected');
    addCandidate(db, 'alternate', 2);
    addReadyMedia(db, 'alternate');

    const route = repair.routeFootageFailure('project-1', 'scene-1', 'NO_SAFE_SEGMENT', {
      rejectedFileId: 'bad-file'
    });

    expect(route).toMatchObject({ status: 'verified', replacementAssetId: 'alternate' });
    expect(db.raw.prepare(`
      SELECT selected_asset_id, selected_file_id, selected_segment_id, verification_state
      FROM project_scenes WHERE id = 'scene-1'
    `).get()).toEqual({
      selected_asset_id: 'alternate',
      selected_file_id: 'file-alternate',
      selected_segment_id: 'segment-alternate',
      verification_state: 'verified'
    });
    expect(db.raw.prepare(`
      SELECT status, replacement_asset_id, replacement_file_id, replacement_segment_id
      FROM repair_attempts
    `).get()).toEqual({
      status: 'verified',
      replacement_asset_id: 'alternate',
      replacement_file_id: 'file-alternate',
      replacement_segment_id: 'segment-alternate'
    });
    expect(db.raw.prepare(`
      SELECT action FROM audit_log WHERE action = 'repair.alternate_selected'
    `).get()).toEqual({ action: 'repair.alternate_selected' });
    db.close();
  });

  it('queues the next exact-location candidate without pretending it is verified', () => {
    const { db, repair } = createDatabase();
    addAsset(db, 'primary');
    addAsset(db, 'alternate');
    addScene(db);
    addCandidate(db, 'primary', 1, 'selected');
    addCandidate(db, 'alternate', 2);

    const route = repair.routeFootageFailure('project-1', 'scene-1', 'NO_SAFE_SEGMENT');

    expect(route).toMatchObject({ status: 'waiting_acquisition', replacementAssetId: 'alternate' });
    expect(db.raw.prepare(`
      SELECT role, state, required_scene_ordinals_json FROM acquisition_items
      WHERE asset_id = 'alternate'
    `).get()).toEqual({
      role: 'alternate',
      state: 'READY_TO_OPEN',
      required_scene_ordinals_json: '[1]'
    });
    expect(db.raw.prepare(`
      SELECT selected_asset_id, verification_state FROM project_scenes WHERE id = 'scene-1'
    `).get()).toEqual({ selected_asset_id: 'primary', verification_state: 'rejected' });
    db.close();
  });

  it('rejects a candidate whose catalog geography changed after ranking', () => {
    const { db, repair } = createDatabase();
    addAsset(db, 'primary');
    addAsset(db, 'wrong-place', { local: true });
    addAsset(db, 'safe-place', { local: true });
    addScene(db);
    addCandidate(db, 'primary', 1, 'selected');
    addCandidate(db, 'wrong-place', 2);
    addCandidate(db, 'safe-place', 3);
    addReadyMedia(db, 'wrong-place');
    addReadyMedia(db, 'safe-place');
    db.raw.prepare(`
      UPDATE assets SET country = 'Italy', city = 'Rome', location_name = 'Colosseum'
      WHERE id = 'wrong-place'
    `).run();

    const route = repair.routeFootageFailure('project-1', 'scene-1', 'NO_SAFE_SEGMENT');

    expect(route).toMatchObject({ status: 'verified', replacementAssetId: 'safe-place' });
    expect(db.raw.prepare(`
      SELECT status FROM shot_candidates WHERE asset_id = 'wrong-place'
    `).get()).toEqual({ status: 'rejected' });
    db.close();
  });

  it('tries at most two alternates and then fails closed', () => {
    const { db, repair } = createDatabase();
    addAsset(db, 'primary');
    addAsset(db, 'alternate-1');
    addAsset(db, 'alternate-2');
    addScene(db);
    addCandidate(db, 'primary', 1, 'selected');
    addCandidate(db, 'alternate-1', 2);
    addCandidate(db, 'alternate-2', 3);

    expect(repair.routeFootageFailure('project-1', 'scene-1', 'NO_SAFE_SEGMENT').replacementAssetId)
      .toBe('alternate-1');
    db.raw.prepare(`
      UPDATE acquisition_items SET state = 'FAILED' WHERE asset_id = 'alternate-1'
    `).run();
    expect(repair.routeFootageFailure('project-1', 'scene-1', 'NO_SAFE_SEGMENT').replacementAssetId)
      .toBe('alternate-2');
    db.raw.prepare(`
      UPDATE acquisition_items SET state = 'FAILED' WHERE asset_id = 'alternate-2'
    `).run();
    expect(repair.routeFootageFailure('project-1', 'scene-1', 'NO_SAFE_SEGMENT').status)
      .toBe('exhausted');
    expect(db.raw.prepare(`
      SELECT max(attempt_number) AS attempts FROM repair_attempts
      WHERE scene_id = 'scene-1'
    `).get()).toEqual({ attempts: 2 });
    expect(db.raw.prepare(`
      SELECT verification_state FROM project_scenes WHERE id = 'scene-1'
    `).get()).toEqual({ verification_state: 'rejected' });
    expect(db.raw.prepare(`
      SELECT code FROM exceptions WHERE project_id = 'project-1' AND status = 'OPEN'
    `).get()).toEqual({ code: 'NO_SAFE_FOOTAGE_ALTERNATE' });
    db.close();
  });

  it('classifies final QC, increments bounded retries, and preserves safety failures for operators', () => {
    const { db, repair } = createDatabase();
    const now = new Date().toISOString();
    db.raw.prepare(`
      INSERT INTO renders(id, project_id, kind, profile, state, artifact_version, created_at)
      VALUES('render-1', 'project-1', 'final', 'final_1080p', 'SUCCEEDED', 1, ?)
    `).run(now);
    for (const [id, code, category] of [
      ['qc-1', 'FINAL_MEDIA_PROFILE', 'media'],
      ['qc-2', 'LICENSE_STATE', 'rights']
    ]) {
      db.raw.prepare(`
        INSERT INTO qc_results(
          id, project_id, render_id, category, code, severity, status,
          message, evidence_json, created_at
        ) VALUES(?, 'project-1', 'render-1', ?, ?, 'BLOCKER', 'fail', ?, '{}', ?)
      `).run(id, category, code, `${code} failed`, now);
    }

    const route = repair.routeQcFailures('project-1', 'render-1', [
      { id: 'qc-1', code: 'FINAL_MEDIA_PROFILE', category: 'media', severity: 'BLOCKER', message: 'profile', evidenceJson: '{}' },
      { id: 'qc-2', code: 'LICENSE_STATE', category: 'rights', severity: 'BLOCKER', message: 'license', evidenceJson: '{}' }
    ]);

    expect(route).toMatchObject({ retryAutomatically: false, operatorRequired: true });
    expect(db.raw.prepare(`
      SELECT repair_class, repair_attempted FROM qc_results WHERE id = 'qc-1'
    `).get()).toEqual({ repair_class: 'automatic', repair_attempted: 0 });
    expect(db.raw.prepare(`
      SELECT repair_class, repair_attempted FROM qc_results WHERE id = 'qc-2'
    `).get()).toEqual({ repair_class: 'operator', repair_attempted: 0 });
    db.close();
  });
});
