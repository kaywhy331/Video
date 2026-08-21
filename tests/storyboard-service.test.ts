import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase } from '@main/database/database';
import { PlaceService } from '@main/services/place-service';
import { ProjectService } from '@main/services/project-service';
import { StoryboardService } from '@main/services/storyboard-service';
import type { AppSettings } from '@shared/types';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function insertAcceptedClaim(
  db: AppDatabase,
  input: { id: string; text: string; category?: string }
): void {
  const now = new Date().toISOString();
  const sourceId = `source-${input.id}`;
  db.raw.prepare(`
    INSERT INTO research_sources(
      id, project_id, url, title, accessed_at, source_type, status
    ) VALUES(?, 'project-1', ?, ?, ?, 'primary', 'active')
  `).run(sourceId, `https://example.com/research/${input.id}`, `Source for ${input.id}`, now);
  db.raw.prepare(`
    INSERT INTO fact_claims(
      id, project_id, text, category, confidence, stability,
      source_ids_json, status, material, created_at
    ) VALUES(?, 'project-1', ?, ?, 1, 'stable', ?, 'staged', 1, ?)
  `).run(input.id, input.text, input.category ?? 'fact', JSON.stringify([sourceId]), now);
  db.raw.prepare(`
    INSERT INTO fact_claim_sources(claim_id, source_id, support_type, created_at)
    VALUES(?, ?, 'supports', ?)
  `).run(input.id, sourceId, now);
  db.raw.prepare(`UPDATE fact_claims SET status = 'accepted', updated_at = ? WHERE id = ?`)
    .run(now, input.id);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'videofactory-storyboard-'));
  roots.push(root);
  const db = new AppDatabase(join(root, 'db.sqlite'));
  const places = new PlaceService(db);
  const now = new Date().toISOString();
  const requiredPlace = places.ensureHierarchy({
    country: 'France', city: 'Paris', location: 'Eiffel Tower', granularity: 'landmark'
  })!;
  db.raw.prepare(`
    INSERT INTO projects(
      id, sequence, slug, title, topic, state, resume_state, progress,
      envato_project_name, target_duration_ms, script_version_id,
      youtube_video_id, created_at, updated_at
    ) VALUES('project-1', 1, 'project-1', 'Project', 'Topic', 'BLOCKED_EXCEPTION',
      'VERIFYING_FOOTAGE', 0.6, 'YT-TEST-0001', 300000, 'script-1', 'video-old', ?, ?)
  `).run(now, now);
  db.raw.prepare(`
    INSERT INTO script_versions(
      id, project_id, version_number, title, topic, script_json, generation_reason,
      provider, model, input_hash, locked, script_type, locked_at, created_at
    ) VALUES('script-1', 'project-1', 1, 'Script', 'Topic',
      '{"scenes":[{"sceneId":"scene-1","narration":"Original narration"}]}',
      'test', 'mock', 'mock', 'input', 1, 'final', ?, ?)
  `).run(now, now);
  for (const id of ['primary', 'alternate']) {
    db.raw.prepare(`
      INSERT INTO assets(
        id, stable_key, title, thumbnail_url, country, city, location_name,
        orientation, location_granularity, location_confidence,
        verification_status, availability_status, local_file_id,
        raw_row_json, imported_at, updated_at
      ) VALUES(?, ?, ?, ?, 'France', 'Paris', 'Eiffel Tower', 'landscape',
        'landmark', 1, 'human_verified', 'available', ?, '{}', ?, ?)
    `).run(id, `stable-${id}`, `Asset ${id}`, `https://example.com/${id}.jpg`, `file-${id}`, now, now);
    db.raw.prepare(`
      INSERT INTO asset_files(
        id, asset_id, sha256, original_path, original_file_name, file_size_bytes,
        duration_ms, width, height, frame_rate, codec, audio_present,
        raw_ffprobe_json, pipeline_version, created_at
      ) VALUES(?, ?, ?, ?, ?, 1000, 6000, 1920, 1080, 30, 'h264', 0, '{}', 'test', ?)
    `).run(`file-${id}`, id, `sha-${id}`, process.execPath, `${id}.mp4`, now);
    db.raw.prepare(`
      INSERT INTO media_segments(
        id, asset_file_id, start_ms, end_ms, duration_ms, quality_score,
        black_frame_risk, freeze_risk, effective_width, effective_height,
        eligible_1080p, eligible_4k, pipeline_version, created_at
      ) VALUES(?, ?, 0, 5000, 5000, 1, 0, 0, 1920, 1080, 1, 0, 'test', ?)
    `).run(`segment-${id}`, `file-${id}`, now);
    db.raw.prepare(`
      INSERT INTO project_licenses(
        id, project_id, asset_id, license_state, envato_project_name,
        operator_attested_at, verified_at, created_at, updated_at
      ) VALUES(?, 'project-1', ?, 'VERIFIED', 'YT-TEST-0001', ?, ?, ?, ?)
    `).run(`license-${id}`, id, now, now, now, now);
    places.syncAsset(id, 'human');
  }
  db.raw.prepare(`
    INSERT INTO project_scenes(
      id, project_id, script_version_id, ordinal, chapter, narration,
      target_duration_ms, required_country, required_city, required_location,
      required_granularity, required_place_id, required_objects_json,
      required_activities_json, preferred_shots_json, visual_treatment,
      selected_asset_id, selected_file_id, selected_segment_id, score,
      score_explanation_json, verification_state, pronunciation_json,
      created_at, updated_at
    ) VALUES('scene-1', 'project-1', 'script-1', 1, 'Opening', 'Original narration',
      5000, 'France', 'Paris', 'Eiffel Tower', 'landmark', ?, '[]', '[]', '[]',
      'EXACT_LOCATION_FOOTAGE', 'primary', 'file-primary', 'segment-primary', 90,
      '["Primary"]', 'rejected', '{}', ?, ?)
  `).run(requiredPlace.id, now, now);
  for (const [id, assetId, rank, status] of [
    ['candidate-primary', 'primary', 1, 'selected'],
    ['candidate-alternate', 'alternate', 2, 'alternate']
  ] as const) {
    db.raw.prepare(`
      INSERT INTO shot_candidates(
        id, project_id, scene_id, asset_id, candidate_rank, candidate_score,
        score_components_json, explanation_json, status, created_at, updated_at
      ) VALUES(?, 'project-1', 'scene-1', ?, ?, ?, '{}', ?, ?, ?, ?)
    `).run(id, assetId, rank, 95 - rank, JSON.stringify([`Rank ${rank}`]), status, now, now);
    db.raw.prepare(`
      INSERT INTO footage_verifications(
        id, project_id, scene_id, asset_id, asset_file_id, provider, model,
        input_hash, status, geography_status, semantic_status, confidence,
        required_place_id, observed_place_id, assessment_json, evidence_json, created_at
      ) VALUES(?, 'project-1', 'scene-1', ?, ?, 'test', 'test', ?, 'verified',
        'match', 'not_required', 1, ?, ?, '{}', '{}', ?)
    `).run(`verification-${assetId}`, assetId, `file-${assetId}`, `input-${assetId}`, requiredPlace.id, requiredPlace.id, now);
  }
  db.raw.prepare(`
    INSERT INTO voice_assets(
      id, project_id, provider, model, voice_id, settings_json, pronunciation_hash,
      input_hash, text, audio_path, duration_ms, timing_method, status, created_at, updated_at
    ) VALUES('voice-1', 'project-1', 'test', 'test', 'voice', '{}', 'pron', 'voice-input',
      'Original narration', ?, 1000, 'provider_word', 'ready', ?, ?)
  `).run(process.execPath, now, now);
  db.raw.prepare(`
    INSERT INTO narration_sections(
      id, project_id, script_version_id, voice_asset_id, ordinal, chapter,
      scene_ids_json, text, pronunciation_json, duration_ms, status, created_at, updated_at
    ) VALUES('section-1', 'project-1', 'script-1', 'voice-1', 1, 'Opening',
      '["scene-1"]', 'Original narration', '{}', 1000, 'ready', ?, ?)
  `).run(now, now);
  db.raw.prepare(`
    INSERT INTO narration_words(
      id, section_id, scene_id, ordinal, word, start_ms, end_ms, confidence, timing_method
    ) VALUES('word-1', 'section-1', 'scene-1', 1, 'Original', 0, 500, 1, 'provider_word'),
      ('word-2', 'section-1', 'scene-1', 2, 'narration', 500, 1000, 1, 'provider_word')
  `).run();
  db.raw.prepare(`
    INSERT INTO renders(
      id, project_id, kind, profile, state, output_path, sha256,
      artifact_version, created_at, completed_at
    ) VALUES('render-old', 'project-1', 'final', 'final_1080p', 'SUCCEEDED', ?,
      'render-old-sha', 1, ?, ?)
  `).run(process.execPath, now, now);
  db.raw.prepare(`UPDATE projects SET final_render_id = 'render-old' WHERE id = 'project-1'`).run();
  db.raw.prepare(`
    INSERT INTO packaging_candidates(
      id, project_id, ordinal, title, angle, viewer_promise, description,
      chapters, tags_json, risk_status, selected, created_at
    ) VALUES('package-1', 'project-1', 1, 'Title', 'Angle', 'Promise', 'Description',
      '00:00 Opening', '[]', 'pass', 1, ?)
  `).run(now);
  db.raw.prepare(`
    INSERT INTO publication_records(
      id, project_id, video_id, privacy_status, final_sha256, selected_package_id,
      approval_hash, approved_at, created_at, updated_at
    ) VALUES('publication-1', 'project-1', 'video-old', 'private', 'render-old-sha',
      'package-1', 'approval-old', ?, ?, ?)
  `).run(now, now, now);
  db.raw.prepare(`
    INSERT INTO exceptions(
      id, project_id, severity, stage, code, title, message, evidence_json,
      recommended_action, status, created_at
    ) VALUES('exception-1', 'project-1', 'BLOCKER', 'media', 'NO_SAFE_FOOTAGE_ALTERNATE',
      'No alternate', 'No alternate', '{"sceneId":"scene-1"}', 'Repair scene', 'OPEN', ?)
  `).run(now);

  const projects = new ProjectService(
    db,
    {} as never,
    {} as never,
    () => ({
      outputProfileSnapshot: { width: 1920, height: 1080 }
    }) as unknown as AppSettings,
    places
  );
  const verifyScene = vi.fn(async () => ({
    id: 'human-verification',
    inputHash: 'human-input',
    provider: 'local_policy',
    model: 'none',
    cached: false,
    status: 'verified' as const,
    geographyStatus: 'match' as const,
    semanticStatus: 'not_required' as const,
    confidence: 1,
    reasons: ['Human geography evidence and semantic policy passed.']
  }));
  const service = new StoryboardService(db, projects, projects.repairs, places, { verifyScene });
  return { db, places, projects, service, verifyScene, requiredPlace };
}

describe('workflow-locked storyboard recovery', () => {
  it('compares candidates and replaces a shot only with fully verified media', () => {
    const { db, service } = fixture();
    const recovery = service.getRecoveryScene('project-1', 'scene-1');
    expect(recovery.editable).toBe(true);
    expect(recovery.candidates.map(candidate => ({ id: candidate.id, ready: candidate.ready })))
      .toEqual([
        { id: 'candidate-primary', ready: true },
        { id: 'candidate-alternate', ready: true }
      ]);

    const result = service.replaceShot({
      projectId: 'project-1',
      sceneId: 'scene-1',
      candidateId: 'candidate-alternate',
      reason: 'The alternate better matches the requested framing.'
    });

    expect(result).toMatchObject({ action: 'replace_shot', nextAction: 'render_range' });
    expect(result.project).toMatchObject({
      state: 'BUILDING_TIMELINE', finalRenderId: null, finalRenderPath: null, youtubeVideoId: null
    });
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
      SELECT parent_id, locked, provider, model FROM script_versions
      WHERE id = (SELECT script_version_id FROM projects WHERE id = 'project-1')
    `).get()).toEqual({ parent_id: 'script-1', locked: 1, provider: 'operator', model: 'manual-recovery' });
    expect(db.raw.prepare(`
      SELECT count(*) AS count FROM narration_sections
      WHERE script_version_id = (SELECT script_version_id FROM projects WHERE id = 'project-1')
    `).get()).toEqual({ count: 1 });
    expect(db.raw.prepare(`SELECT status FROM exceptions WHERE id = 'exception-1'`).get())
      .toEqual({ status: 'RESOLVED' });
    expect(db.raw.prepare(`SELECT risk_status FROM packaging_candidates WHERE id = 'package-1'`).get())
      .toEqual({ risk_status: 'blocked' });
    expect(db.raw.prepare(`SELECT approval_hash FROM publication_records WHERE id = 'publication-1'`).get())
      .toEqual({ approval_hash: null });
    expect(db.raw.prepare(`SELECT locked_by_job_id FROM projects WHERE id = 'project-1'`).get())
      .toEqual({ locked_by_job_id: null });
    expect(db.raw.prepare(`
      SELECT actor FROM audit_log WHERE action = 'storyboard.replace_shot'
    `).get()).toEqual({ actor: 'human' });
    db.close();
  });

  it('rolls back a replacement that lacks a complete safety receipt', () => {
    const { db, service } = fixture();
    db.raw.prepare(`DELETE FROM footage_verifications WHERE asset_id = 'alternate'`).run();
    expect(() => service.replaceShot({
      projectId: 'project-1',
      sceneId: 'scene-1',
      candidateId: 'candidate-alternate',
      reason: 'Try unsafe alternate'
    })).toThrow('fully verified');
    expect(db.raw.prepare(`
      SELECT selected_asset_id FROM project_scenes WHERE id = 'scene-1'
    `).get()).toEqual({ selected_asset_id: 'primary' });
    expect(db.raw.prepare(`SELECT count(*) AS count FROM script_versions`).get()).toEqual({ count: 1 });
    expect(db.raw.prepare(`SELECT locked_by_job_id FROM projects WHERE id = 'project-1'`).get())
      .toEqual({ locked_by_job_id: null });
    db.close();
  });

  it('keeps paused projects read-only until the operator explicitly resumes them', () => {
    const { db, service } = fixture();
    db.raw.prepare(`UPDATE projects SET state = 'PAUSED' WHERE id = 'project-1'`).run();
    expect(service.getRecoveryScene('project-1', 'scene-1')).toMatchObject({
      editable: false,
      editBlockedReason: expect.stringContaining('PAUSED')
    });
    expect(() => service.replaceShot({
      projectId: 'project-1',
      sceneId: 'scene-1',
      candidateId: 'candidate-alternate',
      reason: 'Do not implicitly resume this project.'
    })).toThrow('unavailable while the project is PAUSED');
    expect(db.raw.prepare(`SELECT state FROM projects WHERE id = 'project-1'`).get()).toEqual({ state: 'PAUSED' });
    db.close();
  });

  it('versions a narration rewrite and assigns an evidence-bound graphic without stale approval', () => {
    const rewritten = fixture();
    const rewrite = rewritten.service.rewriteBeat({
      projectId: 'project-1',
      sceneId: 'scene-1',
      narration: 'A narrower visual introduction.',
      reason: 'Match the verified visual scope.'
    });
    expect(rewrite).toMatchObject({ action: 'rewrite_beat', nextAction: 'continue_workflow' });
    expect(rewrite.project.state).toBe('GENERATING_VOICE');
    expect(rewritten.db.raw.prepare(`
      SELECT narration FROM project_scenes WHERE id = 'scene-1'
    `).get()).toEqual({ narration: 'A narrower visual introduction.' });
    expect(rewritten.db.raw.prepare(`
      SELECT count(*) AS count FROM narration_sections
      WHERE script_version_id = (SELECT script_version_id FROM projects WHERE id = 'project-1')
    `).get()).toEqual({ count: 0 });
    rewritten.db.close();

    const graphic = fixture();
    const result = graphic.service.useGraphic({
      projectId: 'project-1',
      sceneId: 'scene-1',
      treatment: 'MAP_OR_GRAPHIC',
      reason: 'Use the verified canonical place record.'
    });
    expect(result).toMatchObject({ action: 'use_graphic', nextAction: 'render_range' });
    expect(graphic.db.raw.prepare(`
      SELECT visual_treatment, selected_asset_id, selected_file_id, verification_state
      FROM project_scenes WHERE id = 'scene-1'
    `).get()).toEqual({
      visual_treatment: 'MAP_OR_GRAPHIC',
      selected_asset_id: null,
      selected_file_id: null,
      verification_state: 'graphic'
    });
    graphic.db.close();
  });

  it('requires canonical or accepted evidence for graphics and rejects narrated footage-only claims', () => {
    const missingEvidence = fixture();
    missingEvidence.db.raw.prepare(`
      UPDATE project_scenes SET required_place_id = NULL WHERE id = 'scene-1'
    `).run();
    expect(() => missingEvidence.service.useGraphic({
      projectId: 'project-1', sceneId: 'scene-1', treatment: 'MAP_OR_GRAPHIC',
      reason: 'Raw location labels alone are not evidence.'
    })).toThrow('persisted place or accepted-claim evidence');
    missingEvidence.db.close();

    const visualClaim = fixture();
    insertAcceptedClaim(visualClaim.db, {
      id: 'visual-claim', text: 'Original narration', category: 'visual_observation'
    });
    visualClaim.db.raw.prepare(`
      INSERT INTO project_scene_claims(scene_id, claim_id) VALUES('scene-1', 'visual-claim')
    `).run();
    expect(() => visualClaim.service.useGraphic({
      projectId: 'project-1', sceneId: 'scene-1', treatment: 'TEXT_OR_ARCHIVAL',
      reason: 'This must not carry a footage-only observation onto a card.'
    })).toThrow('footage-only visual claim');
    expect(visualClaim.db.raw.prepare(`
      SELECT count(*) AS count FROM project_scene_claims WHERE claim_id = 'visual-claim'
    `).get()).toEqual({ count: 1 });
    visualClaim.db.close();
  });

  it('splits and merges adjacent beats without breaking ordinals or immutable versions', () => {
    const { db, service } = fixture();
    const split = service.splitBeat({
      projectId: 'project-1',
      sceneId: 'scene-1',
      firstNarration: 'First half.',
      secondNarration: 'Second half.',
      secondTreatment: 'TEXT_OR_ARCHIVAL',
      reason: 'Separate two visual ideas.'
    });
    expect(split.project.scenes.map(scene => ({ ordinal: scene.ordinal, narration: scene.narration, treatment: scene.visualTreatment })))
      .toEqual([
        { ordinal: 1, narration: 'First half.', treatment: 'EXACT_LOCATION_FOOTAGE' },
        { ordinal: 2, narration: 'Second half.', treatment: 'TEXT_OR_ARCHIVAL' }
      ]);
    const secondId = split.project.scenes[1]!.id;
    const merged = service.mergeBeats({
      projectId: 'project-1',
      firstSceneId: 'scene-1',
      secondSceneId: secondId,
      narration: 'First half. Second half.',
      graphicTreatment: 'MAP_OR_GRAPHIC',
      reason: 'Restore one concise beat.'
    });
    expect(merged.project.scenes).toHaveLength(1);
    expect(merged.project.scenes[0]).toMatchObject({
      ordinal: 1,
      narration: 'First half. Second half.',
      visualTreatment: 'MAP_OR_GRAPHIC',
      verificationState: 'graphic'
    });
    expect(db.raw.prepare(`SELECT count(*) AS count FROM script_versions`).get()).toEqual({ count: 3 });
    db.close();
  });

  it('assigns accepted claims to the correct split beat and refuses to divide a claim', () => {
    const allocated = fixture();
    for (const [id, text] of [
      ['claim-first', 'Paris is in France.'],
      ['claim-second', 'The tower opened in 1889.']
    ] as const) {
      insertAcceptedClaim(allocated.db, { id, text });
      allocated.db.raw.prepare(`
        INSERT INTO project_scene_claims(scene_id, claim_id) VALUES('scene-1', ?)
      `).run(id);
    }
    const split = allocated.service.splitBeat({
      projectId: 'project-1', sceneId: 'scene-1',
      firstNarration: 'Paris is in France.', secondNarration: 'The tower opened in 1889.',
      secondTreatment: 'TEXT_OR_ARCHIVAL', reason: 'Keep each sourced fact on its own beat.'
    });
    expect(allocated.db.raw.prepare(`
      SELECT s.ordinal, link.claim_id FROM project_scene_claims link
      JOIN project_scenes s ON s.id = link.scene_id ORDER BY s.ordinal, link.claim_id
    `).all()).toEqual([
      { ordinal: 1, claim_id: 'claim-first' },
      { ordinal: 2, claim_id: 'claim-second' }
    ]);
    expect(split.project.scenes).toHaveLength(2);
    allocated.db.close();

    const divided = fixture();
    insertAcceptedClaim(divided.db, { id: 'claim-divided', text: 'Paris landmark' });
    divided.db.raw.prepare(`
      INSERT INTO project_scene_claims(scene_id, claim_id) VALUES('scene-1', 'claim-divided')
    `).run();
    expect(() => divided.service.splitBeat({
      projectId: 'project-1', sceneId: 'scene-1', firstNarration: 'Paris',
      secondNarration: 'landmark', secondTreatment: 'MAP_OR_GRAPHIC',
      reason: 'This split would sever one accepted claim.'
    })).toThrow('removed or divided linked accepted claim');
    expect(divided.projects.get('project-1').scenes).toHaveLength(1);
    divided.db.close();
  });

  it('refuses to merge distinct location contracts into one scene', () => {
    const { db, places, service, projects } = fixture();
    const split = service.splitBeat({
      projectId: 'project-1', sceneId: 'scene-1', firstNarration: 'First half.',
      secondNarration: 'Second half.', secondTreatment: 'MAP_OR_GRAPHIC',
      reason: 'Create adjacent beats for the merge policy test.'
    });
    const secondId = split.project.scenes[1]!.id;
    const lyon = places.ensureHierarchy({
      country: 'France', city: 'Lyon', location: 'Place Bellecour', granularity: 'landmark'
    })!;
    db.raw.prepare(`
      UPDATE project_scenes SET required_city = 'Lyon', required_location = 'Place Bellecour',
        required_place_id = ? WHERE id = ?
    `).run(lyon.id, secondId);
    expect(() => service.mergeBeats({
      projectId: 'project-1', firstSceneId: 'scene-1', secondSceneId: secondId,
      narration: 'First half. Second half.', graphicTreatment: 'MAP_OR_GRAPHIC',
      reason: 'Do not erase a second geography contract.'
    })).toThrow('different location contracts');
    expect(projects.get('project-1').scenes).toHaveLength(2);
    db.close();
  });

  it('re-verifies human location evidence and blocks rejection of the selected candidate', async () => {
    const verified = fixture();
    const result = await verified.service.verifyLocation({
      projectId: 'project-1', sceneId: 'scene-1', reason: 'Operator matched the landmark evidence.'
    });
    expect(verified.verifyScene).toHaveBeenCalledWith('project-1', 'scene-1', 'primary', 'file-primary');
    expect(result).toMatchObject({ action: 'verify_location', nextAction: 'render_range' });
    expect(verified.places.effectiveForAsset('primary')).toMatchObject({
      evidenceType: 'human', verificationStatus: 'verified'
    });
    verified.db.close();

    const rejected = fixture();
    const rejection = rejected.service.rejectCandidate({
      projectId: 'project-1',
      sceneId: 'scene-1',
      candidateId: 'candidate-primary',
      reason: 'The preview shows the wrong landmark.'
    });
    expect(rejection).toMatchObject({ action: 'reject_candidate', nextAction: 'manual_recovery' });
    expect(rejection.project.state).toBe('BLOCKED_EXCEPTION');
    expect(rejected.db.raw.prepare(`
      SELECT selected_asset_id, verification_state FROM project_scenes WHERE id = 'scene-1'
    `).get()).toEqual({ selected_asset_id: null, verification_state: 'rejected' });
    expect(rejected.db.raw.prepare(`
      SELECT code FROM exceptions WHERE code = 'OPERATOR_REJECTED_STORYBOARD_CANDIDATE'
    `).get()).toEqual({ code: 'OPERATOR_REJECTED_STORYBOARD_CANDIDATE' });
    expect(rejected.service.getRecoveryScene('project-1', 'scene-1').candidates
      .find(candidate => candidate.id === 'candidate-primary')).toMatchObject({
      ready: false,
      blockedReasons: expect.arrayContaining(['Candidate was rejected by the operator.'])
    });
    rejected.db.close();
  });

  it('does not apply an asynchronous location result to a scene that changed meanwhile', async () => {
    const stale = fixture();
    stale.verifyScene.mockImplementationOnce(async () => {
      stale.db.raw.prepare(`
        UPDATE project_scenes SET selected_asset_id = 'alternate', selected_file_id = 'file-alternate'
        WHERE id = 'scene-1'
      `).run();
      return {
        id: 'stale-verification', inputHash: 'stale-input', provider: 'local_policy',
        model: 'none', cached: false, status: 'verified' as const,
        geographyStatus: 'match' as const, semanticStatus: 'not_required' as const,
        confidence: 1, reasons: ['Stale result']
      };
    });
    await expect(stale.service.verifyLocation({
      projectId: 'project-1', sceneId: 'scene-1', reason: 'Verify without racing another edit.'
    })).rejects.toThrow('changed while location verification was running');
    expect(stale.db.raw.prepare(`
      SELECT selected_asset_id, selected_file_id, verification_state FROM project_scenes WHERE id = 'scene-1'
    `).get()).toEqual({
      selected_asset_id: 'alternate', selected_file_id: 'file-alternate', verification_state: 'rejected'
    });
    expect(stale.db.raw.prepare(`
      SELECT count(*) AS count FROM repair_attempts WHERE action LIKE '%verify location%'
    `).get()).toEqual({ count: 0 });
    stale.db.close();
  });
});
