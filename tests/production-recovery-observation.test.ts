import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import ffmpegStatic from 'ffmpeg-static';
import { buildDefaultSettings } from '@main/app-paths';
import { AppDatabase } from '@main/database/database';
import {
  captureProductionRecoverySnapshot,
  finalizeProductionRecoveryObservation,
  listProductionRecoveryCandidates
} from '../scripts/production-recovery-observation.mjs';

const roots: string[] = [];
const now = '2026-08-26T20:00:00.000Z';
const source = {
  commit: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  ref: 'main',
  repository: 'owner/repository',
  workflowCommit: null,
  runId: null,
  runAttempt: null,
  dirty: false
};

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'videofactory-recovery-observation-'));
  roots.push(root);
  const settings = buildDefaultSettings(join(root, 'application-data'));
  const database = new AppDatabase(settings.databasePath);
  database.saveAppSettings(settings);
  const executablePath = join(root, 'VideoFactory Desktop.exe');
  const provenancePath = join(root, 'RELEASE_PROVENANCE.json');
  writeFileSync(executablePath, 'packaged-application-bytes');
  writeFileSync(provenancePath, JSON.stringify({
    qualification: 'release',
    appVersion: '0.1.0-alpha.7',
    source
  }));
  database.raw.prepare(`
    INSERT INTO projects(
      id, sequence, slug, title, topic, state, progress,
      envato_project_name, target_duration_ms, created_at, updated_at
    ) VALUES('recovery-project', 1, 'recovery-project', 'Recovery', 'Recovery',
      'CREATED', 0, 'YT-RECOVERY', 300000, ?, ?)
  `).run(now, now);
  return { root, settings, database, executablePath, provenancePath };
}

function capture(value: ReturnType<typeof fixture>, kind: string, workId: string, phase: 'before' | 'after') {
  const processId = phase === 'before' ? 1234 : 5678;
  value.database.raw.prepare(`
    INSERT INTO audit_log(
      action, actor, entity_type, entity_id, after_json, metadata_json, created_at
    ) VALUES('application.runtime_started', 'system', 'application', ?, ?, ?, ?)
  `).run(
    '0.1.0-alpha.7',
    JSON.stringify({
      packaged: true,
      appVersion: '0.1.0-alpha.7',
      processId,
      executablePathSha256: digest(value.executablePath.toLowerCase())
    }),
    JSON.stringify({ trigger: 'application_start' }),
    phase === 'before' ? '2026-08-26T20:00:10.000Z' : '2026-08-26T20:02:10.000Z'
  );
  return captureProductionRecoverySnapshot({
    databasePath: value.settings.databasePath,
    kind,
    workId,
    phase,
    releaseProvenancePath: value.provenancePath,
    appExecutablePath: value.executablePath,
    processId,
    now: new Date(phase === 'before' ? '2026-08-26T20:00:30.000Z' : '2026-08-26T20:03:00.000Z')
  });
}

function processTrace() {
  return {
    startedAt: '2026-08-26T20:00:00.000Z',
    killedAt: '2026-08-26T20:01:00.000Z',
    restartedAt: '2026-08-26T20:02:00.000Z',
    completedAt: '2026-08-26T20:03:00.000Z',
    terminationMethod: 'windows_terminate_process',
    forced: true,
    processTree: true,
    exitObserved: true,
    initialPid: 1234,
    restartedPid: 5678,
    source,
    environment: {
      platform: 'win32',
      architecture: 'x64',
      release: '10.0.26100',
      node: 'v22.22.0',
      ci: false,
      deviceClass: 'representative-editor-workstation',
      machineFingerprintSha256: digest('machine')
    }
  };
}

function insertLicensedAsset(value: ReturnType<typeof fixture>, assetId = 'recovery-asset') {
  const originalPath = join(value.settings.mediaLibraryFolder, 'originals', `${assetId}.mp4`);
  const certificatePath = join(value.root, `${assetId}-license.txt`);
  writeFileSync(originalPath, `licensed-source-${assetId}`);
  writeFileSync(certificatePath, `license-${assetId}`);
  value.database.raw.prepare(`
    INSERT INTO assets(
      id, stable_key, provider, title, orientation, location_granularity,
      location_confidence, verification_status, availability_status,
      raw_row_json, imported_at, updated_at
    ) VALUES(?, ?, 'envato', ?, 'landscape', 'city', 1,
      'human_verified', 'available', '{}', ?, ?)
  `).run(assetId, assetId, `Recovery asset ${assetId}`, now, now);
  value.database.raw.prepare(`
    INSERT INTO project_licenses(
      id, project_id, asset_id, license_state, envato_project_name,
      certificate_path, operator_attested_at, created_at, updated_at
    ) VALUES(?, 'recovery-project', ?, 'CERTIFICATE_ATTACHED',
      'YT-RECOVERY', ?, ?, ?, ?)
  `).run(`license-${assetId}`, assetId, certificatePath, now, now, now);
  return { originalPath, certificatePath, sourceSha256: digest(readFileSync(originalPath)) };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('production recovery raw observation recorder', () => {
  it('binds a provider restart to exact packaged bytes, durable attempts, and preserved paid-call receipts', () => {
    const value = fixture();
    const inputSha256 = digest('provider-job-input');
    value.database.raw.prepare(`
      INSERT INTO jobs(
        id, project_id, type, state, phase, input_json, input_hash,
        attempt, available_at, created_at, updated_at
      ) VALUES('provider-job', 'recovery-project', 'workflow_finalize_script', 'QUEUED',
        'Waiting for provider capacity', '{}', ?, 0, ?, ?, ?)
    `).run(inputSha256, now, now, now);

    expect(listProductionRecoveryCandidates({
      databasePath: value.settings.databasePath,
      kind: 'provider'
    })).toMatchObject({
      kind: 'provider',
      schemaVersion: 24,
      candidates: [{
        workId: 'provider-job',
        type: 'workflow_finalize_script',
        state: 'QUEUED',
        attempt: 0
      }]
    });
    value.database.raw.prepare(`
      UPDATE jobs SET state = 'RUNNING', phase = 'Calling language provider', attempt = 1
      WHERE id = 'provider-job'
    `).run();
    value.database.raw.prepare(`
      INSERT INTO provider_calls(
        id, project_id, job_id, provider, model, operation, input_hash,
        output_hash, request_id, estimated_cost_usd, retry_count,
        response_json, created_at
      ) VALUES('provider-call', 'recovery-project', 'provider-job', 'openai', 'gpt-5',
        'finalize_script', ?, ?, 'request-1', 0.05, 0, '{"ok":true}', ?)
    `).run(digest('provider-input'), digest('provider-output'), now);

    const before = capture(value, 'provider', 'provider-job', 'before');
    value.database.raw.prepare(`
      UPDATE jobs SET state = 'SUCCEEDED', attempt = 2, progress = 1,
        output_json = '{}', completed_at = ?, updated_at = ? WHERE id = 'provider-job'
    `).run('2026-08-26T20:02:30.000Z', '2026-08-26T20:02:30.000Z');
    const after = capture(value, 'provider', 'provider-job', 'after');
    const missedRestart = structuredClone(after) as any;
    missedRestart.work.attempt = (before as any).work.attempt;
    expect(() => finalizeProductionRecoveryObservation({
      before,
      after: missedRestart,
      process: processTrace()
    })).toThrow(/retryRecorded/);
    const wrongSource = processTrace();
    wrongSource.source = { ...source, commit: 'c'.repeat(40) };
    expect(() => finalizeProductionRecoveryObservation({ before, after, process: wrongSource }))
      .toThrow(/does not match the packaged release commit\/tree/);
    const observation = finalizeProductionRecoveryObservation({ before, after, process: processTrace() }) as any;

    expect(observation).toMatchObject({
      kind: 'provider',
      source,
      application: { packaged: true },
      work: {
        inputSha256,
        attemptBefore: 1,
        attemptAfter: 2,
        recoveredFromCheckpoint: true,
        completed: true
      },
      evidence: {
        productionProviders: true,
        paidCallCountBefore: 1,
        paidCallCountAfter: 1,
        replayedCompletedCallSha256s: [],
        repeatedEstimatedCostMicros: 0
      }
    });
    expect(observation.evidence.completedCallSha256sAfter)
      .toEqual(observation.evidence.completedCallSha256sBefore);
    value.database.close();
  });

  it('binds licensed ingest completion to the real preserved source, derivatives, and startup audit', () => {
    const value = fixture();
    const media = insertLicensedAsset(value);
    const beforeCheckpoint = {
      sha256: media.sourceSha256,
      originalPath: media.originalPath,
      sourceFileName: 'recovery-source.mp4',
      phase: 'original_preserved',
      updatedAt: now
    };
    value.database.raw.prepare(`
      INSERT INTO acquisition_items(
        id, project_id, asset_id, ordinal, role, state, license_state,
        source_url, required_scene_ordinals_json, match_score, reasons_json,
        mapping_evidence_json, created_at, updated_at
      ) VALUES('recovery-acquisition', 'recovery-project', 'recovery-asset', 1,
        'primary', 'FILE_STABLE', 'CERTIFICATE_ATTACHED',
        'https://elements.envato.com/recovery-asset', '[1]', 1, '[]', ?, ?, ?)
    `).run(JSON.stringify({ ingestCheckpoint: beforeCheckpoint }), now, now);

    const before = capture(value, 'ingest', 'recovery-acquisition', 'before');
    const proxyPath = join(value.settings.mediaLibraryFolder, 'proxies', 'recovery.mp4');
    const contactSheetPath = join(value.settings.mediaLibraryFolder, 'keyframes', 'recovery.jpg');
    writeFileSync(proxyPath, 'proxy');
    writeFileSync(contactSheetPath, 'contact-sheet');
    value.database.raw.prepare(`
      INSERT INTO asset_files(
        id, asset_id, sha256, original_path, proxy_path, contact_sheet_path,
        original_file_name, file_size_bytes, duration_ms, width, height,
        frame_rate, codec, audio_present, raw_ffprobe_json, pipeline_version, created_at
      ) VALUES('recovery-file', 'recovery-asset', ?, ?, ?, ?, 'recovery-source.mp4',
        ?, 5000, 1920, 1080, 30, 'h264', 0, '{}', 'v1', ?)
    `).run(
      media.sourceSha256,
      media.originalPath,
      proxyPath,
      contactSheetPath,
      readFileSync(media.originalPath).length,
      now
    );
    value.database.raw.prepare(`
      INSERT INTO media_segments(
        id, asset_file_id, start_ms, end_ms, duration_ms, quality_score,
        effective_width, effective_height, eligible_1080p, eligible_4k,
        pipeline_version, created_at
      ) VALUES('recovery-segment', 'recovery-file', 0, 5000, 5000, 1,
        1920, 1080, 1, 0, 'v1', ?)
    `).run(now);
    const completedCheckpoint = { ...beforeCheckpoint, phase: 'complete', updatedAt: '2026-08-26T20:02:30.000Z' };
    value.database.raw.prepare(`
      UPDATE acquisition_items SET state = 'COMPLETE', mapped_file_id = 'recovery-file',
        mapping_evidence_json = ?, updated_at = ? WHERE id = 'recovery-acquisition'
    `).run(JSON.stringify({ ingestCheckpoint: completedCheckpoint }), completedCheckpoint.updatedAt);
    value.database.raw.prepare(`
      INSERT INTO audit_log(
        project_id, action, actor, entity_type, entity_id, after_json, metadata_json, created_at
      ) VALUES('recovery-project', 'media.ingest_recovered', 'system',
        'acquisition_item', 'recovery-acquisition', ?, ?, ?)
    `).run(
      JSON.stringify({
        state: 'COMPLETE',
        checkpointPhase: 'complete',
        sourceSha256: media.sourceSha256
      }),
      JSON.stringify({ trigger: 'startup_recovery' }),
      completedCheckpoint.updatedAt
    );

    const after = capture(value, 'ingest', 'recovery-acquisition', 'after');
    const observation = finalizeProductionRecoveryObservation({ before, after, process: processTrace() }) as any;
    expect(observation.work).toMatchObject({
      stateBefore: 'FILE_STABLE',
      stateAfter: 'COMPLETE',
      attemptBefore: 0,
      attemptAfter: 1,
      recoveredFromCheckpoint: true,
      completed: true
    });
    expect(observation.evidence).toMatchObject({
      licensedSource: true,
      sourceSha256: media.sourceSha256,
      checkpointPhaseBefore: 'original_preserved',
      checkpointPhaseAfter: 'complete',
      sourceHashVerified: true,
      derivativesVerified: true,
      managedPartialCountAfter: 0,
      unmanagedPathTouched: false
    });
    value.database.close();
  });

  it('binds render recovery to licensed inputs and independently probed managed output bytes', () => {
    if (!ffmpegStatic) throw new Error('ffmpeg-static binary is unavailable.');
    const value = fixture();
    const media = insertLicensedAsset(value, 'render-asset');
    value.database.raw.prepare(`
      INSERT INTO asset_files(
        id, asset_id, sha256, original_path, original_file_name, file_size_bytes,
        duration_ms, width, height, frame_rate, codec, audio_present,
        raw_ffprobe_json, pipeline_version, created_at
      ) VALUES('render-file', 'render-asset', ?, ?, 'render-source.mp4', ?,
        5000, 1920, 1080, 30, 'h264', 0, '{}', 'v1', ?)
    `).run(media.sourceSha256, media.originalPath, readFileSync(media.originalPath).length, now);
    value.database.raw.prepare(`
      INSERT INTO project_scenes(
        id, project_id, ordinal, narration, target_duration_ms,
        required_granularity, required_objects_json, required_activities_json,
        preferred_shots_json, visual_treatment, selected_asset_id,
        selected_file_id, score_explanation_json, verification_state, created_at, updated_at
      ) VALUES('render-scene', 'recovery-project', 1, 'Recovery narration', 5000,
        'city', '[]', '[]', '[]', 'FOOTAGE', 'render-asset', 'render-file',
        '[]', 'verified', ?, ?)
    `).run(now, now);
    const inputSha256 = digest('render-job-input');
    const outputPath = join(value.settings.outputFolder, 'published', 'recovery-final.mp4');
    const manifestPath = join(value.settings.projectFolder, 'recovery-manifest.json');
    value.database.raw.prepare(`
      INSERT INTO jobs(
        id, project_id, type, state, phase, input_json, input_hash,
        attempt, available_at, created_at, updated_at
      ) VALUES('render-job', 'recovery-project', 'render_final', 'RUNNING',
        'Assembling timeline', '{}', ?, 1, ?, ?, ?)
    `).run(inputSha256, now, now, now);
    value.database.raw.prepare(`
      UPDATE projects SET locked_by_job_id = 'render-job' WHERE id = 'recovery-project'
    `).run();
    value.database.raw.prepare(`
      INSERT INTO renders(
        id, project_id, kind, profile, state, manifest_path, output_path, created_at
      ) VALUES('recovery-render', 'recovery-project', 'final', 'final_1080p',
        'RUNNING', ?, ?, ?)
    `).run(manifestPath, outputPath, now);

    const before = capture(value, 'render', 'render-job', 'before');
    const encoded = spawnSync(ffmpegStatic, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=24:d=1',
      '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', outputPath
    ], { encoding: 'utf8' });
    expect(encoded.status, encoded.stderr).toBe(0);
    writeFileSync(manifestPath, JSON.stringify({ renderId: 'recovery-render' }));
    const outputSha256 = digest(readFileSync(outputPath));
    value.database.raw.prepare(`
      UPDATE renders SET state = 'SUCCEEDED', sha256 = ?, completed_at = ?
      WHERE id = 'recovery-render'
    `).run(outputSha256, '2026-08-26T20:02:30.000Z');
    value.database.raw.prepare(`
      UPDATE jobs SET state = 'SUCCEEDED', attempt = 2, output_json = ?,
        completed_at = ?, updated_at = ? WHERE id = 'render-job'
    `).run(
      JSON.stringify({ id: 'recovery-render' }),
      '2026-08-26T20:02:30.000Z',
      '2026-08-26T20:02:30.000Z'
    );

    const after = capture(value, 'render', 'render-job', 'after');
    const observation = finalizeProductionRecoveryObservation({ before, after, process: processTrace() }) as any;
    expect(observation.evidence).toMatchObject({
      licensedInputs: true,
      jobType: 'render_final',
      phaseBefore: 'Assembling timeline',
      renderStateBefore: 'RUNNING',
      renderStateAfter: 'SUCCEEDED',
      outputSha256,
      mediaProbePassed: true,
      managedPartialCountAfter: 0,
      unmanagedPathTouched: false
    });
    value.database.close();
  });

  it('binds live resumable upload recovery to one session, publication, and startup reconciliation', () => {
    const value = fixture();
    const inputSha256 = digest('upload-job-input');
    const finalSha256 = digest('upload-final');
    const approvalHash = digest('upload-approval');
    const session = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=live-session';
    const finalPath = join(value.settings.outputFolder, 'review', 'upload-final.mp4');
    const thumbnailPath = join(value.settings.outputFolder, 'review', 'upload-thumbnail.jpg');
    writeFileSync(finalPath, 'upload-final');
    writeFileSync(thumbnailPath, 'upload-thumbnail');
    value.database.raw.prepare(`
      INSERT INTO renders(
        id, project_id, kind, profile, state, output_path, sha256, created_at, completed_at
      ) VALUES('upload-render', 'recovery-project', 'final', 'final_1080p',
        'SUCCEEDED', ?, ?, ?, ?)
    `).run(finalPath, finalSha256, now, now);
    value.database.raw.prepare(`
      INSERT INTO packaging_candidates(
        id, project_id, ordinal, title, angle, viewer_promise, thumbnail_path,
        description, chapters, tags_json, risk_status, selected, created_at
      ) VALUES('upload-package', 'recovery-project', 1, 'Recovery title', 'Angle',
        'Promise', ?, 'Description', '00:00 Recovery', '["recovery"]', 'pass', 1, ?)
    `).run(thumbnailPath, now);
    value.database.raw.prepare(`
      UPDATE projects SET final_render_id = 'upload-render' WHERE id = 'recovery-project'
    `).run();
    const uploadSnapshot = {
      snapshotVersion: 1,
      projectId: 'recovery-project',
      finalRenderId: 'upload-render',
      finalSha256,
      finalOutputPath: finalPath,
      finalManifestPath: null,
      selectedPackageId: 'upload-package',
      title: 'Recovery title',
      description: 'Description',
      chapters: '00:00 Recovery',
      tags: ['recovery'],
      thumbnailPath,
      thumbnailSha256: digest(readFileSync(thumbnailPath)),
      approvalHash,
      confirmedChannelId: 'UC-recovery'
    };
    value.database.raw.prepare(`
      INSERT INTO youtube_connection_binding(
        singleton_id, channel_id, channel_title, credential_fingerprint, confirmed_at
      ) VALUES(1, 'UC-recovery', 'Recovery channel', ?, ?)
    `).run(digest('oauth-credential'), now);
    value.database.raw.prepare(`
      INSERT INTO jobs(
        id, project_id, type, state, phase, input_json, input_hash,
        attempt, available_at, created_at, updated_at
      ) VALUES('upload-job', 'recovery-project', 'workflow_upload_private', 'RUNNING',
        'Uploading private video', ?, ?, 1, ?, ?, ?)
    `).run(JSON.stringify(uploadSnapshot), inputSha256, now, now, now);
    value.database.raw.prepare(`
      INSERT INTO publication_records(
        id, project_id, channel_id, video_id, privacy_status, upload_session_uri,
        final_render_id, final_sha256, snapshot_version, snapshot_status,
        processing_status, selected_package_id, approval_hash, created_at, updated_at
      ) VALUES('recovery-publication', 'recovery-project', 'UC-recovery', NULL,
        'private', ?, 'upload-render', ?, 1, 'current', 'uploading',
        'upload-package', ?, ?, ?)
    `).run(session, finalSha256, approvalHash, now, now);

    const before = capture(value, 'upload_session', 'upload-job', 'before');
    value.database.raw.prepare(`
      UPDATE publication_records SET video_id = 'remote-video-id',
        processing_status = 'succeeded', caption_id = 'caption-id',
        thumbnail_uploaded = 1, updated_at = ? WHERE id = 'recovery-publication'
    `).run('2026-08-26T20:02:30.000Z');
    value.database.raw.prepare(`
      UPDATE jobs SET state = 'SUCCEEDED', attempt = 2, output_json = '{}',
        completed_at = ?, updated_at = ? WHERE id = 'upload-job'
    `).run('2026-08-26T20:02:30.000Z', '2026-08-26T20:02:30.000Z');
    value.database.raw.prepare(`
      INSERT INTO job_retry_reconciliations(
        id, job_id, job_transition_version, job_type, outcome,
        publication_id, video_id, input_hash, metadata_json, created_at
      ) VALUES('upload-reconciliation', 'upload-job', 1, 'workflow_upload_private',
        'remote_session_reused', 'recovery-publication', 'remote-video-id', ?, '{}', ?)
    `).run(inputSha256, '2026-08-26T20:02:00.000Z');

    const after = capture(value, 'upload_session', 'upload-job', 'after');
    const observation = finalizeProductionRecoveryObservation({ before, after, process: processTrace() }) as any;
    expect(observation.evidence).toMatchObject({
      liveGoogleApi: true,
      oauthAuthorized: true,
      uploadSessionSha256Before: digest(session),
      uploadSessionSha256After: digest(session),
      videoIdSha256Before: null,
      videoIdSha256After: digest('remote-video-id'),
      publicationCountBefore: 1,
      publicationCountAfter: 1,
      reconciliationOutcome: 'remote_session_reused',
      attachmentsComplete: true,
      processingSucceeded: true
    });
    value.database.close();
  });

  it('requires a durable restore audit, actual safety database, and actual original-file availability', () => {
    const value = fixture();
    const backupDirectory = join(value.settings.backupFolder, 'daily');
    const backupPath = join(backupDirectory, 'representative.sqlite');
    mkdirSync(backupDirectory, { recursive: true });
    value.database.checkpoint();
    copyFileSync(value.settings.databasePath, backupPath);
    const backupSha256 = digest(readFileSync(backupPath));
    const pendingPath = `${value.settings.databasePath}.restore-pending`;
    const markerPath = `${value.settings.databasePath}.restore-request.json`;
    const requestId = '11111111-2222-4333-8444-555555555555';
    copyFileSync(backupPath, pendingPath);
    writeFileSync(markerPath, JSON.stringify({
      requestId,
      backupPath,
      pendingPath,
      expectedChecksum: backupSha256
    }));

    const before = capture(value, 'restore', backupPath, 'before');
    const safetyPath = `${value.settings.databasePath}.pre-restore-2026-08-26`;
    value.database.checkpoint();
    copyFileSync(value.settings.databasePath, safetyPath);
    const safetyBackupSha256 = digest(readFileSync(safetyPath));
    unlinkSync(pendingPath);
    unlinkSync(markerPath);
    value.database.raw.prepare(`
      INSERT INTO audit_log(action, actor, entity_type, entity_id, after_json, metadata_json, created_at)
      VALUES('backup.restore_recovered', 'system', 'database', ?, ?, ?, ?)
    `).run(
      requestId,
      JSON.stringify({
        requestId,
        restoredAt: '2026-08-26T20:02:00.000Z',
        sourceChecksum: backupSha256,
        safetyBackupSha256,
        safetyBackupIntegrity: 'ok',
        projectCount: 1,
        rebuildPassed: true,
        missingOriginalsCount: 0,
        failureCount: 0
      }),
      JSON.stringify({ trigger: 'startup_restore_recovery' }),
      '2026-08-26T20:02:30.000Z'
    );

    const after = capture(value, 'restore', backupPath, 'after');
    const observation = finalizeProductionRecoveryObservation({ before, after, process: processTrace() }) as any;
    expect(observation.work).toMatchObject({
      attemptBefore: 0,
      attemptAfter: 1,
      recoveredFromCheckpoint: true,
      completed: true
    });
    expect(observation.evidence).toMatchObject({
      representativeData: true,
      backupSha256,
      stagedSha256: backupSha256,
      restoredSourceSha256: backupSha256,
      safetyBackupSha256,
      safetyBackupIntegrity: 'ok',
      pendingMarkerBefore: true,
      completionMarkerAfter: false,
      artifactRebuildStatus: 'passed',
      missingOriginalsCount: 0
    });
    value.database.close();
  });

  it('fails closed when the database is not the packaged application data-root database', () => {
    const value = fixture();
    const movedDatabase = join(value.root, 'unrelated.sqlite');
    value.database.checkpoint();
    copyFileSync(value.settings.databasePath, movedDatabase);

    expect(() => captureProductionRecoverySnapshot({
      databasePath: movedDatabase,
      kind: 'provider',
      workId: 'missing',
      phase: 'before',
      releaseProvenancePath: value.provenancePath,
      appExecutablePath: value.executablePath,
      processId: 1234
    })).toThrow(/does not match the packaged application data-root/);
    value.database.close();
  });
});
