import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase } from '@main/database/database';
import { ProjectService } from '@main/services/project-service';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('complete project detail workspace contract', () => {
  it('returns evidence for every required project-detail tab', () => {
    const root = mkdtempSync(join(tmpdir(), 'videofactory-project-detail-'));
    roots.push(root);
    const db = new AppDatabase(join(root, 'videofactory.sqlite'));
    const now = new Date().toISOString();
    db.raw.prepare(`
      INSERT INTO projects(
        id, sequence, slug, title, topic, destination, state, progress,
        envato_project_name, target_duration_ms, script_version_id,
        youtube_video_id, created_at, updated_at
      ) VALUES('project-1', 1, 'project', 'Project detail', 'Architecture', 'Oaxaca',
        'WAITING_FINAL_APPROVAL', 0.96, 'YT-PROJECT', 300000, 'script-1',
        'video-1', ?, ?)
    `).run(now, now);
    db.raw.prepare(`
      INSERT INTO research_sources(
        id, project_id, url, title, publisher, accessed_at, summary, source_type,
        content_hash, excerpt, freshness_days, status
      ) VALUES('source-1', 'project-1', 'https://example.com/source', 'Primary source',
        'Example', ?, 'Grounded summary', 'web', 'source-hash', 'Supporting excerpt', 30, 'active')
    `).run(now);
    db.raw.prepare(`
      INSERT INTO fact_claims(
        id, project_id, text, category, confidence, stability, valid_as_of,
        source_ids_json, status, material, normalized_key, evidence_json,
        updated_at, created_at
      ) VALUES('claim-1', 'project-1', 'The square is in Oaxaca.', 'geography', 0.98,
        'stable', ?, '["source-1"]', 'proposed', 1, 'square-oaxaca', '{}', ?, ?)
    `).run(now, now, now);
    db.raw.prepare(`
      INSERT INTO fact_claim_sources(claim_id, source_id, support_type, excerpt, created_at)
      VALUES('claim-1', 'source-1', 'supports', 'Supporting excerpt', ?)
    `).run(now);
    db.raw.prepare(`UPDATE fact_claims SET status = 'accepted' WHERE id = 'claim-1'`).run();
    db.raw.prepare(`
      INSERT INTO script_versions(
        id, project_id, version_number, title, topic, summary, script_json,
        generation_reason, provider, model, input_hash, locked, script_type,
        locked_at, created_at
      ) VALUES('script-1', 'project-1', 1, 'Project detail', 'Architecture',
        'Final verified script', '{"sections":[{"narration":"The square is in Oaxaca."}]}',
        'verified footage', 'mock', 'mock', 'script-hash', 1, 'final', ?, ?)
    `).run(now, now);
    db.raw.prepare(`
      INSERT INTO project_scenes(
        id, project_id, script_version_id, ordinal, narration, target_duration_ms,
        required_country, required_city, required_location, required_granularity,
        required_objects_json, required_activities_json, preferred_shots_json,
        visual_treatment, score_explanation_json, verification_state, created_at, updated_at
      ) VALUES('scene-1', 'project-1', 'script-1', 1, 'The square is in Oaxaca.', 4000,
        'Mexico', 'Oaxaca', 'Zocalo', 'landmark', '[]', '[]', '[]',
        'MAP_OR_GRAPHIC', '[]', 'graphic', ?, ?)
    `).run(now, now);
    db.raw.prepare(`
      INSERT INTO project_scene_claims(scene_id, claim_id) VALUES('scene-1', 'claim-1')
    `).run();
    db.raw.prepare(`
      INSERT INTO assets(
        id, stable_key, title, orientation, location_granularity, location_confidence,
        verification_status, availability_status, raw_row_json, imported_at, updated_at
      ) VALUES('asset-1', 'asset-1', 'Licensed footage', 'landscape', 'landmark', 1,
        'human_verified', 'available', '{}', ?, ?)
    `).run(now, now);
    db.raw.prepare(`
      INSERT INTO asset_files(
        id, asset_id, sha256, original_path, original_file_name, file_size_bytes,
        duration_ms, width, height, frame_rate, codec, audio_present,
        raw_ffprobe_json, pipeline_version, created_at
      ) VALUES('file-1', 'asset-1', 'file-hash', '/managed/original.mp4', 'original.mp4',
        1000, 6000, 1920, 1080, 30, 'h264', 0, '{}', 'media-v2-color-policy', ?)
    `).run(now);
    db.raw.prepare(`UPDATE assets SET local_file_id = 'file-1' WHERE id = 'asset-1'`).run();
    db.raw.prepare(`
      INSERT INTO project_licenses(
        id, project_id, asset_id, license_state, envato_project_name,
        operator_attested_at, verified_at, created_at, updated_at
      ) VALUES('license-1', 'project-1', 'asset-1', 'VERIFIED', 'YT-PROJECT', ?, ?, ?, ?)
    `).run(now, now, now, now);
    db.raw.prepare(`
      INSERT INTO publication_records(
        id, project_id, video_id, privacy_status, final_sha256, processing_status,
        caption_id, thumbnail_uploaded, synthetic_media, created_at, updated_at
      ) VALUES('publication-1', 'project-1', 'video-1', 'private', 'final-hash',
        'succeeded', 'caption-1', 1, 0, ?, ?)
    `).run(now, now);
    db.raw.prepare(`
      INSERT INTO analytics_snapshots(
        id, project_id, video_id, snapshot_day, metrics_json, retention_json,
        collected_at, captured_at, source, source_hash
      ) VALUES('snapshot-1', 'project-1', 'video-1', 1, '{"views":100}',
        '[{"elapsedRatio":0.5,"audienceWatchRatio":0.8,"relativeRetention":1}]',
        ?, ?, 'youtube_api', 'analytics-hash')
    `).run(now, now);
    db.raw.prepare(`
      INSERT INTO retention_mappings(
        id, analytics_snapshot_id, project_id, position_ms, elapsed_ratio,
        audience_watch_ratio, scene_id, scene_ordinal, created_at
      ) VALUES('mapping-1', 'snapshot-1', 'project-1', 2000, 0.5, 0.8,
        'scene-1', 1, ?)
    `).run(now);
    db.raw.prepare(`
      INSERT INTO audit_log(project_id, action, actor, entity_type, entity_id, metadata_json, created_at)
      VALUES('project-1', 'project.fixture_created', 'system', 'project', 'project-1',
        '{"fixture":true}', ?)
    `).run(now);

    const service = new ProjectService(db, {} as never, {} as never, () => ({} as never), {} as never);
    const detail = service.get('project-1');

    expect(detail.researchSources).toEqual([expect.objectContaining({ id: 'source-1', status: 'active' })]);
    expect(detail.factClaims).toEqual([expect.objectContaining({
      id: 'claim-1', status: 'accepted', sourceIds: ['source-1'], sceneIds: ['scene-1']
    })]);
    expect(detail.scriptVersions).toEqual([expect.objectContaining({ id: 'script-1', locked: true, scriptType: 'final' })]);
    expect(detail.licenses).toEqual([expect.objectContaining({
      id: 'license-1', assetTitle: 'Licensed footage', file: expect.objectContaining({ pipelineVersion: 'media-v2-color-policy' })
    })]);
    expect(detail.publicationRecords).toEqual([expect.objectContaining({ id: 'publication-1', captionId: 'caption-1' })]);
    expect(detail.analyticsSnapshots).toEqual([expect.objectContaining({
      id: 'snapshot-1', metrics: { views: 100 }, mappings: [expect.objectContaining({ sceneId: 'scene-1' })]
    })]);
    expect(detail.auditLog).toEqual([expect.objectContaining({ action: 'project.fixture_created', metadata: { fixture: true } })]);
    expect(db.integrityCheck()).toBe('ok');
    db.close();
  });
});
