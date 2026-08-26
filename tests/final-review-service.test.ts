import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { AppDatabase } from '@main/database/database';
import { FinalReviewService, REVISION_ROUTES, finalReviewGates } from '@main/services/final-review-service';
import { ActiveFinalService } from '@main/services/active-final-service';
import { ProjectStateService } from '@main/services/project-state-service';
import type { FinalReviewRevisionCategory, ProjectDetail, ProjectState } from '@shared/types';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function revisionFixture(state: ProjectState = 'WAITING_FINAL_APPROVAL') {
  const root = mkdtempSync(join(tmpdir(), 'videofactory-final-review-'));
  roots.push(root);
  const db = new AppDatabase(join(root, 'db.sqlite'));
  const now = new Date().toISOString();
  db.raw.prepare(`
    INSERT INTO projects(
      id, sequence, slug, title, topic, state, progress, envato_project_name,
      target_duration_ms, script_version_id, final_render_id, youtube_video_id, created_at, updated_at
    ) VALUES('project-1', 1, 'project-1', 'Project', 'Topic', ?, 0.95,
      'YT-REVISION-0001', 300000, 'script-1', 'old-final', 'video-1', ?, ?)
  `).run(state, now, now);
  db.raw.prepare(`
    INSERT INTO renders(
      id, project_id, kind, profile, state, output_path, sha256, created_at, completed_at
    ) VALUES('old-final', 'project-1', 'final', 'final_1080p', 'SUCCEEDED',
      ?, 'final-sha', ?, ?)
  `).run(join(root, 'old-final.mp4'), now, now);
  db.raw.prepare(`
    INSERT INTO script_versions(
      id, project_id, version_number, title, topic, script_json,
      generation_reason, provider, model, input_hash, locked, script_type,
      locked_at, created_at
    ) VALUES('script-1', 'project-1', 1, 'Project', 'Topic', '{}',
      'test', 'mock', 'mock', 'input', 1, 'final', ?, ?)
  `).run(now, now);
  for (const [ordinal, sceneId] of [[1, 'scene-1'], [2, 'scene-2']] as const) {
    db.raw.prepare(`
      INSERT INTO project_scenes(
        id, project_id, script_version_id, ordinal, narration, target_duration_ms,
        required_granularity, required_objects_json, required_activities_json,
        preferred_shots_json, visual_treatment, score_explanation_json,
        verification_state, pronunciation_json, created_at, updated_at
      ) VALUES(?, 'project-1', 'script-1', ?, ?, 3000, 'unknown', '[]', '[]',
        '[]', 'MAP_OR_GRAPHIC', '[]', 'graphic', '{}', ?, ?)
    `).run(sceneId, ordinal, `Narration ${ordinal}`, now, now);
  }
  for (const [ordinal, sectionId, sceneId] of [[1, 'section-1', 'scene-1'], [2, 'section-2', 'scene-2']] as const) {
    const voiceId = `voice-${ordinal}`;
    db.raw.prepare(`
      INSERT INTO voice_assets(
        id, project_id, provider, model, voice_id, settings_json,
        pronunciation_hash, input_hash, text, duration_ms, timing_method,
        status, created_at, updated_at
      ) VALUES(?, 'project-1', 'mock', 'mock', 'voice', '{}', 'pron', ?, ?,
        1000, 'provider_word', 'ready', ?, ?)
    `).run(voiceId, `input-${ordinal}`, `Narration ${ordinal}`, now, now);
    db.raw.prepare(`
      INSERT INTO narration_sections(
        id, project_id, script_version_id, voice_asset_id, ordinal,
        scene_ids_json, text, duration_ms, status, created_at, updated_at
      ) VALUES(?, 'project-1', 'script-1', ?, ?, ?, ?, 1000, 'ready', ?, ?)
    `).run(sectionId, voiceId, ordinal, JSON.stringify([sceneId]), `Narration ${ordinal}`, now, now);
  }
  db.raw.prepare(`
    INSERT INTO publication_records(
      id, project_id, video_id, privacy_status, final_render_id, final_sha256,
      snapshot_version, snapshot_status, approval_hash, approved_at, created_at, updated_at
    ) VALUES('publication-1', 'project-1', 'video-1', 'private', 'old-final', 'final-sha',
      1, 'current', 'approval-sha', ?, ?, ?)
  `).run(now, now, now);
  const states = new ProjectStateService(db);
  const projects = {
    states,
    get: () => ({
      id: 'project-1',
      state: (db.raw.prepare(`SELECT state FROM projects WHERE id = 'project-1'`).get() as { state: ProjectState }).state
    })
  };
  return { db, service: new FinalReviewService(db, projects as never) };
}

describe('final review release gates', () => {
  const readyArtifacts = {
    hasFinalRender: true,
    hasSelectedPackage: true,
    blockerCount: 0,
    state: 'WAITING_FINAL_APPROVAL' as const,
    hasYoutubeVideo: false,
    packageSynced: true,
    publicationReady: false
  };

  it('allows private upload after local artifacts and QC are ready', () => {
    expect(finalReviewGates(readyArtifacts)).toEqual({ canUpload: true, canApprove: false });
    expect(finalReviewGates({ ...readyArtifacts, state: 'QC_FINAL' })).toEqual({
      canUpload: true,
      canApprove: false
    });
  });

  it('requires the exact processed upload package before publish approval', () => {
    expect(finalReviewGates({
      ...readyArtifacts,
      hasYoutubeVideo: true,
      publicationReady: true
    })).toEqual({ canUpload: true, canApprove: true });

    for (const blocked of [
      { blockerCount: 1 },
      { hasYoutubeVideo: false },
      { packageSynced: false },
      { publicationReady: false },
      { state: 'WAITING_YOUTUBE_PROCESSING' as const }
    ]) {
      expect(finalReviewGates({
        ...readyArtifacts,
        hasYoutubeVideo: true,
        publicationReady: true,
        ...blocked
      }).canApprove).toBe(false);
    }
  });

  it('uses only the explicitly active final artifact, never a stale succeeded render', () => {
    const root = mkdtempSync(join(tmpdir(), 'videofactory-final-pointer-'));
    roots.push(root);
    const db = new AppDatabase(join(root, 'db.sqlite'));
    const now = new Date().toISOString();
    const outputPath = join(root, 'stale.mp4');
    const thumbnailPath = join(root, 'thumbnail.jpg');
    writeFileSync(outputPath, 'active final bytes');
    writeFileSync(thumbnailPath, 'thumbnail bytes');
    const finalSha = createHash('sha256').update('active final bytes').digest('hex');
    db.raw.prepare(`
      INSERT INTO projects(
        id, sequence, slug, title, topic, state, progress, envato_project_name,
        target_duration_ms, created_at, updated_at
      ) VALUES('project-1', 1, 'project-1', 'Project', 'Topic', 'QC_FINAL', 0.9,
        'YT-PROJECT-1', 60000, ?, ?)
    `).run(now, now);
    db.raw.prepare(`
      INSERT INTO renders(
        id, project_id, kind, profile, state, output_path, sha256, created_at, completed_at
      ) VALUES('stale-final', 'project-1', 'final', 'final_1080p', 'SUCCEEDED', ?, ?, ?, ?)
    `).run(outputPath, finalSha, now, now);
    const project = {
      id: 'project-1',
      state: 'QC_FINAL',
      finalRenderId: null,
      youtubeVideoId: null,
      renders: [{
        id: 'stale-final', projectId: 'project-1', kind: 'final', profile: 'final_1080p',
        state: 'SUCCEEDED', manifestPath: null, outputPath, sha256: finalSha,
        durationMs: 1_000, width: 1_920, height: 1_080, error: null, createdAt: now,
        completedAt: now, artifactVersion: 1, scope: null, baseRenderId: null
      }],
      qc: [],
      packaging: [{
        id: 'package-1', projectId: 'project-1', ordinal: 1, title: 'Title', angle: 'Angle',
        viewerPromise: 'Promise', thumbnailPath, thumbnailFrameMs: null,
        description: 'Description', chapters: '00:00 Opening', tags: ['tag'], riskStatus: 'pass', selected: true
      }]
    } as unknown as ProjectDetail;
    const activeFinal = new ActiveFinalService(db, () => root);
    const service = new FinalReviewService(db, { get: () => project } as never, () => root, activeFinal);

    expect(service.get('project-1')).toMatchObject({
      localPreviewUrl: null,
      localCaptionsUrl: null,
      canUpload: false
    });
    project.finalRenderId = 'stale-final';
    db.raw.prepare(`UPDATE projects SET final_render_id = 'stale-final' WHERE id = 'project-1'`).run();
    expect(service.get('project-1')).toMatchObject({
      localPreviewUrl: 'videofactory://render/stale-final',
      localCaptionsUrl: null,
      canUpload: true
    });
    const captionsPath = join(root, 'final.vtt');
    const manifestPath = join(root, 'manifest.json');
    writeFileSync(captionsPath, 'WEBVTT\n\n');
    writeFileSync(manifestPath, JSON.stringify({ captions: { vttPath: captionsPath } }));
    project.renders[0]!.manifestPath = manifestPath;
    db.raw.prepare(`UPDATE renders SET manifest_path = ? WHERE id = 'stale-final'`).run(manifestPath);
    const captionService = new FinalReviewService(db, { get: () => project } as never, () => root, activeFinal);
    expect(captionService.get('project-1').localCaptionsUrl).toBe('videofactory://caption/stale-final');
    db.close();
  });
});

describe('final review revision routing', () => {
  it('uses the exact seven smallest-stage routes and invalidates prior approval', () => {
    const expected: Record<FinalReviewRevisionCategory, ProjectState> = {
      packaging: 'QC_FINAL',
      caption_typo: 'BUILDING_TIMELINE',
      voice_pronunciation: 'GENERATING_VOICE',
      script_factual_issue: 'FINALIZING_SCRIPT',
      wrong_or_weak_shot: 'VERIFYING_FOOTAGE',
      new_footage_required: 'WAITING_FOR_DOWNLOADS',
      major_story_change: 'SCRIPTING_PROVISIONAL'
    };
    expect(REVISION_ROUTES).toEqual(expected);

    for (const [category, returnState] of Object.entries(expected) as Array<[FinalReviewRevisionCategory, ProjectState]>) {
      const { db, service } = revisionFixture();
      const automatic = category === 'voice_pronunciation' || category === 'script_factual_issue';
      const revision = service.requestRevision({
        projectId: 'project-1',
        category,
        note: `Correct the ${category}`,
        ...(category === 'voice_pronunciation'
          ? { affectedSceneId: 'scene-1', pronunciation: { term: 'Oaxaca', value: 'wah-HAH-kah' } }
          : {})
      });
      expect(revision).toMatchObject({ category, returnState, status: automatic ? 'in_progress' : 'requested' });
      expect(db.raw.prepare(`SELECT state FROM projects WHERE id = 'project-1'`).get()).toEqual({ state: returnState });
      expect(db.raw.prepare(`SELECT approval_hash, approved_at FROM publication_records WHERE id = 'publication-1'`).get())
        .toEqual({ approval_hash: null, approved_at: null });
      expect(db.raw.prepare(`SELECT final_render_id, youtube_video_id FROM projects WHERE id = 'project-1'`).get())
        .toEqual(category === 'packaging'
          ? { final_render_id: 'old-final', youtube_video_id: 'video-1' }
          : { final_render_id: null, youtube_video_id: null });
      db.close();
    }
  }, 30_000);

  it('rejects send-back outside the final human gate', () => {
    const { db, service } = revisionFixture('QC_FINAL');
    expect(() => service.requestRevision({
      projectId: 'project-1',
      category: 'packaging',
      note: 'Use a clearer title'
    })).toThrow('only from WAITING_FINAL_APPROVAL');
    expect(db.raw.prepare(`SELECT count(*) AS count FROM revision_requests`).get()).toEqual({ count: 0 });
    db.close();
  });

  it('stores structured pronunciation and stales only the affected narration section', () => {
    const { db, service } = revisionFixture();
    const revision = service.requestRevision({
      projectId: 'project-1',
      category: 'voice_pronunciation',
      note: 'Correct the place pronunciation',
      affectedSceneId: 'scene-1',
      pronunciation: { term: 'Oaxaca', value: 'wah-HAH-kah' }
    });
    expect(revision.pronunciation).toEqual({ term: 'Oaxaca', value: 'wah-HAH-kah' });
    expect(db.raw.prepare(`SELECT pronunciation_json FROM project_scenes WHERE id = 'scene-1'`).get())
      .toEqual({ pronunciation_json: '{"Oaxaca":"wah-HAH-kah"}' });
    expect(db.raw.prepare(`SELECT id, status FROM narration_sections ORDER BY ordinal`).all()).toEqual([
      { id: 'section-1', status: 'stale' },
      { id: 'section-2', status: 'ready' }
    ]);
    db.close();
  });
});
