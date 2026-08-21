import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { AppDatabase } from '@main/database/database';
import { EditingService } from '@main/services/editing-service';
import { ProjectArtifactService } from '@main/services/project-artifact-service';
import { requireSuccess } from '@main/services/process-utils';
import type { AppSettings } from '@shared/types';

const root = mkdtempSync(join(tmpdir(), 'videofactory-artifact-service-'));
const originalPath = join(root, 'original.mp4');
const voicePath = join(root, 'voice.wav');
const missingProxy = join(root, 'media', 'proxy.mp4');
const missingSheet = join(root, 'media', 'contact.jpg');
const missingTiming = join(root, 'project', 'voice', 'section.timing.json');
const missingSrt = join(root, 'project', 'captions', 'fixture-final.srt');
const missingVtt = join(root, 'project', 'captions', 'fixture-final.vtt');
let missingAss = '';
let database: AppDatabase;
let service: ProjectArtifactService;

function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('project artifact export and deterministic rebuild', () => {
  beforeAll(async () => {
    if (!ffmpegPath) throw new Error('ffmpeg-static binary is unavailable.');
    await requireSuccess(ffmpegPath, [
      '-y', '-hide_banner',
      '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=2',
      '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', originalPath
    ]);
    await requireSuccess(ffmpegPath, [
      '-y', '-hide_banner', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1.2',
      '-c:a', 'pcm_s16le', voicePath
    ]);
    database = new AppDatabase(join(root, 'videofactory.sqlite'));
    const settings = {
      mediaLibraryFolder: join(root, 'media'),
      projectFolder: join(root, 'projects'),
      outputFolder: join(root, 'output'),
      backupFolder: join(root, 'backups'),
      ffmpegPath,
      ffprobePath: ffprobeStatic.path,
      channelName: 'Fixture Channel',
      channelShort: 'FC'
    } as unknown as AppSettings;
    service = new ProjectArtifactService(database, () => settings);
    const now = new Date().toISOString();
    const sourceHash = fileSha256(originalPath);
    database.raw.prepare(`
      INSERT INTO projects(
        id, sequence, slug, title, topic, destination, state, progress,
        envato_project_name, target_duration_ms, script_version_id, created_at, updated_at
      ) VALUES('project-1', 1, 'portable-fixture', 'Portable Fixture', 'Oaxaca', 'Oaxaca',
        'QC_DRAFT', 0.72, 'YT-PORTABLE-0001', 1800, 'script-1', ?, ?)
    `).run(now, now);
    database.raw.prepare(`
      INSERT INTO project_guidance(
        project_id, mode, starting_script, starting_script_sha256,
        requested_destination_key, requested_target_duration_ms,
        resolved_destination_key, resolved_destination, resolved_topic_title,
        resolved_target_duration_ms, constraints_json, created_at
      ) VALUES('project-1', 'guided', 'Open with the Zocalo.', 'fixture-seed-hash',
        'mexico|oaxaca|', 60000, 'mexico|oaxaca|', 'Oaxaca', 'Portable Fixture',
        60000, '{"role":"editorial_guidance_only","evidenceEligible":false}', ?)
    `).run(now);
    database.raw.prepare(`
      INSERT INTO script_versions(
        id, project_id, version_number, title, topic, script_json, generation_reason,
        provider, model, input_hash, locked, script_type, locked_at, created_at
      ) VALUES('script-1', 'project-1', 1, 'Portable Fixture', 'Oaxaca', '{}',
        'integration test', 'mock', 'mock', 'script-input', 1, 'final', ?, ?)
    `).run(now, now);
    database.raw.prepare(`
      INSERT INTO assets(
        id, stable_key, title, country, city, location_name, orientation,
        location_granularity, location_confidence, verification_status,
        availability_status, raw_row_json, imported_at, updated_at
      ) VALUES('asset-1', 'asset-1', 'Fixture footage', 'Mexico', 'Oaxaca', 'Zocalo',
        'landscape', 'landmark', 1, 'human_verified', 'available', '{}', ?, ?)
    `).run(now, now);
    database.raw.prepare(`
      INSERT INTO asset_files(
        id, asset_id, sha256, original_path, proxy_path, contact_sheet_path,
        original_file_name, file_size_bytes, duration_ms, width, height,
        frame_rate, codec, audio_present, raw_ffprobe_json, pipeline_version, created_at
      ) VALUES('file-1', 'asset-1', ?, ?, ?, ?, 'original.mp4', ?, 2000,
        1920, 1080, 30, 'h264', 0, '{}', 'fixture', ?)
    `).run(sourceHash, originalPath, missingProxy, missingSheet, readFileSync(originalPath).length, now);
    database.raw.prepare(`
      INSERT INTO media_segments(
        id, asset_file_id, start_ms, end_ms, duration_ms, quality_score,
        black_frame_risk, freeze_risk, effective_width, effective_height,
        eligible_1080p, eligible_4k, pipeline_version, created_at
      ) VALUES('segment-1', 'file-1', 0, 1800, 1800, 1, 0, 0, 1920, 1080, 1, 0, 'fixture', ?)
    `).run(now);
    database.raw.prepare(`
      INSERT INTO project_scenes(
        id, project_id, script_version_id, ordinal, chapter, narration,
        target_duration_ms, required_country, required_city, required_location,
        required_granularity, required_objects_json, required_activities_json,
        preferred_shots_json, visual_treatment, selected_asset_id, selected_file_id,
        selected_segment_id, score_explanation_json, verification_state, created_at, updated_at
      ) VALUES('scene-1', 'project-1', 'script-1', 1, 'Opening', 'Oaxaca.', 1800,
        'Mexico', 'Oaxaca', 'Zocalo', 'landmark', '[]', '[]', '[]',
        'EXACT_LOCATION_FOOTAGE', 'asset-1', 'file-1', 'segment-1', '[]', 'verified', ?, ?)
    `).run(now, now);
    database.raw.prepare(`
      INSERT INTO acquisition_items(
        id, project_id, asset_id, ordinal, role, state, source_url,
        required_scene_ordinals_json, match_score, reasons_json, mapped_file_id,
        license_state, created_at, updated_at
      ) VALUES('acquisition-1', 'project-1', 'asset-1', 1, 'primary', 'COMPLETE',
        'https://elements.envato.com/fixture', '[1]', 100, '[]', 'file-1', 'VERIFIED', ?, ?)
    `).run(now, now);
    database.raw.prepare(`
      INSERT INTO project_licenses(
        id, project_id, asset_id, license_state, envato_project_name,
        operator_attested_at, verified_at, created_at, updated_at
      ) VALUES('license-1', 'project-1', 'asset-1', 'VERIFIED', 'YT-PORTABLE-0001', ?, ?, ?, ?)
    `).run(now, now, now, now);
    database.raw.prepare(`
      INSERT INTO voice_assets(
        id, project_id, provider, model, voice_id, settings_json, pronunciation_hash,
        input_hash, text, audio_path, timing_path, duration_ms, timing_method,
        status, created_at, updated_at
      ) VALUES('voice-1', 'project-1', 'test', 'test', 'test', '{}', 'pronunciation',
        'voice-input', 'Oaxaca.', ?, ?, 1200, 'provider_word', 'ready', ?, ?)
    `).run(voicePath, missingTiming, now, now);
    database.raw.prepare(`
      INSERT INTO narration_sections(
        id, project_id, script_version_id, voice_asset_id, ordinal, chapter,
        scene_ids_json, text, pronunciation_json, duration_ms, status, created_at, updated_at
      ) VALUES('section-1', 'project-1', 'script-1', 'voice-1', 1, 'Opening',
        '["scene-1"]', 'Oaxaca.', '{}', 1200, 'ready', ?, ?)
    `).run(now, now);
    database.raw.prepare(`
      INSERT INTO narration_words(
        id, section_id, scene_id, ordinal, word, start_ms, end_ms, confidence, timing_method
      ) VALUES('word-1', 'section-1', 'scene-1', 1, 'Oaxaca.', 100, 900, 0.99, 'provider_word')
    `).run();
    const editing = new EditingService(database, () => settings);
    const layer = editing.prepareLayer({
      plan: editing.plan('project-1', 'scene-1'),
      width: 1920,
      height: 1080,
      durationMs: 1800,
      directory: join(root, 'project', 'editing')
    });
    missingAss = layer.path;
    const manifest = {
      output: { width: 1920, height: 1080 },
      captions: { srtPath: missingSrt, vttPath: missingVtt },
      scenes: [{
        durationMs: 1800,
        editingLayerPath: missingAss,
        editingPlan: editing.plan('project-1', 'scene-1'),
        wordTimings: [{ word: 'Oaxaca.', startMs: 100, endMs: 900, confidence: 0.99, timingMethod: 'provider_word' }]
      }]
    };
    const renderManifestPath = join(root, 'project', 'manifests', 'final.json');
    mkdirSync(join(root, 'project', 'manifests'), { recursive: true });
    writeFileSync(renderManifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    database.raw.prepare(`
      INSERT INTO render_manifests(
        id, project_id, script_version_id, profile, manifest_json, manifest_hash, path, created_at
      ) VALUES('manifest-1', 'project-1', 'script-1', 'final_1080p', ?, ?, ?, ?)
    `).run(JSON.stringify(manifest), createHash('sha256').update(JSON.stringify(manifest)).digest('hex'), renderManifestPath, now);
    database.raw.prepare(`
      INSERT INTO renders(
        id, project_id, kind, profile, state, manifest_id, manifest_path, output_path,
        sha256, duration_ms, width, height, artifact_version, created_at, completed_at
      ) VALUES('render-1', 'project-1', 'final', 'final_1080p', 'SUCCEEDED', 'manifest-1',
        ?, ?, ?, 1800, 1920, 1080, 1, ?, ?)
    `).run(renderManifestPath, originalPath, sourceHash, now, now);
    database.raw.prepare(`
      INSERT INTO publication_records(
        id, project_id, video_id, privacy_status, upload_session_uri, final_sha256,
        processing_status, created_at, updated_at
      ) VALUES('publication-1', 'project-1', 'private-video', 'private',
        'https://upload.example/session/SECRET-RESUMABLE-TOKEN', ?, 'uploading', ?, ?)
    `).run(sourceHash, now, now);
    unlinkSync(missingAss);
  }, 60_000);

  afterAll(() => {
    database?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('rebuilds missing regenerable derivatives from verified immutable inputs', async () => {
    const report = await service.rebuildProject('project-1');
    expect(report.status).toBe('complete');
    expect(report).toMatchObject({
      checkedOriginals: 1,
      rebuiltProxies: 1,
      rebuiltContactSheets: 1,
      rebuiltVoiceTimings: 1,
      rebuiltEditingLayers: 1,
      rebuiltCaptionFiles: 2,
      missingOriginals: [],
      missingVoice: [],
      failures: []
    });
    for (const path of [missingProxy, missingSheet, missingTiming, missingAss, missingSrt, missingVtt]) {
      expect(existsSync(path), path).toBe(true);
    }
    expect(JSON.parse(readFileSync(missingTiming, 'utf8'))).toEqual([
      expect.objectContaining({ word: 'Oaxaca.', startMs: 100, endMs: 900 })
    ]);
  }, 60_000);

  it('exports a portable checksummed project bundle and verifies every indexed byte', async () => {
    const destination = join(root, 'exports');
    const report = await service.exportProject('project-1', destination, {
      includeOriginals: true,
      includeFinalOutput: true
    });
    expect(report.status).toBe('complete');
    expect(report.missingFiles).toEqual([]);
    expect(report.manifestPath && existsSync(report.manifestPath)).toBe(true);
    const indexText = readFileSync(report.manifestPath!, 'utf8');
    expect(createHash('sha256').update(indexText).digest('hex')).toBe(report.manifestSha256);
    const index = JSON.parse(indexText) as {
      artifactCount: number;
      totalBytes: number;
      artifacts: Array<{ path: string; category: string; sha256: string; sizeBytes: number }>;
    };
    expect(index.artifactCount).toBe(report.artifactCount);
    expect(index.totalBytes).toBe(report.totalBytes);
    expect(index.artifacts.map(artifact => artifact.category)).not.toContain('upload_session_uri');
    for (const artifact of index.artifacts) {
      const path = join(report.exportPath, artifact.path);
      expect(existsSync(path), artifact.path).toBe(true);
      expect(readFileSync(path).length, artifact.path).toBe(artifact.sizeBytes);
      expect(fileSha256(path), artifact.path).toBe(artifact.sha256);
    }
    const publicationAudit = JSON.parse(readFileSync(join(report.exportPath, 'metadata', 'publication-audit.json'), 'utf8'));
    expect(JSON.stringify(publicationAudit)).not.toContain('SECRET-RESUMABLE-TOKEN');
    expect(publicationAudit.publicationRecords).toEqual([
      expect.objectContaining({ upload_session_uri: null, upload_session_present: true })
    ]);
    const projectMetadata = JSON.parse(readFileSync(join(report.exportPath, 'metadata', 'project.json'), 'utf8'));
    expect(projectMetadata.projectGuidance).toMatchObject({
      project_id: 'project-1',
      mode: 'guided',
      starting_script: 'Open with the Zocalo.',
      starting_script_sha256: 'fixture-seed-hash'
    });
  }, 60_000);
});
