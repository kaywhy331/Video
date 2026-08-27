import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { arch, platform, release as operatingSystemRelease } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import ffprobeStatic from 'ffprobe-static';
import {
  PRODUCTION_RECOVERY_OBSERVATION_KIND,
  PRODUCTION_RECOVERY_OBSERVATION_VERSION
} from './collect-production-recovery-evidence.mjs';
import {
  PRODUCTION_RECOVERY_DRILL_KINDS,
  assessProductionRecoveryObservation
} from './production-recovery-evidence.mjs';
import { assertValidationSource } from './validation-source.mjs';

export const PRODUCTION_RECOVERY_SNAPSHOT_VERSION = 1;
export const PRODUCTION_RECOVERY_SNAPSHOT_KIND = 'videofactory-production-recovery-snapshot';

export function listProductionRecoveryCandidates({ databasePath, kind }) {
  if (!PRODUCTION_RECOVERY_DRILL_KINDS.includes(kind)) {
    throw new Error(`Unsupported production recovery drill kind: ${String(kind)}.`);
  }
  const normalizedDatabasePath = requiredFile(databasePath, 'Production recovery database');
  const database = new DatabaseSync(normalizedDatabasePath, { readOnly: true });
  try {
    database.exec('PRAGMA busy_timeout = 5000');
    const settings = appSettings(database);
    if (resolve(String(settings.databasePath ?? '')) !== normalizedDatabasePath) {
      throw new Error('Production recovery database does not match the packaged application data-root settings.');
    }
    let candidates;
    if (kind === 'ingest') {
      candidates = all(database, `
        SELECT id, state, mapping_evidence_json, updated_at
        FROM acquisition_items
        WHERE state NOT IN ('COMPLETE', 'SKIPPED', 'FAILED')
        ORDER BY updated_at DESC, id DESC LIMIT 50
      `).map(row => ({
        workId: String(row.id),
        state: String(row.state),
        checkpointPhase: String(parseObject(row.mapping_evidence_json).ingestCheckpoint?.phase ?? 'not_started'),
        updatedAt: String(row.updated_at)
      }));
    } else if (kind === 'restore') {
      const backupRoot = String(settings.backupFolder ?? '');
      candidates = existsSync(backupRoot)
        ? listFiles(backupRoot)
          .filter(path => path.toLowerCase().endsWith('.sqlite'))
          .map(path => ({
            workId: path,
            state: 'AVAILABLE',
            sizeBytes: statSync(path).size,
            updatedAt: statSync(path).mtime.toISOString()
          }))
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          .slice(0, 50)
        : [];
    } else {
      const types = kind === 'provider'
        ? ['workflow_finalize_script', 'workflow_generate_voice']
        : kind === 'render'
          ? ['render_draft', 'render_final']
          : ['workflow_upload_private'];
      candidates = all(database, `
        SELECT id, type, state, phase, attempt, updated_at
        FROM jobs
        WHERE type IN (${types.map(() => '?').join(', ')})
          AND state IN ('QUEUED', 'READY', 'RETRY_SCHEDULED', 'WAITING_EXTERNAL', 'RUNNING', 'FAILED')
        ORDER BY updated_at DESC, id DESC LIMIT 50
      `, ...types).map(row => ({
        workId: String(row.id),
        type: String(row.type),
        state: String(row.state),
        phase: row.phase === null ? null : String(row.phase),
        attempt: Number(row.attempt),
        updatedAt: String(row.updated_at)
      }));
    }
    return {
      kind,
      schemaVersion: integer(scalar(database, 'SELECT max(version) FROM schema_migrations'), 'database schema version'),
      candidates
    };
  } finally {
    database.close();
  }
}

export function captureProductionRecoverySnapshot({
  databasePath,
  kind,
  workId,
  phase,
  releaseProvenancePath,
  appExecutablePath,
  processId,
  now = new Date()
}) {
  if (!PRODUCTION_RECOVERY_DRILL_KINDS.includes(kind)) {
    throw new Error(`Unsupported production recovery drill kind: ${String(kind)}.`);
  }
  if (!['before', 'after'].includes(phase)) {
    throw new Error('Production recovery snapshot phase must be before or after.');
  }
  const normalizedWorkId = nonEmptyString(workId, 'Production recovery work ID');
  const normalizedDatabasePath = requiredFile(databasePath, 'Production recovery database');
  const normalizedProvenancePath = requiredFile(releaseProvenancePath, 'Release provenance');
  const normalizedExecutablePath = requiredFile(appExecutablePath, 'Packaged application executable');
  const provenanceBytes = readFileSync(normalizedProvenancePath);
  const provenance = parseJson(provenanceBytes, 'Release provenance');
  if (provenance.qualification !== 'release' || typeof provenance.appVersion !== 'string') {
    throw new Error('Production recovery requires release-qualified provenance with an app version.');
  }
  assertValidationSource(provenance.source, 'release', 'Production recovery release source');

  const database = new DatabaseSync(normalizedDatabasePath);
  try {
    database.exec('PRAGMA busy_timeout = 5000');
    const databaseEvidence = {
      schemaVersion: integer(scalar(database, 'SELECT max(version) FROM schema_migrations'), 'database schema version'),
      integrity: String(scalar(database, 'PRAGMA integrity_check') ?? 'unknown'),
      foreignKeyViolations: all(database, 'PRAGMA foreign_key_check').length
    };
    const settings = appSettings(database);
    if (resolve(String(settings.databasePath ?? '')) !== normalizedDatabasePath) {
      throw new Error('Production recovery database does not match the packaged application data-root settings.');
    }
    const normalizedProcessId = positiveInteger(processId, 'Production recovery process ID');
    const runtimeRow = get(database, `
      SELECT after_json FROM audit_log
      WHERE action = 'application.runtime_started' AND entity_id = ?
      ORDER BY id DESC LIMIT 1
    `, provenance.appVersion);
    if (!runtimeRow) throw new Error('Production recovery packaged runtime startup audit is missing.');
    const runtime = exactRecord(parseObject(runtimeRow.after_json), [
      'packaged', 'appVersion', 'processId', 'executablePathSha256'
    ], 'Production recovery packaged runtime startup audit');
    if (
      runtime.packaged !== true
      || runtime.appVersion !== provenance.appVersion
      || runtime.processId !== normalizedProcessId
      || runtime.executablePathSha256 !== digest(normalizedExecutablePath.toLowerCase())
    ) {
      throw new Error('Production recovery packaged runtime startup audit does not match the selected process/application.');
    }
    const captured = captureStage({
      database,
      databasePath: normalizedDatabasePath,
      settings,
      kind,
      workId: normalizedWorkId,
      phase
    });
    return {
      snapshotVersion: PRODUCTION_RECOVERY_SNAPSHOT_VERSION,
      evidenceKind: PRODUCTION_RECOVERY_SNAPSHOT_KIND,
      capturedAt: canonicalTimestamp(now),
      phase,
      kind,
      appVersion: provenance.appVersion,
      source: structuredClone(provenance.source),
      application: {
        packaged: runtime.packaged,
        executableSha256: fileSha256(normalizedExecutablePath),
        releaseProvenanceSha256: digest(provenanceBytes),
        releaseCommit: provenance.source.commit,
        releaseTree: provenance.source.tree
      },
      runtime: structuredClone(runtime),
      database: databaseEvidence,
      work: captured.work,
      stage: captured.stage
    };
  } finally {
    database.close();
  }
}

export function finalizeProductionRecoveryObservation({ before, after, process }) {
  assertSnapshot(before, 'before');
  assertSnapshot(after, 'after');
  if (before.kind !== after.kind) throw new Error('Production recovery snapshots have different drill kinds.');
  if (before.appVersion !== after.appVersion) throw new Error('Production recovery snapshots have different app versions.');
  if (JSON.stringify(before.source) !== JSON.stringify(after.source)) {
    throw new Error('Production recovery snapshots have different exact sources.');
  }
  if (JSON.stringify(before.application) !== JSON.stringify(after.application)) {
    throw new Error('Production recovery snapshots have different packaged applications.');
  }
  if (before.work.identity !== after.work.identity || before.work.inputSha256 !== after.work.inputSha256) {
    throw new Error('Production recovery snapshots do not describe the same durable work identity.');
  }
  const trace = exactRecord(process, [
    'startedAt',
    'killedAt',
    'restartedAt',
    'completedAt',
    'terminationMethod',
    'forced',
    'processTree',
    'exitObserved',
    'initialPid',
    'restartedPid',
    'environment',
    'source'
  ], 'Production recovery process trace');
  if (
    before.runtime.processId !== trace.initialPid
    || after.runtime.processId !== trace.restartedPid
    || before.runtime.packaged !== true
    || after.runtime.packaged !== true
    || before.runtime.appVersion !== after.runtime.appVersion
    || before.runtime.executablePathSha256 !== after.runtime.executablePathSha256
  ) {
    throw new Error('Production recovery snapshots do not match the terminated and restarted packaged runtime processes.');
  }
  const environment = exactRecord(trace.environment, [
    'platform',
    'architecture',
    'release',
    'node',
    'ci',
    'deviceClass',
    'machineFingerprintSha256'
  ], 'Production recovery process environment');
  assertValidationSource(trace.source, 'release', 'Production recovery operator source');
  if (trace.source.commit !== before.source.commit || trace.source.tree !== before.source.tree) {
    throw new Error('Production recovery operator source does not match the packaged release commit/tree.');
  }
  const evidence = finalizeStage(before.kind, before.stage, after.stage);
  const observation = {
    observationVersion: PRODUCTION_RECOVERY_OBSERVATION_VERSION,
    evidenceKind: PRODUCTION_RECOVERY_OBSERVATION_KIND,
    capturedAt: canonicalTimestamp(trace.completedAt),
    appVersion: before.appVersion,
    mode: 'qualification',
    source: structuredClone(trace.source),
    environment: structuredClone(environment),
    application: structuredClone(before.application),
    kind: before.kind,
    startedAt: canonicalTimestamp(trace.startedAt),
    killedAt: canonicalTimestamp(trace.killedAt),
    restartedAt: canonicalTimestamp(trace.restartedAt),
    completedAt: canonicalTimestamp(trace.completedAt),
    process: {
      terminationMethod: trace.terminationMethod,
      forced: trace.forced,
      processTree: trace.processTree,
      exitObserved: trace.exitObserved,
      initialPid: trace.initialPid,
      restartedPid: trace.restartedPid
    },
    database: {
      schemaVersionBefore: before.database.schemaVersion,
      schemaVersionAfter: after.database.schemaVersion,
      integrityBefore: before.database.integrity,
      integrityAfter: after.database.integrity,
      foreignKeyViolationsBefore: before.database.foreignKeyViolations,
      foreignKeyViolationsAfter: after.database.foreignKeyViolations
    },
    work: {
      identity: before.work.identity,
      inputSha256: before.work.inputSha256,
      stateBefore: before.work.state,
      stateAfter: after.work.state,
      attemptBefore: before.work.attempt,
      attemptAfter: after.work.attempt,
      recoveredFromCheckpoint: after.work.recoveredFromCheckpoint,
      completed: after.work.completed
    },
    evidence
  };
  const semanticAssessment = assessProductionRecoveryObservation({
    kind: observation.kind,
    observationSha256: digest(canonicalJson(observation)),
    observationSizeBytes: Buffer.byteLength(canonicalJson(observation)),
    startedAt: observation.startedAt,
    killedAt: observation.killedAt,
    restartedAt: observation.restartedAt,
    completedAt: observation.completedAt,
    process: {
      terminationMethod: observation.process.terminationMethod,
      forced: observation.process.forced,
      processTree: observation.process.processTree,
      exitObserved: observation.process.exitObserved,
      initialPidSha256: digest(`pid:${observation.process.initialPid}`),
      restartedPidSha256: digest(`pid:${observation.process.restartedPid}`)
    },
    database: observation.database,
    work: {
      identitySha256: digest(`work:${observation.work.identity}`),
      inputSha256: observation.work.inputSha256,
      stateBefore: observation.work.stateBefore,
      stateAfter: observation.work.stateAfter,
      attemptBefore: observation.work.attemptBefore,
      attemptAfter: observation.work.attemptAfter,
      recoveredFromCheckpoint: observation.work.recoveredFromCheckpoint,
      completed: observation.work.completed
    },
    evidence: observation.evidence
  });
  if (!semanticAssessment.commonPassed || !semanticAssessment.stagePassed) {
    const failed = Object.entries(semanticAssessment.checks)
      .filter(([, passed]) => !passed)
      .map(([name]) => name);
    throw new Error(`Production recovery raw observation failed semantic checks: ${failed.join(', ')}.`);
  }
  if (
    environment.platform !== 'win32'
    || environment.architecture !== 'x64'
    || environment.ci !== false
    || observation.application.packaged !== true
  ) {
    throw new Error('Production recovery raw observation is not a representative non-CI packaged Windows x64 drill.');
  }
  return observation;
}

function captureStage(input) {
  if (input.kind === 'provider') return captureProvider(input);
  if (input.kind === 'ingest') return captureIngest(input);
  if (input.kind === 'render') return captureRender(input);
  if (input.kind === 'upload_session' || input.kind === 'upload_commit') return captureUpload(input);
  return captureRestore(input);
}

function captureProvider({ database, workId, phase }) {
  const job = requireJob(database, workId, ['workflow_finalize_script', 'workflow_generate_voice']);
  assertJobPhase(job, phase);
  const rows = all(database, `
    SELECT provider, model, operation, input_hash, output_hash, request_id,
      estimated_cost_usd, retry_count, created_at
    FROM provider_calls
    WHERE project_id = ? AND error IS NULL AND output_hash IS NOT NULL
      AND response_json IS NOT NULL
    ORDER BY provider, model, operation, input_hash
  `, job.project_id);
  const calls = rows.map(row => {
    const identity = {
      provider: String(row.provider),
      model: String(row.model),
      operation: String(row.operation),
      inputHash: String(row.input_hash)
    };
    const costMicros = Math.max(0, Math.round(Number(row.estimated_cost_usd ?? 0) * 1_000_000));
    return {
      keySha256: digest(canonicalJson(identity)),
      fingerprintSha256: digest(canonicalJson({
        ...identity,
        outputHash: row.output_hash,
        requestId: row.request_id,
        costMicros,
        retryCount: Number(row.retry_count),
        createdAt: row.created_at
      })),
      provider: identity.provider,
      costMicros
    };
  });
  if (phase === 'before' && !calls.some(call => call.costMicros > 0)) {
    throw new Error('Provider recovery boundary requires at least one completed paid provider call before termination.');
  }
  return {
    work: jobWork(job),
    stage: {
      productionProviders: calls.length > 0 && calls.every(call => !/^(?:mock|fixture|disabled|local)$/i.test(call.provider)),
      calls
    }
  };
}

function captureIngest({ database, settings, workId, phase }) {
  const row = get(database, `
    SELECT item.id, item.project_id, item.state, item.mapping_evidence_json,
      item.mapped_file_id, asset.provider, license.license_state,
      license.certificate_path, file.sha256, file.original_path,
      file.proxy_path, file.contact_sheet_path
    FROM acquisition_items item
    JOIN assets asset ON asset.id = item.asset_id
    LEFT JOIN project_licenses license
      ON license.project_id = item.project_id AND license.asset_id = item.asset_id
    LEFT JOIN asset_files file ON file.id = item.mapped_file_id
    WHERE item.id = ?
  `, workId);
  if (!row) throw new Error('Production recovery ingest acquisition was not found.');
  const mapping = parseObject(row.mapping_evidence_json);
  const checkpoint = parseObject(mapping.ingestCheckpoint);
  const originalPath = String(checkpoint.originalPath ?? row.original_path ?? '');
  const sourceSha256 = String(checkpoint.sha256 ?? row.sha256 ?? '');
  if (!/^[a-f0-9]{64}$/u.test(sourceSha256)) throw new Error('Ingest recovery has no durable source SHA-256.');
  if (phase === 'before' && !(row.state === 'FILE_STABLE' && checkpoint.phase === 'original_preserved')) {
    throw new Error('Ingest recovery before-snapshot requires FILE_STABLE at original_preserved.');
  }
  if (phase === 'after' && !(row.state === 'COMPLETE' && checkpoint.phase === 'complete')) {
    throw new Error('Ingest recovery after-snapshot requires COMPLETE at the complete checkpoint.');
  }
  const sourceHashVerified = existsSync(originalPath) && fileSha256(originalPath) === sourceSha256;
  const derivativesVerified = phase === 'before' || Boolean(
    row.proxy_path && existsSync(String(row.proxy_path))
      && row.contact_sheet_path && existsSync(String(row.contact_sheet_path))
      && Number(scalar(database, 'SELECT count(*) FROM media_segments WHERE asset_file_id = ?', row.mapped_file_id)) > 0
  );
  const licensedSource = row.provider === 'envato'
    && ['CERTIFICATE_ATTACHED', 'VERIFIED'].includes(String(row.license_state))
    && Boolean(row.certificate_path && existsSync(String(row.certificate_path)));
  const recoveryCount = Number(scalar(database, `
    SELECT count(*) FROM audit_log
    WHERE action = 'media.ingest_recovered' AND entity_id = ?
  `, row.id));
  const recoveryAudit = get(database, `
    SELECT after_json FROM audit_log
    WHERE action = 'media.ingest_recovered' AND entity_id = ?
    ORDER BY id DESC LIMIT 1
  `, row.id);
  const recoveryAfter = parseObject(recoveryAudit?.after_json);
  const recoveredFromCheckpoint = phase === 'after'
    && recoveryAfter.state === 'COMPLETE'
    && recoveryAfter.checkpointPhase === 'complete'
    && recoveryAfter.sourceSha256 === sourceSha256;
  return {
    work: {
      identity: String(row.id),
      inputSha256: sourceSha256,
      state: String(row.state),
      attempt: recoveryCount,
      recoveredFromCheckpoint,
      completed: phase === 'after' && row.state === 'COMPLETE'
    },
    stage: {
      licensedSource,
      sourceSha256,
      checkpointPhase: String(checkpoint.phase ?? 'missing'),
      assetState: String(row.state),
      sourceHashVerified,
      derivativesVerified,
      managedPartialCount: countPartialFiles([settings.mediaLibraryFolder]),
      unmanagedPathTouched: !pathInside(originalPath, settings.mediaLibraryFolder)
    }
  };
}

function captureRender({ database, settings, workId, phase }) {
  const job = requireJob(database, workId, ['render_draft', 'render_final']);
  assertJobPhase(job, phase);
  if (phase === 'before' && scalar(database, 'SELECT locked_by_job_id FROM projects WHERE id = ?', job.project_id) !== job.id) {
    throw new Error('Render recovery before-snapshot requires the project lock owned by the selected render job.');
  }
  const jobOutput = parseObject(job.output_json);
  const render = phase === 'after' && jobOutput.id
    ? get(database, 'SELECT * FROM renders WHERE id = ?', jobOutput.id)
    : get(database, `
        SELECT * FROM renders WHERE project_id = ? AND state = 'RUNNING'
        ORDER BY created_at DESC, id DESC LIMIT 1
      `, job.project_id);
  if (!render) throw new Error(`Render recovery ${phase}-snapshot has no matching render row.`);
  if (phase === 'before' && (job.phase !== 'Assembling timeline' || render.state !== 'RUNNING')) {
    throw new Error('Render recovery before-snapshot requires the Assembling timeline RUNNING boundary.');
  }
  if (phase === 'after' && render.state !== 'SUCCEEDED') {
    throw new Error('Render recovery after-snapshot requires a succeeded render.');
  }
  const outputPath = String(render.output_path ?? '');
  const manifestPath = String(render.manifest_path ?? '');
  const outputSha256 = phase === 'after' ? requiredMatchingHash(outputPath, render.sha256, 'render output') : digest('pending-render-output');
  const manifestSha256 = phase === 'after' ? fileSha256(requiredFile(manifestPath, 'Render manifest')) : digest('pending-render-manifest');
  const workDirectory = join(String(settings.projectFolder ?? ''), String(job.project_id), 'render-work', String(render.id));
  return {
    work: jobWork(job),
    stage: {
      licensedInputs: selectedFootageLicensed(database, String(job.project_id)),
      jobType: String(job.type),
      phase: String(job.phase ?? ''),
      renderState: String(render.state),
      outputSha256,
      manifestSha256,
      mediaProbePassed: phase === 'before' || probeMedia(outputPath),
      managedPartialCount: existsSync(workDirectory) ? countPartialFiles([workDirectory]) : 0,
      unmanagedPathTouched: Boolean(outputPath) && !pathInside(outputPath, String(settings.outputFolder ?? ''))
    }
  };
}

function captureUpload({ database, workId, phase, kind }) {
  const job = requireJob(database, workId, ['workflow_upload_private']);
  assertJobPhase(job, phase);
  const input = parseObject(job.input_json);
  const publication = get(database, `
    SELECT * FROM publication_records
    WHERE project_id = ? AND snapshot_status = 'current'
    ORDER BY created_at DESC, id DESC LIMIT 1
  `, job.project_id);
  if (!publication) throw new Error('Upload recovery has no current durable publication record.');
  if (
    input.snapshotVersion !== 1
    || input.projectId !== job.project_id
    || input.finalRenderId !== publication.final_render_id
    || input.finalSha256 !== publication.final_sha256
    || input.selectedPackageId !== publication.selected_package_id
    || input.approvalHash !== publication.approval_hash
    || input.confirmedChannelId !== publication.channel_id
    || input.snapshotVersion !== publication.snapshot_version
  ) {
    throw new Error('Upload recovery publication does not match the selected job publication snapshot.');
  }
  const session = String(publication.upload_session_uri ?? '');
  const video = publication.video_id === null ? null : String(publication.video_id);
  if (!session) throw new Error('Upload recovery has no durable resumable session.');
  let liveUploadSession = false;
  try {
    const url = new URL(session);
    liveUploadSession = url.protocol === 'https:'
      && ['www.googleapis.com', 'youtube.googleapis.com', 'content.googleapis.com']
        .includes(url.hostname.toLowerCase());
  } catch {
    liveUploadSession = false;
  }
  if (phase === 'before' && kind === 'upload_session' && video !== null) {
    throw new Error('Upload-session recovery before-snapshot must precede durable remote-video persistence.');
  }
  if (phase === 'before' && kind === 'upload_commit' && video === null) {
    throw new Error('Upload-commit recovery before-snapshot requires a durable remote-video identity.');
  }
  if (phase === 'after' && (video === null || publication.processing_status !== 'succeeded')) {
    throw new Error('Upload recovery after-snapshot requires one successfully processed remote video.');
  }
  const binding = get(database, `
    SELECT channel_id, credential_fingerprint
    FROM youtube_connection_binding WHERE singleton_id = 1
  `);
  const reconciliation = get(database, `
    SELECT outcome FROM job_retry_reconciliations
    WHERE job_id = ? ORDER BY created_at DESC, id DESC LIMIT 1
  `, job.id);
  const publicationCount = Number(scalar(database, `
    SELECT count(*) FROM publication_records WHERE project_id = ? AND snapshot_status = 'current'
  `, job.project_id));
  return {
    work: jobWork(job),
    stage: {
      liveGoogleApi: Boolean(
        liveUploadSession && binding?.channel_id && publication.channel_id === binding.channel_id
      ),
      oauthAuthorized: /^[a-f0-9]{64}$/u.test(String(binding?.credential_fingerprint ?? '')),
      uploadSessionSha256: digest(session),
      videoIdSha256: video === null ? null : digest(video),
      publicationCount,
      reconciliationOutcome: reconciliation?.outcome ?? null,
      attachmentsComplete: Boolean(publication.thumbnail_uploaded && publication.caption_id),
      processingSucceeded: publication.processing_status === 'succeeded'
    }
  };
}

function captureRestore({ database, databasePath, settings, workId, phase }) {
  const backupPath = requiredFile(workId, 'Restore qualification backup');
  if (!pathInside(backupPath, String(settings.backupFolder ?? ''))) {
    throw new Error('Restore qualification backup must be inside the configured backup directory.');
  }
  const pendingPath = `${databasePath}.restore-pending`;
  const markerPath = `${databasePath}.restore-request.json`;
  const completionPath = `${databasePath}.restore-completed.json`;
  const backupSha256 = fileSha256(backupPath);
  const stagedSha256 = existsSync(pendingPath) ? fileSha256(pendingPath) : null;
  const pendingMarker = existsSync(markerPath)
    ? exactRecord(parseJson(readFileSync(markerPath), 'Restore qualification pending marker'), [
      'requestId', 'backupPath', 'pendingPath', 'expectedChecksum'
    ], 'Restore qualification pending marker')
    : null;
  if (phase === 'before' && (
    !pendingMarker
    || !restoreRequestIdPattern.test(String(pendingMarker.requestId ?? ''))
    || resolve(String(pendingMarker.backupPath ?? '')) !== backupPath
    || resolve(String(pendingMarker.pendingPath ?? '')) !== pendingPath
    || pendingMarker.expectedChecksum !== backupSha256
    || stagedSha256 !== backupSha256
  )) {
    throw new Error('Restore recovery before-snapshot requires an intact staged restore marker and bytes.');
  }
  const recoveryRow = phase === 'after' ? get(database, `
      SELECT after_json FROM audit_log
      WHERE action = 'backup.restore_recovered'
        AND json_extract(after_json, '$.sourceChecksum') = ?
      ORDER BY id DESC LIMIT 1
    `, backupSha256) : null;
  const recovery = recoveryRow
    ? exactRecord(parseObject(recoveryRow.after_json), [
      'requestId', 'restoredAt', 'sourceChecksum', 'safetyBackupSha256',
      'safetyBackupIntegrity', 'projectCount', 'rebuildPassed',
      'missingOriginalsCount', 'failureCount'
    ], 'Restore qualification recovery audit')
    : {};
  const restoreRequestId = phase === 'before' ? pendingMarker.requestId : recovery.requestId;
  const safetyPaths = readdirSync(dirname(databasePath))
    .filter(name => name.startsWith(`${basename(databasePath)}.pre-restore-`))
    .map(name => join(dirname(databasePath), name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  const safetyPath = phase === 'after' && typeof recovery.safetyBackupSha256 === 'string'
    ? safetyPaths.find(path => fileSha256(path) === recovery.safetyBackupSha256) ?? null
    : safetyPaths[0] ?? null;
  const missingOriginalsCount = all(database, 'SELECT original_path FROM asset_files')
    .filter(row => !row.original_path || !existsSync(String(row.original_path))).length;
  if (phase === 'after' && (existsSync(markerPath) || existsSync(pendingPath) || existsSync(completionPath))) {
    throw new Error('Restore recovery after-snapshot requires restore application and artifact rebuild acknowledgement.');
  }
  if (phase === 'after' && (
    recovery.sourceChecksum !== backupSha256
    || !restoreRequestIdPattern.test(String(recovery.requestId ?? ''))
    || recovery.safetyBackupIntegrity !== 'ok'
    || !safetyPath
    || recovery.rebuildPassed !== true
    || Number(recovery.projectCount) <= 0
    || Number(recovery.failureCount) !== 0
  )) {
    throw new Error('Restore recovery after-snapshot requires the durable startup restore audit and safety backup.');
  }
  return {
    work: {
      identity: restoreRequestId,
      inputSha256: backupSha256,
      state: phase === 'before' ? 'STAGED' : 'SUCCEEDED',
      attempt: phase === 'before' ? 0 : 1,
      recoveredFromCheckpoint: phase === 'after' && Boolean(recoveryRow),
      completed: phase === 'after'
    },
    stage: {
      representativeData: Number(scalar(database, 'SELECT count(*) FROM projects')) > 0,
      backupSha256,
      stagedSha256,
      restoredSourceSha256: phase === 'after' ? recovery.sourceChecksum : backupSha256,
      safetyBackupSha256: safetyPath ? fileSha256(safetyPath) : null,
      safetyBackupIntegrity: safetyPath ? sqliteIntegrity(safetyPath) : 'missing',
      pendingMarker: existsSync(markerPath),
      completionMarker: existsSync(completionPath),
      artifactRebuildStatus: phase === 'after'
        && recovery.rebuildPassed === true
        && Number(recovery.missingOriginalsCount) === 0
        && missingOriginalsCount === 0
        ? 'passed'
        : 'pending',
      missingOriginalsCount
    }
  };
}

function finalizeStage(kind, before, after) {
  if (kind === 'provider') {
    const afterByKey = new Map(after.calls.map(call => [call.keySha256, call]));
    const replayed = before.calls
      .filter(call => afterByKey.get(call.keySha256)?.fingerprintSha256 !== call.fingerprintSha256);
    return {
      productionProviders: before.productionProviders && after.productionProviders,
      completedCallSha256sBefore: before.calls.map(call => call.fingerprintSha256).sort(),
      completedCallSha256sAfter: after.calls.map(call => call.fingerprintSha256).sort(),
      replayedCompletedCallSha256s: replayed.map(call => call.fingerprintSha256).sort(),
      paidCallCountBefore: before.calls.filter(call => call.costMicros > 0).length,
      paidCallCountAfter: after.calls.filter(call => call.costMicros > 0).length,
      estimatedCostMicrosBefore: before.calls.reduce((sum, call) => sum + call.costMicros, 0),
      estimatedCostMicrosAfter: after.calls.reduce((sum, call) => sum + call.costMicros, 0),
      repeatedEstimatedCostMicros: replayed.reduce((sum, call) => sum + call.costMicros, 0)
    };
  }
  if (kind === 'ingest') {
    return {
      licensedSource: before.licensedSource && after.licensedSource,
      sourceSha256: before.sourceSha256,
      checkpointPhaseBefore: before.checkpointPhase,
      checkpointPhaseAfter: after.checkpointPhase,
      assetStateBefore: before.assetState,
      assetStateAfter: after.assetState,
      sourceHashVerified: before.sourceHashVerified && after.sourceHashVerified,
      derivativesVerified: after.derivativesVerified,
      managedPartialCountAfter: after.managedPartialCount,
      unmanagedPathTouched: before.unmanagedPathTouched || after.unmanagedPathTouched
    };
  }
  if (kind === 'render') {
    return {
      licensedInputs: before.licensedInputs && after.licensedInputs,
      jobType: before.jobType,
      phaseBefore: before.phase,
      renderStateBefore: before.renderState,
      renderStateAfter: after.renderState,
      outputSha256: after.outputSha256,
      manifestSha256: after.manifestSha256,
      mediaProbePassed: after.mediaProbePassed,
      managedPartialCountAfter: after.managedPartialCount,
      unmanagedPathTouched: before.unmanagedPathTouched || after.unmanagedPathTouched
    };
  }
  if (kind === 'upload_session' || kind === 'upload_commit') {
    return {
      liveGoogleApi: before.liveGoogleApi && after.liveGoogleApi,
      oauthAuthorized: before.oauthAuthorized && after.oauthAuthorized,
      uploadSessionSha256Before: before.uploadSessionSha256,
      uploadSessionSha256After: after.uploadSessionSha256,
      videoIdSha256Before: before.videoIdSha256,
      videoIdSha256After: after.videoIdSha256,
      publicationCountBefore: before.publicationCount,
      publicationCountAfter: after.publicationCount,
      reconciliationOutcome: after.reconciliationOutcome,
      attachmentsComplete: after.attachmentsComplete,
      processingSucceeded: after.processingSucceeded
    };
  }
  return {
    representativeData: before.representativeData && after.representativeData,
    backupSha256: before.backupSha256,
    stagedSha256: before.stagedSha256,
    restoredSourceSha256: after.restoredSourceSha256,
    safetyBackupSha256: after.safetyBackupSha256,
    safetyBackupIntegrity: after.safetyBackupIntegrity,
    pendingMarkerBefore: before.pendingMarker,
    completionMarkerAfter: after.completionMarker,
    artifactRebuildStatus: after.artifactRebuildStatus,
    missingOriginalsCount: after.missingOriginalsCount
  };
}

function requireJob(database, id, allowedTypes) {
  const job = get(database, 'SELECT * FROM jobs WHERE id = ?', id);
  if (!job || !allowedTypes.includes(String(job.type))) {
    throw new Error(`Production recovery work ID must identify one of: ${allowedTypes.join(', ')}.`);
  }
  return job;
}

function assertJobPhase(job, phase) {
  if (phase === 'before' && job.state !== 'RUNNING') {
    throw new Error('Production recovery before-snapshot requires a RUNNING job.');
  }
  if (phase === 'after' && job.state !== 'SUCCEEDED') {
    throw new Error('Production recovery after-snapshot requires a SUCCEEDED job.');
  }
}

function jobWork(job) {
  return {
    identity: String(job.id),
    inputSha256: String(job.input_hash),
    state: String(job.state),
    attempt: Number(job.attempt),
    recoveredFromCheckpoint: job.state === 'SUCCEEDED' && Number(job.attempt) >= 2,
    completed: job.state === 'SUCCEEDED'
  };
}

function selectedFootageLicensed(database, projectId) {
  const rows = all(database, `
    SELECT DISTINCT scene.selected_asset_id, license.license_state, license.certificate_path,
      file.original_path, file.sha256
    FROM project_scenes scene
    LEFT JOIN project_licenses license
      ON license.project_id = scene.project_id AND license.asset_id = scene.selected_asset_id
    LEFT JOIN asset_files file ON file.id = scene.selected_file_id
    WHERE scene.project_id = ? AND scene.selected_file_id IS NOT NULL
  `, projectId);
  const hashes = new Map();
  return rows.length > 0 && rows.every(row => (
    row.selected_asset_id
    && ['CERTIFICATE_ATTACHED', 'VERIFIED'].includes(String(row.license_state))
    && row.certificate_path
    && existsSync(String(row.certificate_path))
    && row.original_path
    && existsSync(String(row.original_path))
    && /^[a-f0-9]{64}$/u.test(String(row.sha256))
    && (() => {
      const path = String(row.original_path);
      if (!hashes.has(path)) hashes.set(path, fileSha256(path));
      return hashes.get(path) === row.sha256;
    })()
  ));
}

function appSettings(database) {
  const row = get(database, "SELECT value_json FROM settings WHERE key = 'app_settings'");
  return row ? parseJson(Buffer.from(String(row.value_json)), 'Application settings') : {};
}

function assertSnapshot(value, phase) {
  const snapshot = exactRecord(value, [
    'snapshotVersion', 'evidenceKind', 'capturedAt', 'phase', 'kind', 'appVersion',
    'source', 'application', 'runtime', 'database', 'work', 'stage'
  ], `Production recovery ${phase} snapshot`);
  if (snapshot.snapshotVersion !== PRODUCTION_RECOVERY_SNAPSHOT_VERSION
    || snapshot.evidenceKind !== PRODUCTION_RECOVERY_SNAPSHOT_KIND
    || snapshot.phase !== phase) {
    throw new Error(`Production recovery ${phase} snapshot has an invalid identity.`);
  }
  return snapshot;
}

function get(database, sql, ...parameters) {
  return database.prepare(sql).get(...parameters) ?? null;
}

function all(database, sql, ...parameters) {
  return database.prepare(sql).all(...parameters);
}

function scalar(database, sql, ...parameters) {
  const row = get(database, sql, ...parameters);
  return row ? Object.values(row)[0] : null;
}

function integer(value, label) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`${label} must be a non-negative integer.`);
  return result;
}

function positiveInteger(value, label) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`${label} must be a positive integer.`);
  return result;
}

const restoreRequestIdPattern = /^(?:[a-f0-9]{64}|[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/iu;

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function requiredFile(path, label) {
  const normalized = resolve(nonEmptyString(path, label));
  if (!existsSync(normalized) || !statSync(normalized).isFile()) throw new Error(`${label} is missing: ${normalized}.`);
  return normalized;
}

function requiredMatchingHash(path, expected, label) {
  const normalized = requiredFile(path, label);
  const actual = fileSha256(normalized);
  if (actual !== expected) throw new Error(`${label} does not match its persisted SHA-256.`);
  return actual;
}

function fileSha256(path) {
  return digest(readFileSync(requiredFile(path, 'Evidence file')));
}

function sqliteIntegrity(path) {
  const database = new DatabaseSync(requiredFile(path, 'SQLite safety backup'));
  try {
    return String(scalar(database, 'PRAGMA integrity_check') ?? 'unknown');
  } finally {
    database.close();
  }
}

function probeMedia(path) {
  if (!ffprobeStatic.path || !existsSync(path)) return false;
  const result = spawnSync(ffprobeStatic.path, [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', path
  ], { encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) return false;
  try {
    return Number(JSON.parse(result.stdout).format?.duration) > 0;
  } catch {
    return false;
  }
}

function countPartialFiles(roots) {
  return roots.filter(Boolean).reduce((count, root) => count + (
    existsSync(root) ? listFiles(root).filter(path => /\.(?:tmp|part|partial)$/i.test(path)).length : 0
  ), 0);
}

function listFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  return files;
}

function pathInside(path, root) {
  if (!path || !root || !isAbsolute(path) || !isAbsolute(root)) return false;
  const fromRoot = relative(resolve(root), resolve(path));
  return fromRoot !== '' && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

function exactRecord(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} fields must be exactly: ${[...keys].sort().join(', ')}.`);
  }
  return value;
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty trimmed string.`);
  }
  return value;
}

function canonicalTimestamp(value) {
  const timestamp = value instanceof Date ? value.toISOString() : nonEmptyString(value, 'Timestamp');
  if (!Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) {
    throw new Error('Timestamp must be canonical ISO-8601.');
  }
  return timestamp;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function writeJsonAtomic(path, value) {
  const normalized = resolve(path);
  mkdirSync(dirname(normalized), { recursive: true });
  const temporary = `${normalized}.tmp`;
  rmSync(temporary, { force: true });
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporary, normalized);
}

function option(args, name, fallback = '') {
  const inline = args.find(argument => argument.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] ?? '' : fallback;
}

async function cli() {
  const args = process.argv.slice(2);
  const command = args[0];
  if (command === 'candidates') {
    const result = listProductionRecoveryCandidates({
      databasePath: option(args, 'database'),
      kind: option(args, 'kind')
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === 'capture') {
    const snapshot = captureProductionRecoverySnapshot({
      databasePath: option(args, 'database'),
      kind: option(args, 'kind'),
      workId: option(args, 'work-id'),
      phase: option(args, 'phase'),
      releaseProvenancePath: option(args, 'release-provenance'),
      appExecutablePath: option(args, 'app'),
      processId: Number(option(args, 'process-id'))
    });
    const output = option(args, 'output');
    if (output) writeJsonAtomic(output, snapshot);
    else process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    return;
  }
  if (command === 'finalize') {
    const before = parseJson(readFileSync(requiredFile(option(args, 'before'), 'Before snapshot')), 'Before snapshot');
    const after = parseJson(readFileSync(requiredFile(option(args, 'after'), 'After snapshot')), 'After snapshot');
    const processTrace = parseJson(readFileSync(requiredFile(option(args, 'process'), 'Process trace')), 'Process trace');
    const observation = finalizeProductionRecoveryObservation({ before, after, process: processTrace });
    writeJsonAtomic(nonEmptyString(option(args, 'output'), 'Observation output path'), observation);
    return;
  }
  throw new Error('Usage: production-recovery-observation.mjs candidates|capture|finalize [options].');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await cli();
}

export function productionRecoveryEnvironment(deviceClass, machineFingerprintSha256) {
  return {
    platform: platform(),
    architecture: arch(),
    release: operatingSystemRelease(),
    node: process.version,
    ci: Boolean(process.env.CI || process.env.GITHUB_ACTIONS),
    deviceClass,
    machineFingerprintSha256
  };
}
