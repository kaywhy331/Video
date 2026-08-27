import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppDatabase } from '@main/database/database';
import {
  collectProductionPilotEvidence,
  listProductionPilotCandidates,
  type ProductionPilotProbe
} from '../scripts/collect-production-pilot-evidence.mjs';
import type { ValidationSource } from '../scripts/validation-source.mjs';
import {
  PRODUCTION_PILOT_RECEIPT_PATH,
  writeProductionPilotQualificationIndex
} from '../scripts/external-qualification-evidence.mjs';

const source: ValidationSource = {
  commit: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  ref: 'main',
  repository: 'owner/repository',
  workflowCommit: null,
  runId: null,
  runAttempt: null,
  dirty: false
};
const pilotProjectIds = [1, 2, 3, 4, 5].map(index => `pilot-project-${index}`);
const qualifyingProbe: ProductionPilotProbe = {
  durationMs: 300_000,
  width: 1_920,
  height: 1_080,
  frameRate: 30,
  videoCodec: 'h264',
  audioCodec: 'aac'
};

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function writeArtifact(root: string, name: string, contents: string): string {
  const path = join(root, name);
  writeFileSync(path, contents);
  return path;
}

function insertCatalog(db: AppDatabase, now: string): void {
  const importId = 'pilot-import';
  db.raw.prepare(`
    INSERT INTO catalog_imports(
      id, source_path, source_name, source_sha256, row_count,
      inserted_count, column_mapping_json, started_at, completed_at
    ) VALUES(?, ?, ?, ?, 26000, 26000, '{}', ?, ?)
  `).run(importId, 'D:\\pilot\\catalog.xlsx', 'catalog.xlsx', digest('catalog-source'), now, now);
  const insert = db.raw.prepare(`
    INSERT INTO assets(
      id, stable_key, canonical_page_url, title, orientation,
      location_granularity, location_confidence, verification_status,
      availability_status, raw_row_json, import_id, imported_at, updated_at
    ) VALUES(?, ?, ?, ?, 'landscape', 'city', 1, 'human_verified',
      'available', '{}', ?, ?, ?)
  `);
  db.raw.transaction(() => {
    for (let index = 1; index <= 26_000; index += 1) {
      const id = `asset-${index}`;
      insert.run(
        id,
        id,
        `https://elements.envato.com/pilot-asset-${index}`,
        `Pilot asset ${index}`,
        importId,
        now,
        now
      );
    }
  })();
}

function insertProject(db: AppDatabase, root: string, index: number, now: string): string[] {
  const projectId = `pilot-project-${index}`;
  const scriptId = `pilot-script-${index}`;
  const renderId = `pilot-render-${index}`;
  const manifestId = `pilot-manifest-${index}`;
  const packageId = `pilot-package-${index}`;
  const outputPath = writeArtifact(root, `pilot-final-${index}.mp4`, `final-video-${index}`);
  const outputSha256 = digest(readFileSync(outputPath));
  const srtPath = writeArtifact(root, `pilot-${index}.srt`, `1\n00:00:00,000 --> 00:00:01,000\nPilot ${index}\n`);
  const vttPath = writeArtifact(root, `pilot-${index}.vtt`, `WEBVTT\n\n00:00.000 --> 00:01.000\nPilot ${index}\n`);
  const thumbnailPath = writeArtifact(root, `pilot-${index}.jpg`, `thumbnail-${index}`);
  const manifest = { captions: { srtPath, vttPath }, projectId, renderId };
  const manifestPath = writeArtifact(root, `pilot-manifest-${index}.json`, JSON.stringify(manifest, null, 2));
  const manifestJson = JSON.stringify(manifest);

  db.raw.prepare(`
    INSERT INTO projects(
      id, sequence, slug, title, topic, destination_key, destination,
      state, progress, envato_project_name, target_duration_ms,
      script_version_id, final_render_id, youtube_video_id,
      created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 300000, ?, ?, ?, ?, ?)
  `).run(
    projectId,
    index,
    `pilot-${index}`,
    `Pilot ${index}`,
    `Pilot topic ${index}`,
    `destination-${((index - 1) % 3) + 1}`,
    `Destination ${((index - 1) % 3) + 1}`,
    index === 1 ? 'SCHEDULED' : 'WAITING_FINAL_APPROVAL',
    `Pilot Project ${index}`,
    scriptId,
    renderId,
    `video-${index}`,
    now,
    now
  );
  db.raw.prepare(`
    INSERT INTO scheduler_runs(
      id, trigger, outcome, project_id, evidence_json, created_at
    ) VALUES(?, 'timer', 'created', ?, '{}', ?)
  `).run(`scheduler-${index}`, projectId, now);
  db.raw.prepare(`
    INSERT INTO research_sources(
      id, project_id, url, title, accessed_at, source_type,
      content_hash, status
    ) VALUES(?, ?, ?, ?, ?, 'web', ?, 'active')
  `).run(
    `research-${index}`,
    projectId,
    `https://example.com/pilot-${index}`,
    `Pilot source ${index}`,
    now,
    digest(`research-content-${index}`)
  );
  db.raw.prepare(`
    INSERT INTO fact_claims(
      id, project_id, text, category, confidence, stability,
      source_ids_json, status, material, normalized_key,
      evidence_json, created_at, updated_at
    ) VALUES(?, ?, ?, 'history', 1, 'stable', ?, 'staged', 1, ?, '{}', ?, ?)
  `).run(
    `claim-${index}`,
    projectId,
    `Pilot fact ${index}`,
    JSON.stringify([`research-${index}`]),
    `pilot-fact-${index}`,
    now,
    now
  );
  db.raw.prepare(`
    INSERT INTO fact_claim_sources(claim_id, source_id, support_type, created_at)
    VALUES(?, ?, 'supports', ?)
  `).run(`claim-${index}`, `research-${index}`, now);
  db.raw.prepare(`UPDATE fact_claims SET status = 'accepted' WHERE id = ?`).run(`claim-${index}`);
  db.raw.prepare(`
    INSERT INTO research_sources(
      id, project_id, url, title, accessed_at, source_type, status
    ) VALUES(?, ?, ?, ?, ?, 'licensed_catalog_metadata', 'active')
  `).run(
    `visual-source-${index}`,
    projectId,
    `https://elements.envato.com/pilot-asset-${(index - 1) * 2 + 1}`,
    `Visual source ${index}`,
    now
  );
  db.raw.prepare(`
    INSERT INTO fact_claims(
      id, project_id, text, category, confidence, stability,
      source_ids_json, status, material, normalized_key,
      evidence_json, created_at, updated_at
    ) VALUES(?, ?, ?, 'visual_observation', 1, 'stable', ?, 'staged', 1, ?, '{}', ?, ?)
  `).run(
    `visual-claim-${index}`,
    projectId,
    `Pilot visual observation ${index}`,
    JSON.stringify([`visual-source-${index}`]),
    `pilot-visual-${index}`,
    now,
    now
  );
  db.raw.prepare(`
    INSERT INTO fact_claim_sources(claim_id, source_id, support_type, created_at)
    VALUES(?, ?, 'supports', ?)
  `).run(`visual-claim-${index}`, `visual-source-${index}`, now);
  db.raw.prepare(`UPDATE fact_claims SET status = 'accepted' WHERE id = ?`).run(`visual-claim-${index}`);
  for (const provider of ['tavily', 'openai_compatible']) {
    db.raw.prepare(`
      INSERT INTO provider_calls(
        id, project_id, provider, model, operation, input_hash,
        output_hash, request_id, response_json, created_at
      ) VALUES(?, ?, ?, 'pilot-model', ?, ?, ?, ?, '{}', ?)
    `).run(
      `${provider}-${index}`,
      projectId,
      provider,
      provider === 'tavily' ? 'research_search' : 'finalize_script',
      digest(`${provider}-input-${index}`),
      digest(`${provider}-output-${index}`),
      `${provider}-request-${index}`,
      now
    );
  }
  db.raw.prepare(`
    INSERT INTO script_versions(
      id, project_id, version_number, title, topic, script_json,
      generation_reason, provider, model, input_hash, locked,
      script_type, locked_at, created_at
    ) VALUES(?, ?, 1, ?, ?, '{}', 'verified_footage_finalization',
      'openai_compatible', 'pilot-model', ?, 1, 'final', ?, ?)
  `).run(scriptId, projectId, `Pilot ${index}`, `Pilot topic ${index}`, digest(`script-${index}`), now, now);

  const sourcePaths: string[] = [];
  for (let item = 1; item <= 2; item += 1) {
    const assetNumber = (index - 1) * 2 + item;
    const assetId = `asset-${assetNumber}`;
    const fileId = `pilot-file-${index}-${item}`;
    const sourcePath = writeArtifact(root, `pilot-source-${index}-${item}.mp4`, `source-${index}-${item}`);
    sourcePaths.push(sourcePath);
    const sourceBytes = readFileSync(sourcePath);
    const certificatePath = writeArtifact(
      root,
      `pilot-license-${index}-${item}.pdf`,
      `license-${index}-${item}`
    );
    db.raw.prepare(`
      INSERT INTO asset_files(
        id, asset_id, sha256, original_path, original_file_name,
        file_size_bytes, duration_ms, width, height, frame_rate,
        codec, raw_ffprobe_json, pipeline_version, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, 10000, 1920, 1080, 30,
        'h264', '{}', 'pilot-v1', ?)
    `).run(
      fileId,
      assetId,
      digest(sourceBytes),
      sourcePath,
      `pilot-source-${index}-${item}.mp4`,
      statSync(sourcePath).size,
      now
    );
    db.raw.prepare(`UPDATE assets SET local_file_id = ? WHERE id = ?`).run(fileId, assetId);
    db.raw.prepare(`
      INSERT INTO acquisition_items(
        id, project_id, asset_id, ordinal, role, state, license_state,
        source_url, required_scene_ordinals_json, match_score, reasons_json,
        mapped_file_id, detected_path, created_at, updated_at
      ) VALUES(?, ?, ?, ?, 'primary', 'COMPLETE', 'CERTIFICATE_ATTACHED',
        ?, ?, 1, '[]', ?, ?, ?, ?)
    `).run(
      `acquisition-${index}-${item}`,
      projectId,
      assetId,
      item,
      `https://elements.envato.com/pilot-asset-${assetNumber}`,
      JSON.stringify([item]),
      fileId,
      sourcePath,
      now,
      now
    );
    db.raw.prepare(`
      INSERT INTO project_licenses(
        id, project_id, asset_id, license_state, envato_project_name,
        certificate_path, operator_attested_at, created_at, updated_at
      ) VALUES(?, ?, ?, 'CERTIFICATE_ATTACHED', ?, ?, ?, ?, ?)
    `).run(
      `license-${index}-${item}`,
      projectId,
      assetId,
      `Pilot Project ${index}`,
      certificatePath,
      now,
      now,
      now
    );
    db.raw.prepare(`
      INSERT INTO project_scenes(
        id, project_id, script_version_id, ordinal, narration,
        target_duration_ms, required_granularity, required_objects_json,
        required_activities_json, preferred_shots_json, visual_treatment,
        selected_asset_id, selected_file_id, verification_state,
        created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, 150000, 'city', '[]', '[]', '[]',
        'FOOTAGE', ?, ?, 'verified', ?, ?)
    `).run(
      `scene-${index}-${item}`,
      projectId,
      scriptId,
      item,
      `Narration ${index}-${item}`,
      assetId,
      fileId,
      now,
      now
    );
    db.raw.prepare(`
      INSERT INTO footage_verifications(
        id, project_id, scene_id, asset_id, asset_file_id,
        provider, model, input_hash, status, geography_status,
        semantic_status, confidence, assessment_json, evidence_json, created_at
      ) VALUES(?, ?, ?, ?, ?, 'local_policy', 'human-verified', ?,
        'verified', 'match', 'match', 1, '{}', '{}', ?)
    `).run(
      `verification-${index}-${item}`,
      projectId,
      `scene-${index}-${item}`,
      assetId,
      fileId,
      digest(`verification-${index}-${item}`),
      now
    );

    const audioPath = writeArtifact(root, `pilot-audio-${index}-${item}.wav`, `audio-${index}-${item}`);
    const voiceId = `voice-${index}-${item}`;
    db.raw.prepare(`
      INSERT INTO voice_assets(
        id, project_id, provider, model, voice_id, settings_json,
        pronunciation_hash, input_hash, text, audio_path, duration_ms,
        timing_method, status, created_at, updated_at
      ) VALUES(?, ?, 'windows_sapi', 'system-speech', 'pilot-voice', '{}',
        ?, ?, ?, ?, 150000, 'provider_word', 'ready', ?, ?)
    `).run(
      voiceId,
      projectId,
      digest(`pronunciation-${index}-${item}`),
      digest(`voice-input-${index}-${item}`),
      `Narration ${index}-${item}`,
      audioPath,
      now,
      now
    );
    db.raw.prepare(`
      INSERT INTO narration_sections(
        id, project_id, script_version_id, voice_asset_id, ordinal,
        scene_ids_json, text, duration_ms, status, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, 150000, 'ready', ?, ?)
    `).run(
      `section-${index}-${item}`,
      projectId,
      scriptId,
      voiceId,
      item,
      JSON.stringify([`scene-${index}-${item}`]),
      `Narration ${index}-${item}`,
      now,
      now
    );
  }

  db.raw.prepare(`
    INSERT INTO render_manifests(
      id, project_id, script_version_id, profile, manifest_json,
      manifest_hash, path, created_at
    ) VALUES(?, ?, ?, 'landscape_1080p', ?, ?, ?, ?)
  `).run(manifestId, projectId, scriptId, manifestJson, digest(manifestJson), manifestPath, now);
  db.raw.prepare(`
    INSERT INTO renders(
      id, project_id, kind, profile, state, manifest_id, manifest_path,
      output_path, sha256, duration_ms, width, height, completed_at, created_at
    ) VALUES(?, ?, 'final', 'landscape_1080p', 'SUCCEEDED', ?, ?, ?, ?,
      300000, 1920, 1080, ?, ?)
  `).run(renderId, projectId, manifestId, manifestPath, outputPath, outputSha256, now, now);
  db.raw.prepare(`
    INSERT INTO qc_results(
      id, project_id, render_id, category, code, severity,
      status, message, evidence_json, created_at
    ) VALUES(?, ?, ?, 'media', 'PILOT_FINAL', 'HIGH', 'pass', 'passed', '{}', ?)
  `).run(`qc-${index}`, projectId, renderId, now);
  db.raw.prepare(`
    INSERT INTO packaging_candidates(
      id, project_id, ordinal, title, angle, viewer_promise,
      thumbnail_path, description, chapters, tags_json,
      risk_status, selected, created_at
    ) VALUES(?, ?, 1, ?, 'pilot', 'pilot', ?, 'pilot', '[]', '[]', 'clean', 1, ?)
  `).run(packageId, projectId, `Pilot ${index}`, thumbnailPath, now);
  db.raw.prepare(`
    INSERT INTO publication_records(
      id, project_id, channel_id, video_id, privacy_status,
      final_render_id, final_sha256, snapshot_version, snapshot_status,
      processing_status, selected_package_id, caption_id,
      thumbnail_uploaded, approval_hash, approved_at, scheduled_at,
      synthetic_media, created_at, updated_at
    ) VALUES(?, ?, 'channel-1', ?, 'private', ?, ?, 1, 'current',
      'succeeded', ?, ?, 1, ?, ?, ?, 0, ?, ?)
  `).run(
    `publication-${index}`,
    projectId,
    `video-${index}`,
    renderId,
    outputSha256,
    packageId,
    `caption-${index}`,
    digest(`approval-${index}`),
    index <= 4 ? now : null,
    index === 1 ? '2026-09-01T16:00:00.000Z' : null,
    now,
    now
  );
  db.raw.prepare(`
    INSERT INTO audit_log(project_id, action, actor, entity_type, entity_id, created_at)
    VALUES(?, 'license.batch_attested', 'operator', 'project', ?, ?)
  `).run(projectId, projectId, now);
  if (index <= 4) {
    db.raw.prepare(`
      INSERT INTO audit_log(project_id, action, actor, entity_type, entity_id, created_at)
      VALUES(?, 'youtube.keep_private', 'human', 'publication', ?, ?)
    `).run(projectId, `publication-${index}`, now);
  }
  return sourcePaths;
}

describe('production pilot collector', () => {
  let root: string;
  let databasePath: string;
  let sourcePaths: string[];

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'videofactory-production-pilot-'));
    databasePath = join(root, 'pilot.sqlite');
    const db = new AppDatabase(databasePath);
    const now = '2026-08-26T12:00:00.000Z';
    try {
      insertCatalog(db, now);
      db.raw.prepare(`
        INSERT INTO youtube_connection_binding(
          singleton_id, channel_id, channel_title, credential_fingerprint, confirmed_at
        ) VALUES(1, 'channel-1', 'Pilot Channel', ?, ?)
      `).run(digest('credential'), now);
      sourcePaths = [1, 2, 3, 4, 5].flatMap(index => insertProject(db, root, index, now));
      expect(db.integrityCheck()).toBe('ok');
    } finally {
      db.close();
    }
  }, 120_000);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('derives a qualifying privacy-preserving receipt from real schema-24 application state and bytes', async () => {
    expect(listProductionPilotCandidates(databasePath)).toHaveLength(5);
    const collected = await collectProductionPilotEvidence({
      root,
      databasePath,
      projectIds: pilotProjectIds,
      mode: 'qualification',
      deviceClass: 'representative-win11-desktop',
      source,
      appVersion: '0.1.0-alpha.7',
      now: new Date('2026-08-26T20:00:00.000Z'),
      environment: {
        platform: 'win32',
        release: '10.0.26100',
        architecture: 'x64',
        node: '22.22.0',
        ci: false,
        deviceClass: 'representative-win11-desktop'
      },
      probeMedia: () => qualifyingProbe
    });

    expect(collected.assessment.externalQualificationPassed).toBe(true);
    expect(collected.assessment.derived).toMatchObject({
      catalogAssetCount: 26_000,
      projectCount: 5,
      destinationClusterCount: 3,
      routineOnlyCount: 4
    });
    expect(collected.receipt.projects.every(project => (
      !JSON.stringify(project).includes('pilot-project-')
      && !JSON.stringify(project).includes('video-')
      && !JSON.stringify(project).includes(root)
    ))).toBe(true);

    const receiptPath = join(root, PRODUCTION_PILOT_RECEIPT_PATH);
    mkdirSync(dirname(receiptPath), { recursive: true });
    writeFileSync(receiptPath, `${JSON.stringify(collected.assessment, null, 2)}\n`);
    const admitted = writeProductionPilotQualificationIndex({
      root,
      source,
      now: new Date('2026-08-26T20:01:00.000Z')
    });
    expect(admitted.qualifiedIds).toEqual(['E2E-001', 'E2E-002', 'E2E-005', 'UX-001']);
    expect(admitted.receipts[0]?.kind).toBe('production_pilot');
  }, 120_000);

  it('rejects a material claim whose citation is not a digested active HTTP source', async () => {
    const setResearchHash = (value: string | null): void => {
      const db = new AppDatabase(databasePath);
      try {
        db.raw.prepare(`UPDATE research_sources SET content_hash = ? WHERE id = 'research-1'`).run(value);
      } finally {
        db.close();
      }
    };
    const decoy = new AppDatabase(databasePath);
    try {
      decoy.raw.prepare(`
        INSERT INTO research_sources(
          id, project_id, url, title, accessed_at, source_type, content_hash, status
        ) VALUES('research-1-decoy', 'pilot-project-1', 'https://example.com/uncited',
          'Uncited source', '2026-08-26T12:00:00.000Z', 'web', ?, 'active')
      `).run(digest('uncited-research-content'));
    } finally {
      decoy.close();
    }
    setResearchHash(null);
    try {
      await expect(collectProductionPilotEvidence({
        root,
        databasePath,
        projectIds: pilotProjectIds,
        mode: 'supporting',
        source,
        appVersion: '0.1.0-alpha.7',
        probeMedia: () => qualifyingProbe
      })).rejects.toThrow(/citedAcceptedMaterialClaimCount/);
    } finally {
      setResearchHash(digest('research-content-1'));
      const cleanup = new AppDatabase(databasePath);
      try {
        cleanup.raw.prepare(`DELETE FROM research_sources WHERE id = 'research-1-decoy'`).run();
      } finally {
        cleanup.close();
      }
    }
  }, 120_000);

  it('does not accept an older verified footage row after a newer rejection', async () => {
    const db = new AppDatabase(databasePath);
    try {
      db.raw.prepare(`
        INSERT INTO footage_verifications(
          id, project_id, scene_id, asset_id, asset_file_id,
          provider, model, input_hash, status, geography_status,
          semantic_status, confidence, assessment_json, evidence_json, created_at
        ) VALUES('verification-1-1-newer', 'pilot-project-1', 'scene-1-1', 'asset-1',
          'pilot-file-1-1', 'local_policy', 'human-verified', ?, 'rejected',
          'mismatch', 'mismatch', 0, '{}', '{}', '2026-08-27T12:00:00.000Z')
      `).run(digest('newer-rejected-verification'));
    } finally {
      db.close();
    }
    try {
      const collected = await collectProductionPilotEvidence({
        root,
        databasePath,
        projectIds: pilotProjectIds,
        mode: 'supporting',
        source,
        appVersion: '0.1.0-alpha.7',
        probeMedia: () => qualifyingProbe
      });
      expect(collected.assessment.projectAssessments[0]?.checks.completeAcquisition).toBe(false);
      expect(collected.assessment.acceptance['E2E-001']).toBe('failed');
    } finally {
      const cleanup = new AppDatabase(databasePath);
      try {
        cleanup.raw.prepare(`DELETE FROM footage_verifications WHERE id = 'verification-1-1-newer'`).run();
      } finally {
        cleanup.close();
      }
    }
  }, 120_000);

  it('does not accept an acquisition whose item and project-license states diverged', async () => {
    const setLicenseState = (value: string): void => {
      const db = new AppDatabase(databasePath);
      try {
        db.raw.prepare(`
          UPDATE acquisition_items SET license_state = ? WHERE id = 'acquisition-1-1'
        `).run(value);
      } finally {
        db.close();
      }
    };
    setLicenseState('OPERATOR_ATTESTED');
    try {
      const collected = await collectProductionPilotEvidence({
        root,
        databasePath,
        projectIds: pilotProjectIds,
        mode: 'supporting',
        source,
        appVersion: '0.1.0-alpha.7',
        probeMedia: () => qualifyingProbe
      });
      expect(collected.assessment.projectAssessments[0]?.checks.completeAcquisition).toBe(false);
      expect(collected.assessment.acceptance['E2E-001']).toBe('failed');
    } finally {
      setLicenseState('CERTIFICATE_ATTACHED');
    }
  }, 120_000);

  it('rejects a publication that is not the project active video identity', async () => {
    const setVideoId = (value: string): void => {
      const db = new AppDatabase(databasePath);
      try {
        db.raw.prepare(`UPDATE projects SET youtube_video_id = ? WHERE id = 'pilot-project-1'`).run(value);
      } finally {
        db.close();
      }
    };
    setVideoId('different-video');
    try {
      await expect(collectProductionPilotEvidence({
        root,
        databasePath,
        projectIds: pilotProjectIds,
        mode: 'supporting',
        source,
        appVersion: '0.1.0-alpha.7',
        probeMedia: () => qualifyingProbe
      })).rejects.toThrow(/exact active final identity/);
    } finally {
      setVideoId('video-1');
    }
  }, 120_000);

  it('fails closed when a persisted source-media hash no longer matches the selected bytes', async () => {
    writeFileSync(sourcePaths[0]!, 'changed-source-bytes');
    await expect(collectProductionPilotEvidence({
      root,
      databasePath,
      projectIds: pilotProjectIds,
      mode: 'supporting',
      source,
      appVersion: '0.1.0-alpha.7',
      probeMedia: () => qualifyingProbe
    })).rejects.toThrow(/source media no longer matches/);
  }, 120_000);
});
