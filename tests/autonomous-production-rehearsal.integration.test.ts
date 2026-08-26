import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { buildDefaultSettings } from '@main/app-paths';
import { AppDatabase } from '@main/database/database';
import type {
  SecretStore,
  Secrets,
  YouTubeStoredCredentials
} from '@main/secret-store';
import { AcquisitionService } from '@main/services/acquisition-service';
import { ActiveFinalService } from '@main/services/active-final-service';
import { AiService } from '@main/services/ai-service';
import { CatalogService } from '@main/services/catalog-service';
import { FinalReviewService } from '@main/services/final-review-service';
import { FootageVerificationService } from '@main/services/footage-verification-service';
import { JobService } from '@main/services/job-service';
import { MediaService } from '@main/services/media-service';
import { NarrationService } from '@main/services/narration-service';
import { PlaceService } from '@main/services/place-service';
import { ProjectService } from '@main/services/project-service';
import { RenderService } from '@main/services/render-service';
import { requireSuccess } from '@main/services/process-utils';
import { ScriptFinalizationService } from '@main/services/script-finalization-service';
import { TtsService } from '@main/services/tts-service';
import { VisionService } from '@main/services/vision-service';
import { WorkflowService } from '@main/services/workflow-service';
import {
  createUploadFixtureRuntime,
  seedUploadProtocolState,
  UPLOAD_FIXTURE_VIDEO_ID,
  uploadProtocolState
} from './fixtures/youtube-upload-crash-fixture';
import {
  YouTubeService,
  youtubeCredentialFingerprint
} from '@main/services/youtube-service';

function fixtureSecrets(): SecretStore {
  const values: Secrets = {
    youtubeClientId: 'fixture-client-id',
    youtubeClientSecret: 'fixture-client-secret',
    youtubeRefreshToken: 'fixture-refresh-token'
  };
  return {
    getAll: () => ({ ...values }),
    update: (patch: Partial<Secrets>) => {
      Object.assign(values, patch);
      return {};
    },
    replaceYouTubeCredentials: (credentials: YouTubeStoredCredentials | null) => {
      delete values.youtubeRefreshToken;
      delete values.youtubeAccessToken;
      delete values.youtubeTokenExpiry;
      Object.assign(values, credentials ?? {});
      return {};
    }
  } as unknown as SecretStore;
}

async function seedLicensedMedia(
  db: AppDatabase,
  root: string
): Promise<void> {
  if (!ffmpegPath) throw new Error('ffmpeg-static binary is unavailable.');
  const now = new Date().toISOString();
  const shotTypes = ['wide', 'aerial', 'tracking', 'detail'];
  for (let index = 1; index <= 12; index += 1) {
    const assetId = `asset-${index}`;
    const fileId = `file-${index}`;
    const mediaPath = join(root, `fixture-${String(index).padStart(2, '0')}.mp4`);
    const location = 'Rehearsal Waterfront';
    const shotType = shotTypes[(index - 1) % shotTypes.length]!;
    await requireSuccess(ffmpegPath, [
      '-y', '-hide_banner',
      '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=6',
      '-vf', `hue=h=${index * 29}:s=0.85,format=yuv420p`,
      '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
      '-color_range', 'tv', '-colorspace', 'bt709',
      '-color_primaries', 'bt709', '-color_trc', 'bt709',
      '-movflags', '+faststart', mediaPath
    ]);
    const probe = await requireSuccess(ffprobeStatic.path, [
      '-v', 'error', '-show_format', '-show_streams', '-of', 'json', mediaPath
    ]);
    const bytes = readFileSync(mediaPath);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    db.raw.prepare(`
      INSERT INTO assets(
        id, stable_key, canonical_page_url, title, description, country, city,
        location_name, shot_type, scene_description, orientation,
        location_granularity, location_confidence, verification_status,
        availability_status, declared_width, declared_height,
        declared_duration_ms, declared_frame_rate, declared_codec,
        raw_row_json, imported_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, 'Portugal', 'Lisbon', ?, ?, ?, 'landscape',
        'landmark', 1, 'human_verified', 'available', 1920, 1080,
        6000, 30, 'h264', '{}', ?, ?)
    `).run(
      assetId,
      assetId,
      `https://elements.envato.com/rehearsal-${index}`,
      `Lisbon ${location} View ${index}`,
      `A ${shotType} visual of ${location}, composition ${index}.`,
      location,
      shotType,
      `A moving ${shotType} composition ${index} at ${location}.`,
      now,
      now
    );
    db.raw.prepare(`
      INSERT INTO asset_files(
        id, asset_id, sha256, original_path, original_file_name,
        file_size_bytes, duration_ms, width, height, frame_rate, codec,
        pixel_format, color_space, audio_present, raw_ffprobe_json,
        pipeline_version, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, 6000, 1920, 1080, 30, 'h264',
        'yuv420p', 'bt709', 0, ?, ?, ?)
    `).run(
      fileId,
      assetId,
      sha256,
      mediaPath,
      `fixture-${String(index).padStart(2, '0')}.mp4`,
      statSync(mediaPath).size,
      probe.stdout,
      MediaService.PIPELINE_VERSION,
      now
    );
    db.raw.prepare(`
      INSERT INTO media_segments(
        id, asset_file_id, start_ms, end_ms, duration_ms, quality_score,
        black_frame_risk, freeze_risk, effective_width, effective_height,
        eligible_1080p, eligible_4k, pipeline_version, created_at
      ) VALUES(?, ?, 0, 5500, 5500, 1, 0, 0, 1920, 1080, 1, 0, ?, ?)
    `).run(`segment-${index}`, fileId, MediaService.PIPELINE_VERSION, now);
    db.raw.prepare(`UPDATE assets SET local_file_id = ? WHERE id = ?`).run(fileId, assetId);
  }
}

describe('autonomous production supporting rehearsal', () => {
  it('drives a catalog-grounded project through real local production and a protocol-faithful private upload', async () => {
    if (!ffmpegPath) throw new Error('ffmpeg-static binary is unavailable.');
    const root = mkdtempSync(join(tmpdir(), 'videofactory-autonomy-rehearsal-'));
    const settings = {
      ...buildDefaultSettings(root),
      ffmpegPath,
      ffprobePath: ffprobeStatic.path,
      minFreeDiskGb: 0,
      maxWaitingDownloads: 2,
      maxPrivateApproval: 2,
      targetVideoMinutes: 1,
      narratorProvider: 'windows_sapi' as const,
      llmProvider: 'mock' as const,
      visionProvider: 'disabled' as const,
      researchProvider: 'disabled' as const,
      channelName: 'Autonomy Rehearsal',
      channelShort: 'AUTO',
      youtubeSyntheticMediaDisclosure: false
    };
    const db = new AppDatabase(settings.databasePath);
    try {
      seedUploadProtocolState(db);
      await seedLicensedMedia(db, root);
      const places = new PlaceService(db);
      places.syncAssetsMissingAssertions();
      const catalog = new CatalogService(db, places);
      const secrets = fixtureSecrets();
      const ai = new AiService(db, secrets, () => settings);
      const vision = new VisionService(db, secrets, () => settings);
      const projects = new ProjectService(
        db,
        catalog,
        ai,
        () => settings,
        places,
        undefined,
        vision
      );
      const coverage = catalog.coverage(250).find(item =>
        item.country === 'Portugal' && item.city === 'Lisbon'
      );
      expect(coverage).toBeDefined();
      expect(coverage).toMatchObject({ assetCount: 12, downloadedCount: 12, verifiedCount: 12 });

      const planned = await projects.createAutopilot({
        destinationKey: coverage!.key,
        targetMinutes: 1,
        outputProfileKey: 'landscape_1080p'
      });
      expect(planned).toMatchObject({ state: 'WAITING_FOR_DOWNLOADS', sceneCount: 12 });
      expect(planned.acquisitionCount).toBeGreaterThanOrEqual(6);

      const footage = new FootageVerificationService(
        db,
        () => settings,
        places,
        vision
      );
      const media = new MediaService(
        db,
        () => settings,
        footage,
        () => undefined,
        async () => undefined
      );
      const acquisitions = new AcquisitionService(db, media);
      await acquisitions.attestProject(planned.id);
      expect(projects.get(planned.id).state).toBe('FINALIZING_SCRIPT');
      expect(db.raw.prepare(`
        SELECT count(*) AS count FROM acquisition_items
        WHERE project_id = ? AND state = 'COMPLETE'
      `).get(planned.id)).toEqual({ count: planned.acquisitionCount });
      expect(db.raw.prepare(`
        SELECT count(*) AS count FROM project_scenes
        WHERE project_id = ? AND verification_state = 'verified'
      `).get(planned.id)).toEqual({ count: 12 });

      const now = new Date().toISOString();
      db.raw.prepare(`
        INSERT INTO youtube_connection_binding(
          singleton_id, channel_id, channel_title, credential_fingerprint, confirmed_at
        ) VALUES(1, 'UC-autonomy-fixture', 'Autonomy Fixture Channel', ?, ?)
      `).run(
        youtubeCredentialFingerprint('fixture-client-id', 'fixture-refresh-token'),
        now
      );

      const jobs = new JobService(db);
      const finalization = new ScriptFinalizationService(db, () => settings, ai, projects);
      const tts = new TtsService(db, secrets, () => settings);
      const narration = new NarrationService(db, () => settings, tts, projects);
      let workflow!: WorkflowService;
      const renders = new RenderService(
        db,
        () => settings,
        jobs,
        projects,
        () => undefined,
        (projectId, targetState) => workflow.prepareRepairWithinRenderJob(projectId, targetState)
      );
      const activeFinal = new ActiveFinalService(db, () => settings.outputFolder);
      const youtube = new YouTubeService(
        db,
        () => settings,
        secrets,
        projects,
        () => undefined,
        undefined,
        async () => undefined,
        undefined,
        activeFinal,
        createUploadFixtureRuntime(db)
      );
      const finalReview = new FinalReviewService(
        db,
        projects,
        () => settings.projectFolder,
        activeFinal
      );
      workflow = new WorkflowService(
        db,
        jobs,
        projects,
        finalization,
        narration,
        renders,
        finalReview,
        youtube,
        () => undefined,
        () => () => undefined
      );

      const completed = await workflow.advance(planned.id);
      if (completed.state !== 'WAITING_FINAL_APPROVAL') {
        const diagnostic = {
          state: completed.state,
          exceptions: db.raw.prepare(`
            SELECT stage, code, severity, message, evidence_json
            FROM exceptions WHERE project_id = ? AND status = 'OPEN'
            ORDER BY created_at, id
          `).all(planned.id),
          failedQc: db.raw.prepare(`
            SELECT category, code, severity, message, evidence_json
            FROM qc_results WHERE project_id = ? AND status = 'fail'
            ORDER BY created_at, id
          `).all(planned.id),
          renders: db.raw.prepare(`
            SELECT kind, state, error FROM renders WHERE project_id = ?
            ORDER BY created_at, id
          `).all(planned.id)
        };
        throw new Error(`Autonomous rehearsal stopped before private review: ${JSON.stringify(diagnostic)}`);
      }
      expect(completed).toMatchObject({
        state: 'WAITING_FINAL_APPROVAL',
        youtubeVideoId: UPLOAD_FIXTURE_VIDEO_ID
      });
      const review = finalReview.get(planned.id);
      expect(review).toMatchObject({
        canApprove: true,
        packageSynced: true,
        blockers: []
      });
      expect(review.project.finalRenderPath && existsSync(review.project.finalRenderPath)).toBe(true);
      expect(db.raw.prepare(`
        SELECT kind, state FROM renders WHERE project_id = ? ORDER BY created_at
      `).all(planned.id)).toEqual([
        { kind: 'draft', state: 'SUCCEEDED' },
        { kind: 'final', state: 'SUCCEEDED' }
      ]);
      expect(db.raw.prepare(`
        SELECT count(*) AS count FROM qc_results
        WHERE project_id = ? AND status = 'fail' AND severity IN ('BLOCKER','HIGH')
      `).get(planned.id)).toEqual({ count: 0 });
      expect(db.raw.prepare(`
        SELECT privacy_status, processing_status, caption_id, thumbnail_uploaded,
          snapshot_status
        FROM publication_records WHERE project_id = ?
      `).get(planned.id)).toMatchObject({
        privacy_status: 'private',
        processing_status: 'succeeded',
        caption_id: 'fixture-caption-1',
        thumbnail_uploaded: 1,
        snapshot_status: 'current'
      });
      const protocol = uploadProtocolState(db);
      expect(protocol).toMatchObject({
        session_creates: 1,
        remote_video_id: UPLOAD_FIXTURE_VIDEO_ID
      });
      expect(protocol.chunk_attempts).toBeGreaterThan(0);
      expect(protocol.remote_bytes).toBe(statSync(review.project.finalRenderPath!).size);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 600_000);
});
