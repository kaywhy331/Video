import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase } from '@main/database/database';
import { PlaceService } from '@main/services/place-service';
import { FootageVerificationService } from '@main/services/footage-verification-service';
import type { AppSettings } from '@shared/types';
import type { VisionFootageAssessment } from '@shared/footage-verification';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function settings(): AppSettings {
  return {
    visionProvider: 'openai_compatible',
    visionModel: 'vision-test',
    visionMinimumConfidence: 0.8
  } as AppSettings;
}

function createFixture(options: { humanVerified?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'videofactory-footage-verification-'));
  roots.push(root);
  const db = new AppDatabase(join(root, 'videofactory.sqlite'));
  const places = new PlaceService(db);
  const now = new Date().toISOString();
  const sheet = join(root, 'contact.jpg');
  writeFileSync(sheet, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  db.raw.prepare(`
    INSERT INTO projects(
      id, sequence, slug, title, topic, state, progress, envato_project_name,
      target_duration_ms, created_at, updated_at
    ) VALUES('project-1', 1, 'project', 'Project', 'Topic', 'VERIFYING_FOOTAGE',
      0.5, 'YT-TEST', 300000, ?, ?)
  `).run(now, now);
  db.raw.prepare(`
    INSERT INTO assets(
      id, stable_key, title, country, city, location_name, orientation,
      location_granularity, location_confidence, verification_status,
      availability_status, raw_row_json, imported_at, updated_at
    ) VALUES('asset-1', 'asset-1', 'Eiffel footage', 'France', 'Paris',
      'Eiffel Tower', 'landscape', 'landmark', ?, ?, 'available', '{}', ?, ?)
  `).run(
    options.humanVerified ? 1 : 0.72,
    options.humanVerified ? 'human_verified' : 'metadata',
    now,
    now
  );
  places.syncAsset('asset-1', options.humanVerified ? 'human' : 'imported');
  const requiredPlaceId = places.ensureHierarchy({
    country: 'France',
    city: 'Paris',
    location: 'Eiffel Tower',
    granularity: 'landmark'
  })!.id;
  db.raw.prepare(`
    INSERT INTO project_scenes(
      id, project_id, ordinal, narration, target_duration_ms, required_country,
      required_city, required_location, required_granularity, required_place_id,
      required_objects_json, required_activities_json, preferred_shots_json,
      visual_treatment, selected_asset_id, score_explanation_json,
      verification_state, created_at, updated_at
    ) VALUES('scene-1', 'project-1', 1, 'Visitors walk beneath the Eiffel Tower.',
      4000, 'France', 'Paris', 'Eiffel Tower', 'landmark', ?, '["tower"]',
      '["walking"]', '["wide"]', 'EXACT_LOCATION_FOOTAGE', 'asset-1', '[]',
      'download_required', ?, ?)
  `).run(requiredPlaceId, now, now);
  db.raw.prepare(`
    INSERT INTO asset_files(
      id, asset_id, sha256, original_path, contact_sheet_path, original_file_name,
      file_size_bytes, duration_ms, width, height, frame_rate, codec, audio_present,
      raw_ffprobe_json, pipeline_version, created_at
    ) VALUES('file-1', 'asset-1', 'sha-file-1', ?, ?, 'clip.mp4', 1000, 5000,
      1920, 1080, 30, 'h264', 0, '{}', 'test', ?)
  `).run(process.execPath, sheet, now);
  return { db, places };
}

function matchingAssessment(): VisionFootageAssessment {
  return {
    geography: {
      verdict: 'match',
      confidence: 0.96,
      country: 'France',
      city: 'Paris',
      location: 'Eiffel Tower',
      granularity: 'landmark',
      evidence: ['The Eiffel Tower structure is visible.']
    },
    objects: [{ requirement: 'tower', present: true, confidence: 0.95, evidence: 'Tower occupies the frame.' }],
    activities: [{ requirement: 'walking', present: true, confidence: 0.91, evidence: 'Visitors are walking.' }],
    disallowedContent: [],
    technicalConcerns: [],
    summary: 'The contact sheet supports the scene contract.'
  };
}

describe('footage verification orchestration', () => {
  it('persists a verified scene/file receipt and updates the file summary', async () => {
    const { db, places } = createFixture();
    const assess = vi.fn().mockResolvedValue({
      provider: 'openai_compatible',
      model: 'vision-test',
      inputHash: 'vision-input',
      assessment: matchingAssessment(),
      cached: false
    });
    const service = new FootageVerificationService(
      db,
      settings,
      places,
      { configured: () => true, assess }
    );

    const decision = await service.verifyScene('project-1', 'scene-1', 'asset-1', 'file-1');

    expect(decision).toMatchObject({
      status: 'verified',
      geographyStatus: 'match',
      semanticStatus: 'match',
      provider: 'openai_compatible'
    });
    expect(assess).toHaveBeenCalledTimes(1);
    expect(db.raw.prepare(`
      SELECT status, geography_status, semantic_status, required_place_id
      FROM footage_verifications WHERE id = ?
    `).get(decision.id)).toMatchObject({
      status: 'verified',
      geography_status: 'match',
      semantic_status: 'match'
    });
    const file = db.raw.prepare(`
      SELECT visual_verification_json FROM asset_files WHERE id = 'file-1'
    `).get() as { visual_verification_json: string };
    expect(JSON.parse(file.visual_verification_json)).toMatchObject({
      scenes: { 'scene-1': { status: 'verified', verificationId: decision.id } }
    });
    expect(db.raw.prepare(`
      SELECT verification_status FROM assets WHERE id = 'asset-1'
    `).get()).toEqual({ verification_status: 'ai_suggested' });
    db.close();
  });

  it('preserves human evidence and fails closed without provider evidence for semantic requirements', async () => {
    const { db, places } = createFixture({ humanVerified: true });
    const service = new FootageVerificationService(
      db,
      settings,
      places,
      { configured: () => false, assess: vi.fn() }
    );

    const decision = await service.verifyScene('project-1', 'scene-1', 'asset-1', 'file-1');

    expect(decision).toMatchObject({ status: 'provider_required', geographyStatus: 'match' });
    expect(places.effectiveForAsset('asset-1')).toMatchObject({
      evidenceType: 'human',
      verificationStatus: 'verified'
    });
    expect(db.raw.prepare(`
      SELECT verification_status FROM assets WHERE id = 'asset-1'
    `).get()).toEqual({ verification_status: 'human_verified' });
    db.close();
  });

  it('records a high-confidence incompatible place as a conflict without replacing human evidence', async () => {
    const { db, places } = createFixture({ humanVerified: true });
    const mismatch = matchingAssessment();
    mismatch.geography = {
      verdict: 'mismatch',
      confidence: 0.99,
      country: 'Italy',
      city: 'Rome',
      location: 'Colosseum',
      granularity: 'landmark',
      evidence: ['The Colosseum is visible.']
    };
    places.ensureHierarchy({ country: 'Italy', city: 'Rome', location: 'Colosseum', granularity: 'landmark' });
    const service = new FootageVerificationService(
      db,
      settings,
      places,
      {
        configured: () => true,
        assess: vi.fn().mockResolvedValue({
          provider: 'openai_compatible',
          model: 'vision-test',
          inputHash: 'vision-mismatch',
          assessment: mismatch,
          cached: false
        })
      }
    );

    const decision = await service.verifyScene('project-1', 'scene-1', 'asset-1', 'file-1');

    expect(decision).toMatchObject({ status: 'conflict', geographyStatus: 'mismatch' });
    expect(places.effectiveForAsset('asset-1')).toMatchObject({ evidenceType: 'human' });
    expect(db.raw.prepare(`
      SELECT verification_status FROM asset_place_assertions
      WHERE asset_id = 'asset-1' AND evidence_type = 'vision'
    `).get()).toEqual({ verification_status: 'conflict' });
    expect(db.raw.prepare(`
      SELECT verification_status FROM assets WHERE id = 'asset-1'
    `).get()).toEqual({ verification_status: 'human_verified' });
    db.close();
  });
});
