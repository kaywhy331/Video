import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase } from '@main/database/database';
import { MediaService } from '@main/services/media-service';
import type { AppSettings } from '@shared/types';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(status: 'verified' | 'uncertain' | 'error' = 'verified') {
  const root = mkdtempSync(join(tmpdir(), 'videofactory-semantic-retry-'));
  roots.push(root);
  const db = new AppDatabase(join(root, 'videofactory.sqlite'));
  const now = new Date().toISOString();
  db.raw.prepare(`
    INSERT INTO projects(
      id, sequence, slug, title, topic, state, resume_state, progress,
      envato_project_name, target_duration_ms, created_at, updated_at
    ) VALUES('project-1', 1, 'project', 'Project', 'Topic', 'BLOCKED_EXCEPTION',
      'VERIFYING_FOOTAGE', 0.5, 'YT-TEST', 300000, ?, ?)
  `).run(now, now);
  db.raw.prepare(`
    INSERT INTO assets(
      id, stable_key, title, country, city, location_name, orientation,
      location_granularity, location_confidence, verification_status,
      availability_status, raw_row_json, imported_at, updated_at, local_file_id
    ) VALUES('asset-1', 'asset-1', 'Eiffel footage', 'France', 'Paris',
      'Eiffel Tower', 'landscape', 'landmark', 0.9, 'metadata', 'available',
      '{}', ?, ?, 'file-1')
  `).run(now, now);
  db.raw.prepare(`
    INSERT INTO project_scenes(
      id, project_id, ordinal, narration, target_duration_ms, required_country,
      required_city, required_location, required_granularity, required_objects_json,
      required_activities_json, preferred_shots_json, visual_treatment,
      selected_asset_id, score_explanation_json, verification_state, created_at, updated_at
    ) VALUES('scene-1', 'project-1', 1, 'Visitors walk beneath the Eiffel Tower.',
      4000, 'France', 'Paris', 'Eiffel Tower', 'landmark', '["tower"]',
      '["walking"]', '["wide"]', 'EXACT_LOCATION_FOOTAGE', 'asset-1', '[]',
      'rejected', ?, ?)
  `).run(now, now);
  db.raw.prepare(`
    INSERT INTO asset_files(
      id, asset_id, sha256, original_path, original_file_name, file_size_bytes,
      duration_ms, width, height, frame_rate, codec, audio_present,
      raw_ffprobe_json, pipeline_version, created_at
    ) VALUES('file-1', 'asset-1', 'sha-file-1', ?, 'clip.mp4', 1000,
      5000, 1920, 1080, 30, 'h264', 0, '{}', 'test', ?)
  `).run(process.execPath, now);
  db.raw.prepare(`
    INSERT INTO media_segments(
      id, asset_file_id, start_ms, end_ms, duration_ms, quality_score,
      black_frame_risk, freeze_risk, effective_width, effective_height,
      eligible_1080p, eligible_4k, pipeline_version, created_at
    ) VALUES('segment-1', 'file-1', 0, 5000, 5000, 1, 0, 0,
      1920, 1080, 1, 0, 'test', ?)
  `).run(now);
  db.raw.prepare(`
    INSERT INTO exceptions(
      id, project_id, severity, stage, code, title, message, evidence_json,
      recommended_action, status, created_at
    ) VALUES('exception-1', 'project-1', 'BLOCKER', 'media',
      'SEMANTIC_PROVIDER_REQUIRED', 'Provider required', 'Retry required', ?,
      'Configure provider and retry.', 'OPEN', ?)
  `).run(JSON.stringify({
    sceneId: 'scene-1',
    sceneOrdinal: 1,
    assetId: 'asset-1',
    fileId: 'file-1'
  }), now);
  const verifyScene = vi.fn().mockResolvedValue({
    id: `verification-${status}`,
    inputHash: `input-${status}`,
    provider: 'openai_compatible',
    model: 'vision-test',
    cached: false,
    status,
    geographyStatus: status === 'verified' ? 'match' : 'unknown',
    semanticStatus: status === 'verified' ? 'match' : 'unknown',
    confidence: status === 'verified' ? 0.95 : 0,
    reasons: status === 'verified' ? ['Evidence matches.'] : ['Provider unavailable.']
  });
  const media = new MediaService(
    db,
    () => ({ ffmpegPath: '', ffprobePath: '' } as AppSettings),
    { verifyScene } as never,
    vi.fn()
  );
  return { db, media, verifyScene };
}

describe('semantic verification operator retry', () => {
  it('re-verifies the persisted target, attaches a safe segment, and resolves only that blocker', async () => {
    const { db, media, verifyScene } = fixture();

    const result = await media.retrySemanticVerification('exception-1');

    expect(verifyScene).toHaveBeenCalledWith('project-1', 'scene-1', 'asset-1', 'file-1');
    expect(result).toMatchObject({ status: 'verified', exceptionResolved: true, projectState: 'BUILDING_TIMELINE' });
    expect(db.raw.prepare(`
      SELECT selected_file_id, selected_segment_id, verification_state
      FROM project_scenes WHERE id = 'scene-1'
    `).get()).toEqual({
      selected_file_id: 'file-1',
      selected_segment_id: 'segment-1',
      verification_state: 'verified'
    });
    expect(db.raw.prepare(`
      SELECT status FROM exceptions WHERE id = 'exception-1'
    `).get()).toEqual({ status: 'RESOLVED' });
    db.close();
  });

  it('keeps the blocker open when the provider is still unavailable', async () => {
    const { db, media } = fixture('error');

    const result = await media.retrySemanticVerification('exception-1');

    expect(result).toMatchObject({ status: 'error', exceptionResolved: false, projectState: 'BLOCKED_EXCEPTION' });
    expect(db.raw.prepare(`
      SELECT status FROM exceptions WHERE id = 'exception-1'
    `).get()).toEqual({ status: 'OPEN' });
    expect(db.raw.prepare(`
      SELECT verification_state FROM project_scenes WHERE id = 'scene-1'
    `).get()).toEqual({ verification_state: 'rejected' });
    db.close();
  });

  it('routes a genuine uncertain result through bounded alternates and closes the provider blocker', async () => {
    const { db, media } = fixture('uncertain');
    const now = new Date().toISOString();
    db.raw.prepare(`
      INSERT INTO assets(
        id, stable_key, title, canonical_page_url, country, city, location_name,
        orientation, location_granularity, location_confidence, verification_status,
        availability_status, raw_row_json, imported_at, updated_at
      ) VALUES('asset-2', 'asset-2', 'Alternate', 'https://elements.envato.com/asset-2',
        'France', 'Paris', 'Eiffel Tower', 'landscape', 'landmark', 0.9, 'metadata',
        'available', '{}', ?, ?)
    `).run(now, now);
    db.raw.prepare(`
      INSERT INTO shot_candidates(
        id, project_id, scene_id, asset_id, candidate_rank, candidate_score,
        score_components_json, explanation_json, status, created_at, updated_at
      ) VALUES('candidate-2', 'project-1', 'scene-1', 'asset-2', 2, 0.8,
        '{}', '[]', 'alternate', ?, ?)
    `).run(now, now);

    const result = await media.retrySemanticVerification('exception-1');

    expect(result).toMatchObject({ status: 'uncertain', exceptionResolved: true, projectState: 'WAITING_FOR_DOWNLOADS' });
    expect(db.raw.prepare(`
      SELECT status FROM exceptions WHERE id = 'exception-1'
    `).get()).toEqual({ status: 'RESOLVED' });
    expect(db.raw.prepare(`
      SELECT status, replacement_asset_id FROM repair_attempts
    `).get()).toEqual({ status: 'waiting_acquisition', replacement_asset_id: 'asset-2' });
    db.close();
  });
});
