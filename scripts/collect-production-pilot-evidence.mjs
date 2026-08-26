import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { arch, platform, release as operatingSystemRelease } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import {
  PRODUCTION_PILOT_EVIDENCE_KIND,
  PRODUCTION_PILOT_HARNESS,
  PRODUCTION_PILOT_SCHEMA_VERSION,
  assessProductionPilotEvidence
} from './production-pilot-evidence.mjs';

const PILOT_PROJECT_COUNT = 5;

export function listProductionPilotCandidates(databasePath) {
  const normalizedDatabasePath = requiredFile(databasePath, 'Production database');
  const database = new DatabaseSync(normalizedDatabasePath);
  try {
    return all(database, `
      SELECT project.id, project.title, project.destination, project.state,
        project.updated_at AS updatedAt,
        render.duration_ms AS finalDurationMs,
        publication.processing_status AS processingStatus,
        publication.scheduled_at AS scheduledAt,
        publication.approved_at AS approvedAt
      FROM projects project
      LEFT JOIN renders render ON render.id = project.final_render_id
      LEFT JOIN publication_records publication
        ON publication.project_id = project.id AND publication.snapshot_status = 'current'
      WHERE project.state IN (
        'WAITING_FINAL_APPROVAL', 'SCHEDULED', 'PUBLISHED',
        'ANALYTICS_ACTIVE', 'AWAITING_MANUAL_STUDIO_ACTION'
      )
      ORDER BY project.updated_at DESC, project.id
      LIMIT 100
    `).map(row => ({
      id: String(row.id),
      title: String(row.title),
      destination: row.destination === null ? null : String(row.destination),
      state: String(row.state),
      updatedAt: String(row.updatedAt),
      finalDurationMs: row.finalDurationMs === null ? null : number(row.finalDurationMs),
      processingStatus: row.processingStatus === null ? null : String(row.processingStatus),
      scheduledAt: row.scheduledAt === null ? null : String(row.scheduledAt),
      approvedAt: row.approvedAt === null ? null : String(row.approvedAt)
    }));
  } finally {
    database.close();
  }
}

export async function collectProductionPilotEvidence({
  root = process.cwd(),
  databasePath,
  projectIds,
  mode = 'supporting',
  deviceClass = null,
  source,
  appVersion,
  now = new Date(),
  environment = defaultEnvironment(deviceClass),
  probeMedia
} = {}) {
  const normalizedRoot = resolve(root);
  const normalizedDatabasePath = requiredFile(databasePath, 'Production database');
  const selectedProjectIds = exactProjectIds(projectIds);
  if (!['supporting', 'qualification'].includes(mode)) {
    throw new Error('Production pilot mode must be supporting or qualification.');
  }
  if (!source || typeof source !== 'object') throw new Error('Production pilot source identity is required.');
  if (typeof appVersion !== 'string' || !appVersion.trim()) throw new Error('Production pilot app version is required.');
  if (typeof probeMedia !== 'function') {
    throw new Error('Production pilot collection requires an independent media probe function.');
  }

  const generatedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const database = new DatabaseSync(normalizedDatabasePath);
  let locked = false;
  try {
    database.exec('PRAGMA busy_timeout = 5000');
    checkpoint(database);
    database.exec('BEGIN IMMEDIATE');
    locked = true;

    const integrity = String(scalar(database, 'PRAGMA integrity_check') ?? 'unknown');
    const schemaVersion = number(scalar(database, 'SELECT max(version) FROM schema_migrations'));
    const catalog = collectCatalog(database);
    const projects = [];
    for (const projectId of selectedProjectIds) {
      projects.push(await collectProject(database, projectId, probeMedia));
    }
    const databaseArtifact = await fileArtifact(normalizedDatabasePath);
    const runId = digest(canonicalJson({
      schemaVersion: PRODUCTION_PILOT_SCHEMA_VERSION,
      source: { commit: source.commit, tree: source.tree },
      databaseSha256: databaseArtifact.sha256,
      projectIds: selectedProjectIds.map(identityHash).sort(),
      generatedAt
    }));
    const receipt = {
      schemaVersion: PRODUCTION_PILOT_SCHEMA_VERSION,
      evidenceKind: PRODUCTION_PILOT_EVIDENCE_KIND,
      generatedAt,
      harness: PRODUCTION_PILOT_HARNESS,
      mode,
      appVersion: appVersion.trim(),
      runId,
      source,
      environment: normalizeEnvironment(environment, deviceClass),
      database: {
        schemaVersion,
        integrity,
        artifact: databaseArtifact
      },
      catalog,
      projects
    };
    return {
      receipt,
      assessment: assessProductionPilotEvidence(receipt),
      root: normalizedRoot,
      databasePath: normalizedDatabasePath
    };
  } finally {
    if (locked) {
      try {
        database.exec('ROLLBACK');
      } catch {
        // Preserve the collection error if releasing the read snapshot also fails.
      }
    }
    database.close();
  }
}

export function probeMediaWithFfprobe(mediaPath, ffprobePath) {
  const executable = requiredFile(ffprobePath, 'FFprobe executable');
  const result = spawnSync(executable, [
    '-v', 'error',
    '-show_format',
    '-show_streams',
    '-of', 'json',
    mediaPath
  ], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(
      `FFprobe could not inspect ${mediaPath}: ${result.stderr?.trim() || result.error?.message || `exit ${result.status}`}`
    );
  }
  let document;
  try {
    document = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`FFprobe returned invalid JSON for ${mediaPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const streams = Array.isArray(document.streams) ? document.streams : [];
  const video = streams.find(stream => stream?.codec_type === 'video');
  const audio = streams.find(stream => stream?.codec_type === 'audio');
  if (!video || !audio) throw new Error(`Qualified final media must contain video and audio streams: ${mediaPath}`);
  const durationSeconds = Number(document.format?.duration ?? video.duration);
  const frameRate = rational(video.r_frame_rate ?? video.avg_frame_rate, 'FFprobe frame rate');
  return {
    durationMs: Math.round(durationSeconds * 1_000),
    width: number(video.width),
    height: number(video.height),
    frameRate,
    videoCodec: String(video.codec_name ?? ''),
    audioCodec: String(audio.codec_name ?? '')
  };
}

async function collectProject(database, projectId, probeMedia) {
  const project = get(database, `
    SELECT id, destination_key, state, created_at, updated_at,
      script_version_id, final_render_id, youtube_video_id
    FROM projects WHERE id = ?
  `, projectId);
  if (!project) throw new Error(`Production pilot project does not exist: ${projectId}`);
  const destinationKey = string(project.destination_key, `Project ${projectId} destination key`);
  const schedulerRows = all(database, `
    SELECT trigger, outcome, reason_code, created_at
    FROM scheduler_runs
    WHERE project_id = ? AND outcome = 'created'
    ORDER BY created_at, id
  `, projectId);
  const scheduler = {
    createdRunCount: schedulerRows.length,
    triggers: [...new Set(schedulerRows.map(row => String(row.trigger)))].sort(),
    projectionSha256: digest(canonicalJson(schedulerRows))
  };

  const researchRows = all(database, `
    SELECT id, url, content_hash FROM research_sources
    WHERE project_id = ? AND status = 'active'
    ORDER BY id
  `, projectId);
  const qualifiedResearchSourceIds = new Set(researchRows.filter(row => (
    isHttpUrl(row.url) && /^[a-f0-9]{64}$/.test(String(row.content_hash ?? '').toLowerCase())
  )).map(row => String(row.id)));
  const acceptedMaterialClaims = all(database, `
    SELECT id FROM fact_claims
    WHERE project_id = ? AND material = 1 AND status = 'accepted'
      AND category <> 'visual_observation'
    ORDER BY id
  `, projectId);
  const claimIdsWithQualifiedSupport = new Set(all(database, `
    SELECT citation.claim_id, citation.source_id
    FROM fact_claim_sources citation
    JOIN fact_claims claim ON claim.id = citation.claim_id
    WHERE claim.project_id = ? AND claim.material = 1 AND claim.status = 'accepted'
      AND claim.category <> 'visual_observation'
      AND citation.support_type = 'supports'
    ORDER BY citation.claim_id, citation.source_id
  `, projectId).filter(row => qualifiedResearchSourceIds.has(String(row.source_id)))
    .map(row => String(row.claim_id)));
  const activeHttpSourceCount = qualifiedResearchSourceIds.size;
  const acceptedMaterialClaimCount = acceptedMaterialClaims.length;
  const citedAcceptedMaterialClaimCount = acceptedMaterialClaims.filter(row => (
    claimIdsWithQualifiedSupport.has(String(row.id))
  )).length;
  const successfulTavilyCallCount = successfulProviderCalls(
    database,
    projectId,
    'tavily',
    ['research_search', 'research_extract']
  );
  const successfulLanguageCallCount = successfulProviderCalls(
    database,
    projectId,
    'openai_compatible',
    ['finalize_script']
  );
  const finalScript = get(database, `
    SELECT provider, locked, script_type
    FROM script_versions WHERE id = ? AND project_id = ?
  `, project.script_version_id, projectId);
  const research = {
    activeHttpSourceCount,
    acceptedMaterialClaimCount,
    citedAcceptedMaterialClaimCount,
    successfulTavilyCallCount,
    successfulLanguageCallCount,
    finalScriptProvider: String(finalScript?.provider ?? 'missing'),
    finalScriptLocked: Boolean(finalScript?.locked) && finalScript?.script_type === 'final'
  };

  const acquisitionRows = all(database, `
    SELECT item.id, item.asset_id, item.state, item.license_state,
      item.mapped_file_id, asset.local_file_id, asset.provider, asset.canonical_page_url,
      license.certificate_path, license.license_state AS project_license_state,
      file.id AS file_id, file.original_path, file.sha256 AS stored_sha256,
      file.file_size_bytes AS stored_size_bytes
    FROM acquisition_items item
    JOIN assets asset ON asset.id = item.asset_id
    LEFT JOIN project_licenses license
      ON license.project_id = item.project_id AND license.asset_id = item.asset_id
    LEFT JOIN asset_files file ON file.id = coalesce(item.mapped_file_id, asset.local_file_id)
    WHERE item.project_id = ? AND item.state <> 'SKIPPED'
    ORDER BY item.ordinal, item.id
  `, projectId);
  const sceneRows = all(database, `
    SELECT id, verification_state, selected_asset_id, selected_file_id
    FROM project_scenes WHERE project_id = ? ORDER BY ordinal, id
  `, projectId);
  const selectedFootage = sceneRows.filter(row => row.selected_file_id !== null);
  const verificationKeys = new Set(all(database, `
    SELECT scene_id, asset_id, asset_file_id, status FROM (
      SELECT scene_id, asset_id, asset_file_id, status,
        row_number() OVER (
          PARTITION BY scene_id, asset_file_id
          ORDER BY created_at DESC, id DESC
        ) AS recency
      FROM footage_verifications
      WHERE project_id = ?
    ) latest
    WHERE recency = 1
    ORDER BY scene_id, asset_file_id
  `, projectId).filter(row => row.status === 'verified')
    .map(row => `${row.scene_id}\n${row.asset_id}\n${row.asset_file_id}`));
  const acquisitionByAsset = new Map(acquisitionRows.map(row => [String(row.asset_id), row]));
  const selectedByAsset = new Map();
  for (const scene of selectedFootage) {
    const assetId = string(scene.selected_asset_id, `Project ${projectId} selected scene asset`);
    const fileId = string(scene.selected_file_id, `Project ${projectId} selected scene file`);
    const priorFileId = selectedByAsset.get(assetId);
    if (priorFileId && priorFileId !== fileId) {
      throw new Error(`Project ${projectId} selects multiple physical files for asset ${assetId}.`);
    }
    if (!acquisitionByAsset.has(assetId)) {
      throw new Error(`Project ${projectId} selected asset ${assetId} has no completed acquisition evidence.`);
    }
    selectedByAsset.set(assetId, fileId);
  }
  const certificateArtifacts = [];
  const sourceArtifacts = [];
  for (const [assetId, fileId] of selectedByAsset) {
    const row = acquisitionByAsset.get(assetId);
    const certificatePath = requiredFile(
      row.certificate_path,
      `Project ${projectId} license certificate for asset ${assetId}`
    );
    if (!['CERTIFICATE_ATTACHED', 'VERIFIED'].includes(String(row.project_license_state))) {
      throw new Error(`Project ${projectId} asset ${assetId} does not have a certificate-backed license.`);
    }
    const selectedFile = get(database, `
      SELECT original_path, sha256 AS stored_sha256, file_size_bytes AS stored_size_bytes
      FROM asset_files WHERE id = ? AND asset_id = ?
    `, fileId, assetId);
    if (!selectedFile) {
      throw new Error(`Project ${projectId} selected file is not bound to asset ${assetId}.`);
    }
    const sourcePath = requiredFile(
      selectedFile.original_path,
      `Project ${projectId} source media for asset ${assetId}`
    );
    const sourceArtifact = await fileArtifact(sourcePath);
    if (
      sourceArtifact.sha256 !== selectedFile.stored_sha256
      || sourceArtifact.sizeBytes !== number(selectedFile.stored_size_bytes)
    ) {
      throw new Error(`Project ${projectId} source media no longer matches its persisted bytes for asset ${assetId}.`);
    }
    certificateArtifacts.push({ keyHash: identityHash(assetId), ...await fileArtifact(certificatePath) });
    sourceArtifacts.push({ keyHash: identityHash(assetId), ...sourceArtifact });
  }
  const acquisition = {
    activeItemCount: acquisitionRows.length,
    completedItemCount: acquisitionRows.filter(row => (
      row.state === 'COMPLETE'
      && row.license_state === row.project_license_state
      && ['CERTIFICATE_ATTACHED', 'VERIFIED'].includes(String(row.project_license_state))
    )).length,
    envatoItemCount: acquisitionRows.filter(row => (
      row.provider === 'envato' && isEnvatoUrl(row.canonical_page_url)
    )).length,
    selectedFootageSceneCount: selectedFootage.length,
    verifiedFootageSceneCount: selectedFootage.filter(row => (
      row.verification_state === 'verified'
      && verificationKeys.has(`${row.id}\n${row.selected_asset_id}\n${row.selected_file_id}`)
    )).length,
    graphicSceneCount: sceneRows.filter(row => row.verification_state === 'graphic').length,
    sceneCount: sceneRows.length,
    licensedAssetCount: selectedByAsset.size,
    certificateArtifacts,
    sourceArtifacts
  };

  const narrationRows = all(database, `
    SELECT section.id, section.status, voice.provider, voice.timing_method,
      voice.audio_path, voice.input_hash
    FROM narration_sections section
    JOIN voice_assets voice
      ON voice.id = section.voice_asset_id AND voice.project_id = section.project_id
    WHERE section.project_id = ? AND section.script_version_id = ?
    ORDER BY section.ordinal, section.id
  `, projectId, project.script_version_id);
  const narrationProviders = [...new Set(narrationRows.map(row => String(row.provider)))];
  const successfulHttpTtsInputs = new Set(all(database, `
    SELECT input_hash FROM provider_calls
    WHERE project_id = ? AND provider = 'http_tts' AND operation = 'synthesize_section'
      AND error IS NULL AND output_hash IS NOT NULL AND response_json IS NOT NULL
    ORDER BY input_hash
  `, projectId).map(row => String(row.input_hash)));
  const audioArtifacts = [];
  for (const row of narrationRows) {
    audioArtifacts.push({
      keyHash: identityHash(string(row.id, `Project ${projectId} narration section`)),
      ...await fileArtifact(requiredFile(row.audio_path, `Project ${projectId} narration audio`))
    });
  }
  const narration = {
    provider: narrationProviders.length === 1 ? narrationProviders[0] : 'mixed_or_missing',
    sectionCount: narrationRows.length,
    readySectionCount: narrationRows.filter(row => row.status === 'ready').length,
    providerReceiptCount: narrationRows.filter(row => (
      row.provider === 'windows_sapi'
      || (row.provider === 'http_tts' && successfulHttpTtsInputs.has(String(row.input_hash)))
    )).length,
    timingMethods: [...new Set(narrationRows.map(row => String(row.timing_method)))].sort(),
    audioArtifacts
  };

  const renderRow = get(database, `
    SELECT render.id, render.kind, render.state, render.output_path,
      render.sha256, render.manifest_path,
      manifest.manifest_json, manifest.manifest_hash
    FROM renders render
    JOIN render_manifests manifest ON manifest.id = render.manifest_id
    WHERE render.id = ? AND render.project_id = ?
  `, project.final_render_id, projectId);
  if (!renderRow) throw new Error(`Project ${projectId} does not have an active final render and manifest.`);
  const outputPath = requiredFile(renderRow.output_path, `Project ${projectId} final render`);
  const renderArtifact = await fileArtifact(outputPath);
  if (renderArtifact.sha256 !== renderRow.sha256) {
    throw new Error(`Project ${projectId} final render no longer matches its persisted SHA-256.`);
  }
  const manifestPath = requiredFile(renderRow.manifest_path, `Project ${projectId} render manifest`);
  const manifestBytes = stableReadFile(manifestPath, `Project ${projectId} render manifest`);
  const manifestDocument = parseJson(manifestBytes, `Project ${projectId} render manifest`);
  const persistedManifest = parseJson(
    Buffer.from(String(renderRow.manifest_json), 'utf8'),
    `Project ${projectId} persisted render manifest`
  );
  const manifestContentSha256 = digest(JSON.stringify(manifestDocument));
  if (JSON.stringify(manifestDocument) !== JSON.stringify(persistedManifest)
    || manifestContentSha256 !== renderRow.manifest_hash) {
    throw new Error(`Project ${projectId} render manifest no longer matches its persisted content.`);
  }
  const captions = record(manifestDocument.captions, `Project ${projectId} render captions`);
  const captionArtifacts = [];
  for (const [kind, path] of [['srt', captions.srtPath], ['vtt', captions.vttPath]]) {
    captionArtifacts.push({
      keyHash: identityHash(kind),
      ...await fileArtifact(requiredFile(path, `Project ${projectId} ${kind.toUpperCase()} caption`))
    });
  }
  const render = {
    renderIdHash: identityHash(String(renderRow.id)),
    kind: String(renderRow.kind),
    state: String(renderRow.state),
    storedSha256: String(renderRow.sha256),
    artifact: renderArtifact,
    storedManifestSha256: String(renderRow.manifest_hash),
    manifestArtifact: {
      sha256: digest(manifestBytes),
      sizeBytes: manifestBytes.length,
      contentSha256: manifestContentSha256
    },
    captionArtifacts,
    probe: await probeMedia(outputPath)
  };

  const qcRow = get(database, `
    SELECT count(*) AS result_count,
      sum(CASE WHEN lower(status) = 'pass' THEN 1 ELSE 0 END) AS passed_count,
      sum(CASE WHEN lower(status) = 'fail' THEN 1 ELSE 0 END) AS failed_count,
      sum(CASE WHEN lower(status) = 'fail' AND upper(severity) IN ('BLOCKER','HIGH') THEN 1 ELSE 0 END)
        AS failed_blocker_high_count
    FROM qc_results WHERE project_id = ? AND render_id = ?
  `, projectId, project.final_render_id);
  const qc = {
    resultCount: number(qcRow?.result_count),
    passedCount: number(qcRow?.passed_count),
    failedCount: number(qcRow?.failed_count),
    failedBlockerHighCount: number(qcRow?.failed_blocker_high_count)
  };

  const publicationRows = all(database, `
    SELECT * FROM publication_records WHERE project_id = ? ORDER BY created_at, id
  `, projectId);
  const currentRows = publicationRows.filter(row => row.snapshot_status === 'current');
  const publicationRow = currentRows[0];
  if (!publicationRow?.video_id || !publicationRow.channel_id) {
    throw new Error(`Project ${projectId} does not have a current channel-bound remote publication.`);
  }
  if (
    publicationRow.final_render_id !== renderRow.id
    || publicationRow.final_sha256 !== renderArtifact.sha256
    || publicationRow.video_id !== project.youtube_video_id
  ) {
    throw new Error(`Project ${projectId} current publication does not match its exact active final identity.`);
  }
  const binding = get(database, `
    SELECT channel_id, confirmed_at FROM youtube_connection_binding WHERE singleton_id = 1
  `);
  const packageRow = get(database, `
    SELECT id, selected, thumbnail_path FROM packaging_candidates
    WHERE id = ? AND project_id = ?
  `, publicationRow.selected_package_id, projectId);
  if (!packageRow) throw new Error(`Project ${projectId} publication has no selected packaging candidate.`);
  const auditRows = all(database, `
    SELECT id, action, actor, entity_type, entity_id,
      before_json, after_json, metadata_json, created_at
    FROM audit_log WHERE project_id = ? ORDER BY id
  `, projectId);
  const requestedScheduleFallback = auditRows.some(row => {
    if (row.action !== 'youtube.studio_fallback') return false;
    try {
      return JSON.parse(String(row.metadata_json ?? '{}')).requestedAction === 'schedule';
    } catch {
      return false;
    }
  });
  const publication = {
    recordCount: publicationRows.length,
    currentRecordCount: currentRows.length,
    remoteVideoCount: new Set(publicationRows.map(row => row.video_id).filter(Boolean)).size,
    videoIdHash: identityHash(String(publicationRow.video_id)),
    channelIdHash: identityHash(String(publicationRow.channel_id)),
    channelBindingConfirmed: binding?.channel_id === publicationRow.channel_id && Boolean(binding.confirmed_at),
    privacyStatus: String(publicationRow.privacy_status),
    processingStatus: String(publicationRow.processing_status ?? 'missing'),
    snapshotStatus: String(publicationRow.snapshot_status),
    captionPresent: Boolean(publicationRow.caption_id),
    thumbnailUploaded: Boolean(publicationRow.thumbnail_uploaded),
    packageSelected: Boolean(packageRow.selected),
    approvalHashPresent: Boolean(publicationRow.approval_hash),
    approvedAt: nullableString(publicationRow.approved_at),
    scheduledAt: nullableString(publicationRow.scheduled_at),
    publishedAt: nullableString(publicationRow.published_at),
    requestedScheduleFallback,
    thumbnailArtifact: await fileArtifact(requiredFile(
      packageRow.thumbnail_path,
      `Project ${projectId} selected thumbnail`
    ))
  };

  const exceptions = {
    openBlockerHighCount: number(scalar(database, `
      SELECT count(*) FROM exceptions
      WHERE project_id = ? AND status = 'OPEN' AND upper(severity) IN ('BLOCKER','HIGH')
    `, projectId))
  };
  const audit = {
    entryCount: auditRows.length,
    projectionSha256: digest(canonicalJson(auditRows)),
    operatorActions: auditRows
      .filter(row => ['operator', 'human'].includes(String(row.actor).toLowerCase()))
      .map(row => String(row.action))
  };

  return {
    projectIdHash: identityHash(projectId),
    destinationKeyHash: identityHash(destinationKey),
    state: String(project.state),
    createdAt: String(project.created_at),
    updatedAt: String(project.updated_at),
    scheduler,
    research,
    acquisition,
    narration,
    render,
    qc,
    publication,
    exceptions,
    audit
  };
}

function collectCatalog(database) {
  const imports = all(database, `
    SELECT source_sha256, row_count FROM catalog_imports
    WHERE completed_at IS NOT NULL ORDER BY completed_at, id
  `);
  return {
    assetCount: number(scalar(database, 'SELECT count(*) FROM assets')),
    completedImportCount: imports.length,
    largestCompletedImportRows: Math.max(0, ...imports.map(row => number(row.row_count))),
    sourceSha256s: [...new Set(imports
      .map(row => String(row.source_sha256 ?? '').toLowerCase())
      .filter(value => /^[a-f0-9]{64}$/.test(value)))].sort()
  };
}

function successfulProviderCalls(database, projectId, provider, operations) {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new Error(`Provider ${provider} must have at least one qualifying operation.`);
  }
  return number(scalar(database, `
    SELECT count(*) FROM provider_calls
    WHERE project_id = ? AND provider = ? AND error IS NULL
      AND operation IN (${operations.map(() => '?').join(', ')})
      AND output_hash IS NOT NULL AND response_json IS NOT NULL
  `, projectId, provider, ...operations));
}

function checkpoint(database) {
  const rows = database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all();
  const row = rows[0] ?? {};
  if (number(row.busy) !== 0 || number(row.log) !== number(row.checkpointed)) {
    throw new Error('Production database could not be fully checkpointed; close every app instance and retry.');
  }
}

async function fileArtifact(path) {
  const normalized = requiredFile(path, 'Evidence artifact');
  const before = statSync(normalized);
  const sha256 = await sha256File(normalized);
  const after = statSync(normalized);
  assertStableFile(before, after, normalized);
  return {
    sha256,
    sizeBytes: after.size
  };
}

function stableReadFile(path, label) {
  const before = statSync(path);
  const bytes = readFileSync(path);
  const after = statSync(path);
  assertStableFile(before, after, label);
  return bytes;
}

function assertStableFile(before, after, label) {
  if (
    before.size !== after.size
    || before.mtimeMs !== after.mtimeMs
    || before.ctimeMs !== after.ctimeMs
  ) {
    throw new Error(`${label} changed while qualification evidence was being collected.`);
  }
}

async function sha256File(path) {
  const hash = createHash('sha256');
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolvePromise);
  });
  return hash.digest('hex');
}

function defaultEnvironment(deviceClass) {
  return {
    platform: platform(),
    release: operatingSystemRelease(),
    architecture: arch(),
    node: process.versions.node,
    ci: Boolean(process.env.CI || process.env.GITHUB_ACTIONS),
    deviceClass
  };
}

function normalizeEnvironment(value, deviceClass) {
  const environment = record(value, 'Production pilot environment');
  return {
    platform: string(environment.platform, 'environment platform'),
    release: string(environment.release, 'environment release'),
    architecture: string(environment.architecture, 'environment architecture'),
    node: string(environment.node, 'environment node'),
    ci: Boolean(environment.ci),
    deviceClass: deviceClass ?? nullableString(environment.deviceClass)
  };
}

function exactProjectIds(value) {
  if (!Array.isArray(value) || value.length !== PILOT_PROJECT_COUNT) {
    throw new Error(`Production pilot collection requires exactly ${PILOT_PROJECT_COUNT} project IDs.`);
  }
  const ids = value.map((entry, index) => string(entry, `projectIds[${index}]`));
  if (new Set(ids).size !== ids.length) throw new Error('Production pilot project IDs must be distinct.');
  return ids;
}

function requiredFile(value, label) {
  const path = string(value, `${label} path`);
  const normalized = isAbsolute(path) ? path : resolve(path);
  if (!existsSync(normalized) || !statSync(normalized).isFile()) {
    throw new Error(`${label} does not exist or is not a regular file: ${normalized}`);
  }
  return normalized;
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(String(value));
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function isEnvatoUrl(value) {
  try {
    const parsed = new URL(String(value));
    return parsed.protocol === 'https:'
      && (parsed.hostname === 'elements.envato.com' || parsed.hostname.endsWith('.elements.envato.com'));
  } catch {
    return false;
  }
}

function rational(value, label) {
  const match = String(value ?? '').match(/^(-?\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/);
  if (!match) throw new Error(`${label} is invalid.`);
  const numerator = Number(match[1]);
  const denominator = Number(match[2] ?? 1);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    throw new Error(`${label} is invalid.`);
  }
  return numerator / denominator;
}

function get(database, sql, ...parameters) {
  return database.prepare(sql).get(...parameters);
}

function all(database, sql, ...parameters) {
  return database.prepare(sql).all(...parameters);
}

function scalar(database, sql, ...parameters) {
  const row = get(database, sql, ...parameters);
  return row ? Object.values(row)[0] : null;
}

function number(value) {
  const result = Number(value ?? 0);
  if (!Number.isFinite(result)) throw new Error(`Expected a finite numeric database value, received ${String(value)}.`);
  return result;
}

function string(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty trimmed string.`);
  }
  return value;
}

function nullableString(value) {
  return value === null || value === undefined ? null : String(value);
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
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

function identityHash(value) {
  return digest(`videofactory-production-pilot:v1:${value}`);
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, sortValue(entry)]));
}
