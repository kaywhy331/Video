import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '../database/database';
import type {
  AppSettings,
  AnalyticsSnapshot,
  AuditLogEntry,
  CoverageCluster,
  CreateAutopilotProjectRequest,
  DerivativeRebuildReport,
  NarrationSection,
  PackagingCandidate,
  ProjectDetail,
  ProjectExportReport,
  ProjectGuidance,
  ProjectFactClaim,
  ProjectLicenseDetail,
  ProjectPublicationDetail,
  ProjectResearchSource,
  ProjectScene,
  ProjectScriptVersion,
  ProjectSummary,
  QcResult,
  RenderRecord
} from '@shared/types';
import { slugify } from '@shared/normalization';
import type { CatalogService } from './catalog-service';
import type { AiService } from './ai-service';
import { MatchingService } from './matching-service';
import { ProjectStateService } from './project-state-service';
import { assertPlanningCapacity, evaluateCoverage } from './planning-policy';
import { RepairService } from './repair-service';
import { shouldAcquireAlternate } from '@shared/repair-policy';
import type { PlaceService } from './place-service';
import type { ResearchService } from './research-service';
import type { VisionService } from './vision-service';
import { evaluateClaims, type EvaluatedClaim } from '@shared/research';
import { createHash } from 'node:crypto';
import { outputDimensions } from '@shared/output-profile';
import { canTransitionProject } from '@shared/state-machine';
import { buildAcquisitionManifest } from '@shared/acquisition-manifest';

interface GuidedTopicCandidate {
  id: string;
  destinationKey: string;
  title: string;
  destination: string;
  feasibility: string;
}

export function resolveAutopilotGuidance(
  coverage: CoverageCluster[],
  request: Pick<CreateAutopilotProjectRequest, 'destinationKey' | 'topicId'>,
  orientation: 'landscape' | 'portrait' | 'square',
  topic?: GuidedTopicCandidate
): { cluster: CoverageCluster; destination: string; title: string } {
  if (!coverage.length) throw new Error('Import a footage catalog before starting Autopilot.');
  if (request.topicId && (!topic || topic.id !== request.topicId)) {
    throw new Error('The requested topic candidate does not exist.');
  }
  if (topic && topic.feasibility !== 'qualified') {
    throw new Error('The requested topic candidate is not production-qualified.');
  }
  if (request.destinationKey && topic && request.destinationKey !== topic.destinationKey) {
    throw new Error('The requested topic candidate does not belong to the selected destination.');
  }
  const effectiveDestinationKey = request.destinationKey ?? topic?.destinationKey;
  const requestedCluster = effectiveDestinationKey
    ? coverage.find(cluster => cluster.key === effectiveDestinationKey)
    : undefined;
  if (effectiveDestinationKey && !requestedCluster) {
    throw new Error('The requested destination is unavailable in current catalog coverage.');
  }
  const cluster = requestedCluster
    ?? coverage.find(item => item.assetCount >= 12
      && (orientation === 'portrait' ? item.portraitCount : item.landscapeCount) >= Math.max(6, item.assetCount * 0.45))
    ?? coverage[0];
  if (!cluster) throw new Error('No supportable destination cluster is available.');
  const destination = topic?.destination
    ?? cluster.locationName
    ?? cluster.city
    ?? cluster.country
    ?? 'Selected destination';
  return {
    cluster,
    destination,
    title: topic?.title ?? `A Visual Guide to ${destination}`
  };
}

function jsonArray(value: unknown): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function jsonObject(value: unknown): Record<string, string> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(String(value));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).map(([key, item]) => [key, String(item)])
    );
  } catch {
    return {};
  }
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function guidanceFromRow(row: Record<string, unknown>): ProjectGuidance {
  return {
    mode: row.mode as ProjectGuidance['mode'],
    startingScript: row.starting_script === null ? null : String(row.starting_script),
    startingScriptSha256: row.starting_script_sha256 === null ? null : String(row.starting_script_sha256),
    requestedDestinationKey: row.requested_destination_key === null ? null : String(row.requested_destination_key),
    requestedTopicId: row.requested_topic_id === null ? null : String(row.requested_topic_id),
    requestedTargetDurationMs: row.requested_target_duration_ms === null
      ? null
      : Number(row.requested_target_duration_ms),
    resolvedDestinationKey: String(row.resolved_destination_key),
    resolvedDestination: String(row.resolved_destination),
    resolvedTopicTitle: String(row.resolved_topic_title),
    resolvedTargetDurationMs: Number(row.resolved_target_duration_ms),
    constraints: jsonRecord(row.constraints_json),
    createdAt: String(row.created_at)
  };
}

function projectSummary(row: Record<string, unknown>): ProjectSummary {
  let outputProfileKey: ProjectSummary['outputProfileKey'] = 'landscape_1080p';
  if (row.output_profile_snapshot_json) {
    try {
      const snapshot = JSON.parse(String(row.output_profile_snapshot_json)) as { profileKey?: ProjectSummary['outputProfileKey'] };
      outputProfileKey = snapshot.profileKey ?? outputProfileKey;
    } catch {
      // Legacy or corrupt snapshots stay on the safe default profile.
    }
  }
  return {
    id: String(row.id),
    sequence: Number(row.sequence),
    slug: String(row.slug),
    title: String(row.title),
    topic: String(row.topic),
    destination: row.destination ? String(row.destination) : null,
    state: row.state as ProjectSummary['state'],
    progress: Number(row.progress ?? 0),
    envatoProjectName: String(row.envato_project_name),
    targetDurationMs: Number(row.target_duration_ms),
    sceneCount: Number(row.scene_count ?? 0),
    acquiredCount: Number(row.acquired_count ?? 0),
    acquisitionCount: Number(row.acquisition_count ?? 0),
    openExceptions: Number(row.open_exceptions ?? 0),
    finalRenderId: row.final_render_id ? String(row.final_render_id) : null,
    finalRenderPath: row.final_render_path ? String(row.final_render_path) : null,
    youtubeVideoId: row.youtube_video_id ? String(row.youtube_video_id) : null,
    channelId: row.channel_id ? String(row.channel_id) : null,
    languageVoiceProfileId: row.language_voice_profile_id ? String(row.language_voice_profile_id) : null,
    outputProfileKey,
    pendingLifecycleAction: row.pending_lifecycle_action === 'pause' ? 'pause' : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function sceneFromRow(row: Record<string, unknown>): ProjectScene {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    ordinal: Number(row.ordinal),
    chapter: row.chapter ? String(row.chapter) : null,
    narration: String(row.narration),
    targetDurationMs: Number(row.target_duration_ms),
    requiredCountry: row.required_country ? String(row.required_country) : null,
    requiredCity: row.required_city ? String(row.required_city) : null,
    requiredLocation: row.required_location ? String(row.required_location) : null,
    requiredPlaceId: row.required_place_id ? String(row.required_place_id) : null,
    requiredGranularity: row.required_granularity as ProjectScene['requiredGranularity'],
    requiredObjects: jsonArray(row.required_objects_json),
    requiredActivities: jsonArray(row.required_activities_json),
    preferredShots: jsonArray(row.preferred_shots_json),
    visualTreatment: row.visual_treatment as ProjectScene['visualTreatment'],
    selectedAssetId: row.selected_asset_id ? String(row.selected_asset_id) : null,
    selectedFileId: row.selected_file_id ? String(row.selected_file_id) : null,
    selectedSegmentId: row.selected_segment_id ? String(row.selected_segment_id) : null,
    score: row.score === null || row.score === undefined ? null : Number(row.score),
    scoreExplanation: jsonArray(row.score_explanation_json),
    verificationState: row.verification_state as ProjectScene['verificationState'],
    pronunciation: jsonObject(row.pronunciation_json),
    startMs: row.start_ms === null || row.start_ms === undefined ? null : Number(row.start_ms),
    endMs: row.end_ms === null || row.end_ms === undefined ? null : Number(row.end_ms)
  };
}

export class ProjectService {
  private readonly matcher = new MatchingService();
  readonly states: ProjectStateService;
  readonly repairs: RepairService;

  constructor(
    private readonly db: AppDatabase,
    private readonly catalog: CatalogService,
    private readonly ai: AiService,
    private readonly settings: () => AppSettings,
    private readonly places: PlaceService,
    private readonly research?: ResearchService,
    private readonly vision?: VisionService
  ) {
    this.states = new ProjectStateService(db);
    this.repairs = new RepairService(db);
  }

  list(): ProjectSummary[] {
    const rows = this.db.raw.prepare(`
      SELECT p.*,
        (SELECT count(*) FROM project_scenes s WHERE s.project_id = p.id) AS scene_count,
        (SELECT count(*) FROM acquisition_items a WHERE a.project_id = p.id) AS acquisition_count,
        (SELECT count(*) FROM acquisition_items a WHERE a.project_id = p.id AND a.state = 'COMPLETE') AS acquired_count,
        (SELECT count(*) FROM exceptions e WHERE e.project_id = p.id AND e.status = 'OPEN') AS open_exceptions,
        (SELECT output_path FROM renders r WHERE r.id = p.final_render_id) AS final_render_path
      FROM projects p
      ORDER BY p.updated_at DESC
    `).all() as Array<Record<string, unknown>>;
    return rows.map(projectSummary);
  }

  get(projectId: string): ProjectDetail {
    const row = this.db.raw.prepare(`
      SELECT p.*,
        (SELECT count(*) FROM project_scenes s WHERE s.project_id = p.id) AS scene_count,
        (SELECT count(*) FROM acquisition_items a WHERE a.project_id = p.id) AS acquisition_count,
        (SELECT count(*) FROM acquisition_items a WHERE a.project_id = p.id AND a.state = 'COMPLETE') AS acquired_count,
        (SELECT count(*) FROM exceptions e WHERE e.project_id = p.id AND e.status = 'OPEN') AS open_exceptions,
        (SELECT output_path FROM renders r WHERE r.id = p.final_render_id) AS final_render_path
      FROM projects p WHERE p.id = ?
    `).get(projectId) as Record<string, unknown> | undefined;
    if (!row) throw new Error('Project not found.');

    const scenes = (this.db.raw.prepare(`
      SELECT * FROM project_scenes WHERE project_id = ? ORDER BY ordinal
    `).all(projectId) as Array<Record<string, unknown>>).map(sceneFromRow);

    const acquisitions = (this.db.raw.prepare(`
      SELECT a.*, x.title AS asset_title, x.thumbnail_url
      FROM acquisition_items a
      JOIN assets x ON x.id = a.asset_id
      WHERE a.project_id = ?
      ORDER BY a.ordinal
    `).all(projectId) as Array<Record<string, unknown>>).map(row => ({
      id: String(row.id),
      projectId: String(row.project_id),
      assetId: String(row.asset_id),
      ordinal: Number(row.ordinal),
      role: row.role as 'primary' | 'alternate' | 'hero' | 'license_only',
      state: row.state as import('@shared/types').AcquisitionState,
      licenseState: row.license_state as import('@shared/types').LicenseState,
      sourceUrl: String(row.source_url),
      assetTitle: String(row.asset_title),
      thumbnailUrl: row.thumbnail_url ? String(row.thumbnail_url) : null,
      requiredForScenes: jsonArray(row.required_scene_ordinals_json).map(Number),
      matchScore: Number(row.match_score),
      reasons: jsonArray(row.reasons_json),
      activeAt: row.active_at ? String(row.active_at) : null,
      detectedPath: row.detected_path ? String(row.detected_path) : null,
      mappedFileId: row.mapped_file_id ? String(row.mapped_file_id) : null,
      mappingConfidence: row.mapping_confidence === null || row.mapping_confidence === undefined ? null : Number(row.mapping_confidence),
      error: row.error ? String(row.error) : null
    }));

    const renders = (this.db.raw.prepare(`
      SELECT * FROM renders WHERE project_id = ? ORDER BY created_at DESC
    `).all(projectId) as Array<Record<string, unknown>>).map(row => ({
      id: String(row.id),
      projectId: String(row.project_id),
      kind: row.kind as RenderRecord['kind'],
      profile: row.profile as RenderRecord['profile'],
      state: row.state as RenderRecord['state'],
      manifestPath: row.manifest_path ? String(row.manifest_path) : null,
      outputPath: row.output_path ? String(row.output_path) : null,
      sha256: row.sha256 ? String(row.sha256) : null,
      durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
      width: row.width === null || row.width === undefined ? null : Number(row.width),
      height: row.height === null || row.height === undefined ? null : Number(row.height),
      error: row.error ? String(row.error) : null,
      createdAt: String(row.created_at),
      completedAt: row.completed_at ? String(row.completed_at) : null,
      artifactVersion: Number(row.artifact_version ?? 1),
      scope: row.scope_json && String(row.scope_json) !== '{}'
        ? JSON.parse(String(row.scope_json)) as RenderRecord['scope']
        : null,
      baseRenderId: row.base_render_id ? String(row.base_render_id) : null
    }));

    const packaging = (this.db.raw.prepare(`
      SELECT * FROM packaging_candidates WHERE project_id = ? ORDER BY ordinal
    `).all(projectId) as Array<Record<string, unknown>>).map(row => ({
      id: String(row.id),
      projectId: String(row.project_id),
      ordinal: Number(row.ordinal),
      title: String(row.title),
      angle: String(row.angle),
      viewerPromise: String(row.viewer_promise),
      thumbnailPath: row.thumbnail_path ? String(row.thumbnail_path) : null,
      thumbnailFrameMs: row.thumbnail_frame_ms === null || row.thumbnail_frame_ms === undefined
        ? null : Number(row.thumbnail_frame_ms),
      description: String(row.description),
      chapters: String(row.chapters),
      tags: jsonArray(row.tags_json),
      riskStatus: row.risk_status as PackagingCandidate['riskStatus'],
      selected: Boolean(row.selected)
    }));

    const qc = (this.db.raw.prepare(`
      SELECT * FROM qc_results WHERE project_id = ? ORDER BY created_at DESC
    `).all(projectId) as Array<Record<string, unknown>>).map(row => ({
      id: String(row.id),
      projectId: String(row.project_id),
      renderId: row.render_id ? String(row.render_id) : null,
      category: row.category as QcResult['category'],
      code: String(row.code),
      severity: row.severity as QcResult['severity'],
      status: row.status as QcResult['status'],
      message: String(row.message),
      evidence: JSON.parse(String(row.evidence_json ?? '{}')) as Record<string, unknown>,
      repairClass: row.repair_class ? row.repair_class as QcResult['repairClass'] : null,
      repairAttempted: Boolean(row.repair_attempted),
      repairAction: row.repair_action ? String(row.repair_action) : null,
      createdAt: String(row.created_at)
    }));

    const narrationSections = (this.db.raw.prepare(`
      SELECT n.*, v.audio_path, v.timing_path, v.timing_method
      FROM narration_sections n
      JOIN voice_assets v ON v.id = n.voice_asset_id
      JOIN projects p ON p.id = n.project_id
      WHERE n.project_id = ? AND n.script_version_id = p.script_version_id
        AND n.status = 'ready' AND v.status = 'ready'
      ORDER BY n.ordinal
    `).all(projectId) as Array<Record<string, unknown>>).map(row => ({
      id: String(row.id),
      projectId: String(row.project_id),
      scriptVersionId: String(row.script_version_id),
      ordinal: Number(row.ordinal),
      chapter: row.chapter ? String(row.chapter) : null,
      sceneIds: jsonArray(row.scene_ids_json),
      text: String(row.text),
      pronunciation: jsonObject(row.pronunciation_json),
      audioPath: String(row.audio_path),
      timingPath: row.timing_path ? String(row.timing_path) : null,
      durationMs: Number(row.duration_ms),
      timingMethod: row.timing_method as NarrationSection['timingMethod'],
      status: row.status as NarrationSection['status']
    } satisfies NarrationSection));

    const exports = (this.db.raw.prepare(`
      SELECT * FROM project_export_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT 20
    `).all(projectId) as Array<Record<string, unknown>>).map(row => ({
      id: String(row.id),
      projectId: String(row.project_id),
      exportPath: String(row.export_path),
      manifestPath: row.manifest_path ? String(row.manifest_path) : null,
      manifestSha256: row.manifest_sha256 ? String(row.manifest_sha256) : null,
      artifactCount: Number(row.artifact_count),
      totalBytes: Number(row.total_bytes),
      missingFiles: jsonArray(row.missing_files_json),
      status: row.status as ProjectExportReport['status'],
      error: row.error ? String(row.error) : null,
      createdAt: String(row.created_at),
      completedAt: row.completed_at ? String(row.completed_at) : null
    } satisfies ProjectExportReport));

    const rebuilds = (this.db.raw.prepare(`
      SELECT * FROM derivative_rebuild_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT 20
    `).all(projectId) as Array<Record<string, unknown>>).map(row => ({
      id: String(row.id),
      projectId: String(row.project_id),
      checkedOriginals: Number(row.checked_originals),
      rebuiltProxies: Number(row.rebuilt_proxies),
      rebuiltContactSheets: Number(row.rebuilt_contact_sheets),
      rebuiltVoiceTimings: Number(row.rebuilt_voice_timings),
      rebuiltEditingLayers: Number(row.rebuilt_editing_layers),
      rebuiltCaptionFiles: Number(row.rebuilt_caption_files),
      staleRenderFragments: Number(row.stale_render_fragments),
      missingOriginals: jsonArray(row.missing_originals_json),
      missingVoice: jsonArray(row.missing_voice_json),
      failures: jsonArray(row.failures_json),
      status: row.status as DerivativeRebuildReport['status'],
      error: row.error ? String(row.error) : null,
      createdAt: String(row.created_at),
      completedAt: row.completed_at ? String(row.completed_at) : null
    } satisfies DerivativeRebuildReport));
    const guidanceRow = this.db.raw.prepare(`
      SELECT * FROM project_guidance WHERE project_id = ?
    `).get(projectId) as Record<string, unknown> | undefined;
    const researchSources = (this.db.raw.prepare(`
      SELECT * FROM research_sources WHERE project_id = ? ORDER BY accessed_at DESC, id
    `).all(projectId) as Array<Record<string, unknown>>).map(source => ({
      id: String(source.id),
      url: String(source.url),
      title: String(source.title),
      publisher: source.publisher ? String(source.publisher) : null,
      sourceType: String(source.source_type ?? 'unknown'),
      summary: source.summary ? String(source.summary) : null,
      excerpt: source.excerpt ? String(source.excerpt) : null,
      contentHash: source.content_hash ? String(source.content_hash) : null,
      status: source.status as ProjectResearchSource['status'],
      publishedAt: source.published_at ? String(source.published_at) : null,
      accessedAt: String(source.accessed_at),
      freshnessDays: source.freshness_days === null || source.freshness_days === undefined
        ? null : Number(source.freshness_days),
      expiresAt: source.expires_at ? String(source.expires_at) : null
    } satisfies ProjectResearchSource));
    const claimSceneRows = this.db.raw.prepare(`
      SELECT link.claim_id, link.scene_id
      FROM project_scene_claims link
      JOIN project_scenes scene ON scene.id = link.scene_id
      WHERE scene.project_id = ?
      ORDER BY scene.ordinal, link.claim_id
    `).all(projectId) as Array<{ claim_id: string; scene_id: string }>;
    const claimScenes = new Map<string, string[]>();
    for (const link of claimSceneRows) {
      claimScenes.set(link.claim_id, [...(claimScenes.get(link.claim_id) ?? []), link.scene_id]);
    }
    const factClaims = (this.db.raw.prepare(`
      SELECT * FROM fact_claims WHERE project_id = ? ORDER BY created_at, id
    `).all(projectId) as Array<Record<string, unknown>>).map(claim => ({
      id: String(claim.id),
      text: String(claim.text),
      category: String(claim.category),
      confidence: Number(claim.confidence),
      stability: String(claim.stability),
      validAsOf: claim.valid_as_of ? String(claim.valid_as_of) : null,
      status: String(claim.status),
      material: Boolean(claim.material),
      sourceIds: jsonArray(claim.source_ids_json),
      sceneIds: claimScenes.get(String(claim.id)) ?? [],
      normalizedKey: claim.normalized_key ? String(claim.normalized_key) : null,
      freshnessDays: claim.freshness_days === null || claim.freshness_days === undefined
        ? null : Number(claim.freshness_days),
      expiresAt: claim.expires_at ? String(claim.expires_at) : null,
      conflictGroup: claim.conflict_group ? String(claim.conflict_group) : null,
      omissionReason: claim.omission_reason ? String(claim.omission_reason) : null,
      evidence: jsonRecord(claim.evidence_json),
      createdAt: String(claim.created_at),
      updatedAt: claim.updated_at ? String(claim.updated_at) : null
    } satisfies ProjectFactClaim));
    const scriptVersions = (this.db.raw.prepare(`
      SELECT * FROM script_versions WHERE project_id = ? ORDER BY version_number DESC, created_at DESC
    `).all(projectId) as Array<Record<string, unknown>>).map(script => ({
      id: String(script.id),
      parentId: script.parent_id ? String(script.parent_id) : null,
      versionNumber: Number(script.version_number),
      title: String(script.title),
      topic: String(script.topic),
      summary: script.summary ? String(script.summary) : null,
      script: jsonRecord(script.script_json),
      generationReason: String(script.generation_reason),
      provider: String(script.provider),
      model: String(script.model),
      inputHash: String(script.input_hash),
      locked: Boolean(script.locked),
      scriptType: script.script_type as ProjectScriptVersion['scriptType'],
      lockedAt: script.locked_at ? String(script.locked_at) : null,
      createdAt: String(script.created_at)
    } satisfies ProjectScriptVersion));
    const licenses = (this.db.raw.prepare(`
      SELECT license.*, asset.title AS asset_title,
        file.id AS file_id, file.original_file_name, file.sha256, file.width,
        file.height, file.duration_ms, file.codec, file.pipeline_version
      FROM project_licenses license
      JOIN assets asset ON asset.id = license.asset_id
      LEFT JOIN asset_files file ON file.id = asset.local_file_id
      WHERE license.project_id = ?
      ORDER BY asset.title, license.asset_id
    `).all(projectId) as Array<Record<string, unknown>>).map(license => ({
      id: String(license.id),
      assetId: String(license.asset_id),
      assetTitle: String(license.asset_title),
      licenseState: license.license_state as ProjectLicenseDetail['licenseState'],
      envatoProjectName: String(license.envato_project_name),
      certificatePath: license.certificate_path ? String(license.certificate_path) : null,
      operatorAttestedAt: license.operator_attested_at ? String(license.operator_attested_at) : null,
      verifiedAt: license.verified_at ? String(license.verified_at) : null,
      notes: license.notes ? String(license.notes) : null,
      file: license.file_id ? {
        id: String(license.file_id),
        fileName: String(license.original_file_name),
        sha256: String(license.sha256),
        width: Number(license.width),
        height: Number(license.height),
        durationMs: Number(license.duration_ms),
        codec: String(license.codec),
        pipelineVersion: String(license.pipeline_version)
      } : null,
      createdAt: String(license.created_at),
      updatedAt: String(license.updated_at)
    } satisfies ProjectLicenseDetail));
    const publicationRecords = (this.db.raw.prepare(`
      SELECT * FROM publication_records WHERE project_id = ? ORDER BY created_at DESC
    `).all(projectId) as Array<Record<string, unknown>>).map(publication => ({
      id: String(publication.id),
      videoId: publication.video_id ? String(publication.video_id) : null,
      privacyStatus: String(publication.privacy_status),
      processingStatus: publication.processing_status ? String(publication.processing_status) : null,
      selectedPackageId: publication.selected_package_id ? String(publication.selected_package_id) : null,
      captionId: publication.caption_id ? String(publication.caption_id) : null,
      thumbnailUploaded: Boolean(publication.thumbnail_uploaded),
      approvedAt: publication.approved_at ? String(publication.approved_at) : null,
      scheduledAt: publication.scheduled_at ? String(publication.scheduled_at) : null,
      publishedAt: publication.published_at ? String(publication.published_at) : null,
      syntheticMedia: Boolean(publication.synthetic_media),
      error: publication.error ? String(publication.error) : null,
      createdAt: String(publication.created_at),
      updatedAt: String(publication.updated_at)
    } satisfies ProjectPublicationDetail));
    const analyticsRows = this.db.raw.prepare(`
      SELECT * FROM analytics_snapshots WHERE project_id = ? ORDER BY snapshot_day, captured_at
    `).all(projectId) as Array<Record<string, unknown>>;
    const analyticsSnapshots = analyticsRows.map(snapshot => {
      const mappings = (this.db.raw.prepare(`
        SELECT * FROM retention_mappings WHERE analytics_snapshot_id = ? ORDER BY position_ms
      `).all(snapshot.id) as Array<Record<string, unknown>>).map(mapping => ({
        positionMs: Number(mapping.position_ms),
        elapsedRatio: Number(mapping.elapsed_ratio),
        audienceWatchRatio: mapping.audience_watch_ratio === null ? null : Number(mapping.audience_watch_ratio),
        relativeRetention: mapping.relative_retention === null ? null : Number(mapping.relative_retention),
        sceneId: mapping.scene_id ? String(mapping.scene_id) : null,
        sceneOrdinal: mapping.scene_ordinal === null ? null : Number(mapping.scene_ordinal),
        chapter: mapping.chapter ? String(mapping.chapter) : null,
        visualTreatment: mapping.visual_treatment ? String(mapping.visual_treatment) : null,
        shotLengthMs: mapping.shot_length_ms === null ? null : Number(mapping.shot_length_ms),
        sourceKind: mapping.source_kind ? String(mapping.source_kind) : null,
        locationName: mapping.location_name ? String(mapping.location_name) : null,
        voiceWordsPerMinute: mapping.voice_words_per_minute === null ? null : Number(mapping.voice_words_per_minute)
      }));
      return {
        id: String(snapshot.id),
        projectId: String(snapshot.project_id),
        videoId: String(snapshot.video_id),
        snapshotDay: Number(snapshot.snapshot_day) as AnalyticsSnapshot['snapshotDay'],
        metrics: JSON.parse(String(snapshot.metrics_json)),
        retention: JSON.parse(String(snapshot.retention_json ?? '[]')),
        capturedAt: String(snapshot.captured_at ?? snapshot.collected_at),
        source: snapshot.source as AnalyticsSnapshot['source'],
        sourceHash: String(snapshot.source_hash ?? ''),
        mappings
      } satisfies AnalyticsSnapshot;
    });
    const auditLog = (this.db.raw.prepare(`
      SELECT * FROM audit_log WHERE project_id = ? ORDER BY id DESC LIMIT 250
    `).all(projectId) as Array<Record<string, unknown>>).map(entry => ({
      id: Number(entry.id),
      projectId: entry.project_id ? String(entry.project_id) : null,
      action: String(entry.action),
      actor: String(entry.actor),
      entityType: entry.entity_type ? String(entry.entity_type) : null,
      entityId: entry.entity_id ? String(entry.entity_id) : null,
      before: entry.before_json ? jsonRecord(entry.before_json) : null,
      after: entry.after_json ? jsonRecord(entry.after_json) : null,
      metadata: entry.metadata_json ? jsonRecord(entry.metadata_json) : null,
      createdAt: String(entry.created_at)
    } satisfies AuditLogEntry));

    return {
      ...projectSummary(row),
      description: row.description ? String(row.description) : null,
      opportunityScore: row.opportunity_score === null || row.opportunity_score === undefined
        ? null : Number(row.opportunity_score),
      scriptVersionId: row.script_version_id ? String(row.script_version_id) : null,
      channelSnapshot: row.channel_snapshot_json ? JSON.parse(String(row.channel_snapshot_json)) : null,
      languageVoiceSnapshot: row.language_voice_snapshot_json ? JSON.parse(String(row.language_voice_snapshot_json)) : null,
      outputProfileSnapshot: row.output_profile_snapshot_json ? JSON.parse(String(row.output_profile_snapshot_json)) : null,
      guidance: guidanceRow ? guidanceFromRow(guidanceRow) : null,
      researchSources,
      factClaims,
      scriptVersions,
      scenes,
      acquisitions,
      licenses,
      renders,
      packaging,
      qc,
      repairs: this.repairs.list(projectId),
      narrationSections,
      publicationRecords,
      analyticsSnapshots,
      auditLog,
      exports,
      rebuilds
    };
  }

  private loadAssetsForCluster(
    cluster: { country: string | null; city: string | null; locationName: string | null },
    preferredOrientation: 'landscape' | 'portrait'
  ): import('@shared/types').CatalogAsset[] {
    const where: string[] = ['excluded = 0', `availability_status <> 'unavailable'`];
    const params: unknown[] = [];
    if (cluster.country) { where.push('country = ? COLLATE NOCASE'); params.push(cluster.country); }
    if (cluster.city) { where.push('city = ? COLLATE NOCASE'); params.push(cluster.city); }
    if (cluster.locationName) { where.push('location_name = ? COLLATE NOCASE'); params.push(cluster.locationName); }

    const rows = this.db.raw.prepare(`
      SELECT * FROM assets
      WHERE ${where.join(' AND ')}
      ORDER BY
        CASE WHEN local_file_id IS NOT NULL THEN 0 ELSE 1 END,
        CASE verification_status
          WHEN 'human_verified' THEN 0
          WHEN 'metadata' THEN 1
          ELSE 2
        END,
        location_confidence DESC,
        CASE WHEN orientation = ? THEN 0 ELSE 1 END,
        declared_width DESC,
        updated_at DESC
      LIMIT 600
    `).all(...params, preferredOrientation) as Array<Record<string, unknown>>;

    // Catalog search already owns the public mapper. Reuse it safely in bounded pages.
    const ids = new Set(rows.map(row => String(row.id)));
    const all = this.catalog.search({
      page: 1,
      pageSize: 500,
      country: cluster.country ?? undefined,
      city: cluster.city ?? undefined,
      locationName: cluster.locationName ?? undefined,
      sortBy: 'updated',
      sortDirection: 'desc'
    }).rows;
    return all.filter(asset => ids.has(asset.id));
  }

  async createAutopilot(request: CreateAutopilotProjectRequest): Promise<ProjectDetail> {
    const settings = this.settings();
    const startingScript = request.startingScript;
    if (startingScript !== undefined && (!startingScript.trim() || startingScript.length > 20_000)) {
      throw new Error('Starting-script guidance must contain between 1 and 20,000 characters.');
    }
    const requestedProfileKey = request.outputProfileKey
      ?? (settings.defaultOutput === 'qualified_4k' ? 'landscape_4k' : 'landscape_1080p');
    const requestedOutput = outputDimensions(requestedProfileKey);
    const coverage = this.catalog.coverage(250);
    const requestedTopic = request.topicId
      ? this.db.raw.prepare(`SELECT * FROM topic_candidates WHERE id = ?`).get(request.topicId) as Record<string, unknown> | undefined
      : undefined;
    const guidance = resolveAutopilotGuidance(
      coverage,
      request,
      requestedOutput.orientation,
      requestedTopic ? {
        id: String(requestedTopic.id),
        destinationKey: String(requestedTopic.destination_key),
        title: String(requestedTopic.title),
        destination: String(requestedTopic.destination),
        feasibility: String(requestedTopic.feasibility)
      } : undefined
    );
    const { cluster, destination, title } = guidance;
    assertPlanningCapacity(this.db, settings, title);
    if (settings.researchProvider === 'tavily' && !this.research?.configured()) {
      throw new Error('Tavily research is enabled but its endpoint trust or credential binding is not ready; no project or provider call was started.');
    }
    if (settings.llmProvider === 'openai_compatible' && !this.ai.configured()) {
      throw new Error('The language provider is enabled but its endpoint trust or credential binding is not ready; no project or provider call was started.');
    }
    if (settings.researchProvider === 'tavily' && settings.llmProvider !== 'openai_compatible') {
      throw new Error('Web research requires a ready language-provider endpoint for cited claim extraction; no project or provider call was started.');
    }
    if (settings.visionProvider === 'openai_compatible' && !this.vision?.configured()) {
      throw new Error('The semantic vision provider is enabled but its endpoint trust or credential binding is not ready; no project or provider call was started.');
    }
    const targetMinutes = request.targetMinutes ?? settings.targetVideoMinutes;
    const targetDurationMs = Math.round(targetMinutes * 60_000);
    const planning = evaluateCoverage(cluster, targetMinutes, { orientation: requestedOutput.orientation });
    if (!planning.qualified) {
      throw new Error(`Destination coverage is below the production threshold: ${planning.reasons.join('; ')}`);
    }
    const assets = this.loadAssetsForCluster(cluster, requestedOutput.orientation);
    if (assets.length < 3) {
      throw new Error(`Not enough eligible assets for ${destination}.`);
    }
    const opportunityScore = requestedTopic && Number.isFinite(Number(requestedTopic.opportunity_score))
      ? Number(requestedTopic.opportunity_score)
      : planning.opportunityScore;

    const sequenceRow = this.db.raw.prepare(`SELECT coalesce(max(sequence), 0) + 1 AS next FROM projects`).get() as { next: number };
    const sequence = sequenceRow.next;
    const slug = slugify(title);
    const projectId = randomUUID();
    const now = new Date().toISOString();
    const channel = this.db.raw.prepare(`
      SELECT * FROM channels WHERE id = coalesce(?, (SELECT id FROM channels WHERE is_default = 1)) AND active = 1
    `).get(request.channelId ?? null) as Record<string, unknown> | undefined;
    if (!channel) throw new Error('The requested channel profile is unavailable.');
    const languageVoice = this.db.raw.prepare(`
      SELECT * FROM language_voice_profiles
      WHERE id = coalesce(?, (SELECT id FROM language_voice_profiles WHERE is_default = 1)) AND active = 1
    `).get(request.languageVoiceProfileId ?? null) as Record<string, unknown> | undefined;
    if (!languageVoice) throw new Error('The requested language and voice profile is unavailable.');
    const outputProfileRow = this.db.raw.prepare(`
      SELECT * FROM output_profiles WHERE profile_key = ? AND active = 1
    `).get(requestedProfileKey) as Record<string, unknown> | undefined;
    if (!outputProfileRow) throw new Error('The requested output profile is unavailable.');
    const channelSnapshot = {
      id: String(channel.id), name: String(channel.name), shortCode: String(channel.short_code),
      defaultLanguageCode: String(channel.default_language_code),
      youtubeChannelId: channel.youtube_channel_id ? String(channel.youtube_channel_id) : null,
      policy: JSON.parse(String(channel.policy_json)),
      externalQualification: String(channel.external_qualification), capturedAt: now
    };
    const languageVoiceSnapshot = {
      id: String(languageVoice.id), languageCode: String(languageVoice.language_code),
      languageName: String(languageVoice.language_name), voiceProvider: String(languageVoice.voice_provider),
      voiceId: String(languageVoice.voice_id), displayName: String(languageVoice.display_name),
      settings: JSON.parse(String(languageVoice.settings_json)),
      externalQualification: String(languageVoice.external_qualification), capturedAt: now
    };
    const outputProfileSnapshot = {
      id: String(outputProfileRow.id), profileKey: String(outputProfileRow.profile_key),
      displayName: String(outputProfileRow.display_name), width: Number(outputProfileRow.width),
      height: Number(outputProfileRow.height), orientation: String(outputProfileRow.orientation),
      frameRate: Number(outputProfileRow.frame_rate), videoCodec: String(outputProfileRow.video_codec),
      audioCodec: String(outputProfileRow.audio_codec),
      qualificationPolicy: JSON.parse(String(outputProfileRow.qualification_policy_json)),
      active: Boolean(outputProfileRow.active), isDefault: Boolean(outputProfileRow.is_default), capturedAt: now
    };
    const envatoProjectName = `YT-${new Date().getFullYear()}-${String(channel.short_code || settings.channelShort || 'TRAVEL')}-${String(sequence).padStart(4, '0')}-${slug.toUpperCase()}`;

    this.db.raw.transaction(() => {
      this.db.raw.prepare(`
        INSERT INTO projects(
        id, sequence, slug, title, topic, description, destination_key, destination,
        state, progress, envato_project_name, target_duration_ms, opportunity_score,
        provider_budget_usd, provider_policy_json,
        channel_id, language_voice_profile_id, output_profile_id,
        channel_snapshot_json, language_voice_snapshot_json, output_profile_snapshot_json,
        created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'CREATED', 0.02, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        projectId,
        sequence,
        slug,
        title,
        title,
        `Autopilot visual production for ${destination}.`,
        cluster.key,
        destination,
        envatoProjectName,
        targetDurationMs,
        opportunityScore,
        settings.projectBudgetUsd,
        JSON.stringify({
          monthlyBudgetUsd: settings.monthlyBudgetUsd,
          projectBudgetUsd: settings.projectBudgetUsd,
          researchProvider: settings.researchProvider,
          llmProvider: settings.llmProvider,
          visionProvider: settings.visionProvider,
          capturedAt: now
        }),
        channel.id,
        languageVoice.id,
        outputProfileRow.id,
        JSON.stringify(channelSnapshot),
        JSON.stringify(languageVoiceSnapshot),
        JSON.stringify(outputProfileSnapshot),
        now,
        now
      );
      const guided = Boolean(
        request.destinationKey
        || request.topicId
        || request.targetMinutes !== undefined
        || startingScript
      );
      this.db.raw.prepare(`
        INSERT INTO project_guidance(
          project_id, mode, starting_script, starting_script_sha256,
          requested_destination_key, requested_topic_id, requested_target_duration_ms,
          resolved_destination_key, resolved_destination, resolved_topic_title,
          resolved_target_duration_ms, constraints_json, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        projectId,
        guided ? 'guided' : 'automatic',
        startingScript ?? null,
        startingScript ? createHash('sha256').update(startingScript).digest('hex') : null,
        request.destinationKey ?? null,
        request.topicId ?? null,
        request.targetMinutes === undefined ? null : targetDurationMs,
        cluster.key,
        destination,
        title,
        targetDurationMs,
        JSON.stringify({
          schemaVersion: 'guided-editorial-seed-v1',
          role: 'editorial_guidance_only',
          evidenceEligible: false,
          researchSourceEligible: false,
          acceptedClaimEligible: false,
          rawTextSharedWithLanguageProvider: false,
          safeUses: ['catalog_grounded_emphasis', 'tone', 'pacing', 'structure'],
          factualNarrationPolicy: 'independent_source_or_catalog_evidence_required'
        }),
        now
      );
    })();

    this.db.raw.prepare(`
      INSERT INTO topic_candidates(
        id, project_id, destination_key, title, destination, angle, viewer_promise,
        keywords_json, coverage_json, demand_score, competition_score, opportunity_score,
        feasibility, reasons_json, raw_metrics_json, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 'qualified', ?, ?, ?)
    `).run(
      randomUUID(), projectId, cluster.key, title, destination,
      requestedTopic ? String(requestedTopic.angle) : 'visual guide',
      requestedTopic ? String(requestedTopic.viewer_promise) : `A truthful visual journey grounded in available ${destination} footage.`,
      requestedTopic ? String(requestedTopic.keywords_json) : JSON.stringify([destination, 'travel', 'visual guide']),
      JSON.stringify(cluster),
      opportunityScore, JSON.stringify(planning.reasons), JSON.stringify({
        signalLabel: requestedTopic ? 'selected-qualified-topic' : 'catalog-coverage-only',
        selectedTopicCandidateId: request.topicId ?? null,
        estimatedShots: planning.estimatedShots,
        requiredShots: planning.requiredShots,
        components: planning.components
      }), now
    );

    try {
      this.states.transition(projectId, 'ANALYZING_OPPORTUNITY', {
        progress: 0.05,
        reason: 'Catalog coverage selected for opportunity analysis',
        prerequisites: { destination, assetCount: assets.length, coverageScore: cluster.coverageScore }
      });
      this.states.transition(projectId, 'TOPIC_SELECTED', {
        progress: 0.08,
        reason: 'Coverage-qualified metadata-first topic selected',
        prerequisites: { title, destination }
      });
      this.states.transition(projectId, 'RESEARCHING', {
        progress: 0.1,
        reason: 'Preparing a visually observable, metadata-grounded fact pack'
      });
      const catalogSourceIds = new Map<string, string>();
      for (const asset of assets) {
        const sourceId = randomUUID();
        this.db.raw.prepare(`
          INSERT INTO research_sources(id, project_id, url, title, publisher, accessed_at, summary, raw_json)
          VALUES(?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          sourceId,
          projectId,
          asset.canonicalPageUrl ?? `urn:videofactory:catalog:${asset.id}`,
          asset.title,
          asset.authorName,
          now,
          [asset.description, asset.sceneDescription, asset.objects, asset.activity].filter(Boolean).join(' | '),
          JSON.stringify({
            sourceType: 'licensed-catalog-metadata',
            assetId: asset.id,
            country: asset.country,
            city: asset.city,
            location: asset.locationName,
            verificationStatus: asset.verificationStatus,
            locationConfidence: asset.locationConfidence
          })
        );
        catalogSourceIds.set(asset.id, sourceId);
      }
      let acceptedResearchClaims: EvaluatedClaim[] = [];
      if (settings.researchProvider === 'tavily') {
        if (!this.research) throw new Error('Research service is unavailable.');
        const search = await this.research.search({
          projectId,
          queries: [
            `${destination} official visitor information`,
            `${destination} history geography`,
            `${destination} opening hours admission transport`
          ],
          languageCode: 'en',
          maxResultsPerQuery: settings.researchMaxResultsPerQuery
        });
        const extracted = await this.research.extract(projectId, search.data.map(result => result.url));
        const searchByUrl = new Map(search.data.map(result => [result.url, result]));
        const sourceInput = extracted.data.map(result => {
          const candidate = searchByUrl.get(result.url);
          const sourceId = randomUUID();
          const contentHash = createHash('sha256').update(result.rawContent).digest('hex');
          const publisher = new URL(result.url).hostname;
          const excerpt = candidate?.content ?? result.rawContent.slice(0, 2_000);
          this.db.raw.prepare(`
            INSERT INTO research_sources(
              id, project_id, url, title, publisher, published_at, accessed_at, summary,
              raw_json, source_type, content_hash, excerpt, status
            ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'web', ?, ?, 'active')
          `).run(
            sourceId, projectId, result.url, candidate?.title ?? result.url, publisher,
            candidate?.publishedAt ?? null, now, excerpt, JSON.stringify({
              provider: search.provider, requestId: search.requestId, score: candidate?.score ?? null,
              extractedCharacters: result.rawContent.length
            }), contentHash, excerpt
          );
          return {
            id: sourceId, url: result.url, title: candidate?.title ?? result.url, publisher,
            publishedAt: candidate?.publishedAt ?? null, excerpt, content: result.rawContent
          };
        });
        const extractedClaims = await this.ai.extractClaims({ projectId, topicTitle: title, destination, sources: sourceInput });
        const claimCandidates = extractedClaims.map(claim => ({ ...claim, id: randomUUID() }));
        const evaluated = evaluateClaims(claimCandidates, new Set(sourceInput.map(source => source.id)), new Date(now));
        for (const claim of evaluated) {
          this.persistResearchClaim(projectId, claim, now);
        }
        acceptedResearchClaims = evaluated.filter(claim => claim.status === 'accepted');
        const conflicts = evaluated.filter(claim => claim.status === 'conflict');
        if (conflicts.length) this.persistResearchConflict(projectId, conflicts, now);
      }
      this.states.transition(projectId, 'SCRIPTING_PROVISIONAL', {
        progress: 0.12,
        reason: acceptedResearchClaims.length
          ? 'Generating provisional script from accepted sourced claims and verified catalog metadata'
          : 'Generating provisional script from verified catalog metadata'
      });
      const script = await this.ai.generateScript({
        projectId,
        topicTitle: title,
        destination,
        targetMinutes,
        coverage: cluster,
        assets,
        acceptedClaims: acceptedResearchClaims.map(claim => ({ id: claim.id, text: claim.text, category: claim.category, sourceIds: claim.sourceIds })),
        startingScript
      });
      const acceptedClaimIds = new Set(acceptedResearchClaims.map(claim => claim.id));
      const acceptedClaimText = new Map(acceptedResearchClaims.map(claim => [claim.id, claim.text]));
      for (const scene of script.scenes) {
        const unknown = scene.claimIds.filter(claimId => !acceptedClaimIds.has(claimId));
        if (unknown.length) throw new Error(`Script contains unknown or unaccepted claim IDs: ${unknown.join(', ')}`);
        for (const claimId of scene.claimIds) {
          const supported = acceptedClaimText.get(claimId);
          if (supported && !scene.narration.toLowerCase().includes(supported.toLowerCase())) {
            throw new Error(`Script wording exceeds or changes accepted claim ${claimId}.`);
          }
        }
      }
      const scriptId = randomUUID();
      const scriptHash = BunLikeHash(JSON.stringify({ script, assets: assets.map(asset => asset.id) }));
      this.db.raw.prepare(`
        INSERT INTO script_versions(
          id, project_id, version_number, title, topic, summary, script_json,
          generation_reason, provider, model, input_hash, locked, created_at
        ) VALUES(?, ?, 1, ?, ?, ?, ?, 'autopilot_provisional', ?, ?, ?, 0, ?)
      `).run(
        scriptId,
        projectId,
        script.title,
        script.topic,
        script.summary,
        JSON.stringify(script),
        settings.llmProvider,
        settings.llmModel,
        scriptHash,
        now
      );

      const matchingScenes = script.scenes.map(scene => ({
        requiredCountry: scene.requiredCountry,
        requiredCity: scene.requiredCity,
        requiredLocation: scene.requiredLocation,
        requiredGranularity: scene.requiredGranularity,
        requiredObjects: scene.requiredObjects,
        requiredActivities: scene.requiredActivities,
        preferredShots: scene.preferredShots,
        narration: scene.narration,
        forceGraphic: scene.visualTreatment === 'MAP_OR_GRAPHIC' || scene.visualTreatment === 'TEXT_OR_ARCHIVAL'
      }));
      const footageOrdinals = matchingScenes.flatMap((scene, index) => scene.forceGraphic ? [] : [index + 1]);
      const firstTransitionOrdinal = script.scenes.findIndex((scene, index) => index > 0
        && !matchingScenes[index]!.forceGraphic
        && scene.chapter !== script.scenes[index - 1]!.chapter) + 1;
      const heroSceneOrdinal = settings.matchingHeroStrategy === 'disabled'
        ? null
        : settings.matchingHeroStrategy === 'first_major_transition' && firstTransitionOrdinal > 0
          ? firstTransitionOrdinal
          : footageOrdinals[0] ?? null;
      const matchingPlan = this.matcher.optimizeSequence(matchingScenes, assets, {
        width: outputProfileSnapshot.width,
        height: outputProfileSnapshot.height,
        orientation: outputProfileSnapshot.orientation as 'landscape' | 'portrait' | 'square'
      }, {
        maxSourceUses: settings.matchingMaxSourceUses,
        maxConsecutiveShotMotion: settings.matchingMaxConsecutiveShotMotion,
        perceptualDuplicateDistance: settings.matchingPerceptualDistance,
        heroSceneOrdinal
      });
      const useCount = new Map<string, number>();
      const plannedAlternateBudget = Math.max(1, Math.min(5, Math.ceil(script.scenes.length * 0.15)));
      let plannedAlternates = 0;
      const selectedByScene: Array<{
        sceneOrdinal: number;
        assetId: string;
        score: number;
        reasons: string[];
        role: 'selected' | 'alternate' | 'hero';
      }> = [];
      const insertScene = this.db.raw.prepare(`
        INSERT INTO project_scenes(
          id, project_id, script_version_id, ordinal, chapter, narration,
          target_duration_ms, required_country, required_city, required_location,
          required_granularity, required_place_id, required_objects_json, required_activities_json,
          preferred_shots_json, visual_treatment, selected_asset_id, selected_file_id,
          score, score_explanation_json, verification_state, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const transaction = this.db.raw.transaction(() => {
        this.states.transition(projectId, 'STORYBOARD_PROVISIONAL', {
          progress: 0.18,
          reason: 'Provisional script validated; exact-location matching started',
          prerequisites: { sceneCount: script.scenes.length }
        });
        script.scenes.forEach((scene, index) => {
          const ordinal = index + 1;
          const planned = matchingPlan[index]!;
          const ranked = planned.candidates;
          const selected = planned.selected ?? undefined;
          const alternateCandidate = selected
            ? ranked.find(candidate => candidate.asset.id !== selected.asset.id
              && (useCount.get(candidate.asset.id) ?? 0) < settings.matchingMaxSourceUses)
            : undefined;
          const alternates = selected && alternateCandidate && plannedAlternates < plannedAlternateBudget && shouldAcquireAlternate({
            score: selected.score,
            locationConfidence: selected.asset.locationConfidence,
            verificationStatus: selected.asset.verificationStatus,
            localFileId: selected.asset.localFileId
          }) && (alternateCandidate.asset.canonicalPageUrl || alternateCandidate.asset.localFileId)
            ? [alternateCandidate]
            : [];
          const requestedGraphic = scene.visualTreatment === 'MAP_OR_GRAPHIC' || scene.visualTreatment === 'TEXT_OR_ARCHIVAL';
          const selectedFootage = requestedGraphic ? undefined : selected;
          const treatment = requestedGraphic ? scene.visualTreatment : selectedFootage ? scene.visualTreatment : 'MAP_OR_GRAPHIC';
          if (selectedFootage) {
            useCount.set(selectedFootage.asset.id, (useCount.get(selectedFootage.asset.id) ?? 0) + 1);
            selectedByScene.push({
              sceneOrdinal: ordinal,
              assetId: selectedFootage.asset.id,
              score: selectedFootage.score,
              reasons: selectedFootage.reasons,
              role: planned.role === 'hero' ? 'hero' : 'selected'
            });
          }
          const sceneId = randomUUID();
          const requiredPlaceId = this.places.ensureHierarchy({
            country: scene.requiredCountry,
            city: scene.requiredCity,
            location: scene.requiredLocation,
            granularity: scene.requiredGranularity
          })?.id ?? null;
          insertScene.run(
            sceneId,
            projectId,
            scriptId,
            ordinal,
            scene.chapter,
            scene.narration,
            Math.min(7000, Math.max(1500, scene.targetDurationMs)),
            scene.requiredCountry,
            scene.requiredCity,
            scene.requiredLocation,
            scene.requiredGranularity,
            requiredPlaceId,
            JSON.stringify(scene.requiredObjects),
            JSON.stringify(scene.requiredActivities),
            JSON.stringify(scene.preferredShots),
            treatment,
            selectedFootage?.asset.id ?? null,
            selectedFootage?.asset.localFileId ?? null,
            selectedFootage?.score ?? null,
            JSON.stringify(selectedFootage?.reasons ?? [requestedGraphic
              ? 'Script requires an evidence-bound graphic treatment'
              : 'No eligible exact-location footage; graphic fallback assigned']),
            selectedFootage
              ? (selectedFootage.asset.localFileId ? 'download_required' : 'metadata_only')
              : 'graphic',
            now,
            now
          );
          const persistedCandidates = selected
            ? [selected, ...ranked.filter(candidate => candidate.asset.id !== selected.asset.id)].slice(0, 3)
            : ranked.slice(0, 3);
          if (!requestedGraphic) persistedCandidates.forEach((candidate, rankIndex) => {
            this.db.raw.prepare(`
              INSERT INTO shot_candidates(
                id, project_id, scene_id, asset_id, candidate_rank,
                candidate_score, score_components_json, explanation_json,
                status, created_at, updated_at
              ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              randomUUID(), projectId, sceneId, candidate.asset.id, rankIndex + 1,
              candidate.score, JSON.stringify(candidate.components), JSON.stringify(candidate.reasons),
              candidate.asset.id === selected?.asset.id ? 'selected' : 'eligible', now, now
            );
          });
          for (const alternate of requestedGraphic ? [] : alternates) {
            plannedAlternates += 1;
            useCount.set(alternate.asset.id, (useCount.get(alternate.asset.id) ?? 0) + 1);
            selectedByScene.push({
              sceneOrdinal: ordinal,
              assetId: alternate.asset.id,
              score: alternate.score,
              reasons: [...alternate.reasons, `Planned alternate for scene ${ordinal}`],
              role: 'alternate'
            });
            this.db.raw.prepare(`
              UPDATE shot_candidates SET status = 'alternate', updated_at = ?
              WHERE scene_id = ? AND asset_id = ?
            `).run(now, sceneId, alternate.asset.id);
          }
          if (selectedFootage) {
            const sourceId = catalogSourceIds.get(selectedFootage.asset.id);
            if (sourceId) {
              const claimId = randomUUID();
              this.db.raw.prepare(`
                INSERT INTO fact_claims(
                  id, project_id, text, place_key, category, confidence, stability,
                  valid_as_of, source_ids_json, status, material, normalized_key, updated_at, created_at
                ) VALUES(?, ?, ?, ?, 'visual_observation', ?, 'stable', ?, ?, 'proposed', 1, ?, ?, ?)
              `).run(
                claimId,
                projectId,
                scene.narration,
                [scene.requiredCountry, scene.requiredCity, scene.requiredLocation].filter(Boolean).join('|') || null,
                Math.max(0, Math.min(1, selectedFootage.asset.locationConfidence)),
                now.slice(0, 10),
                JSON.stringify([sourceId]),
                `visual-observation:${sceneId}`,
                now,
                now
              );
              this.db.raw.prepare(`
                INSERT INTO fact_claim_sources(claim_id, source_id, support_type, excerpt, created_at)
                VALUES(?, ?, 'supports', ?, ?)
              `).run(claimId, sourceId, scene.narration, now);
              this.db.raw.prepare(`UPDATE fact_claims SET status = 'accepted' WHERE id = ?`).run(claimId);
              this.db.raw.prepare(`INSERT INTO project_scene_claims(scene_id, claim_id) VALUES(?, ?)`).run(sceneId, claimId);
            }
          }
          for (const claimId of scene.claimIds) {
            this.db.raw.prepare(`INSERT OR IGNORE INTO project_scene_claims(scene_id, claim_id) VALUES(?, ?)`).run(sceneId, claimId);
          }
        });

        const acquisitionManifest = buildAcquisitionManifest(selectedByScene, assets);
        for (const item of acquisitionManifest) {
          this.db.raw.prepare(`
            INSERT INTO acquisition_items(
              id, project_id, asset_id, ordinal, role, state, license_state,
              source_url, required_scene_ordinals_json, match_score, reasons_json,
              created_at, updated_at
            ) VALUES(?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?)
          `).run(
            randomUUID(),
            projectId,
            item.assetId,
            item.ordinal,
            item.role,
            item.state,
            item.sourceUrl,
            JSON.stringify(item.requiredSceneOrdinals),
            item.matchScore,
            JSON.stringify(item.reasons),
            now,
            now
          );
          this.db.raw.prepare(`
            INSERT INTO project_licenses(
              id, project_id, asset_id, license_state, envato_project_name,
              created_at, updated_at
            ) VALUES(?, ?, ?, 'PENDING', ?, ?, ?)
          `).run(randomUUID(), projectId, item.assetId, envatoProjectName, now, now);
        }

        this.db.raw.prepare(`
          INSERT INTO audit_log(
            project_id, action, actor, entity_type, entity_id, metadata_json, created_at
          ) VALUES(?, 'storyboard.global_match_optimized', 'system', 'project', ?, ?, ?)
        `).run(projectId, projectId, JSON.stringify({
          policy: {
            maxSourceUses: settings.matchingMaxSourceUses,
            maxConsecutiveShotMotion: settings.matchingMaxConsecutiveShotMotion,
            perceptualDuplicateDistance: settings.matchingPerceptualDistance,
            heroStrategy: settings.matchingHeroStrategy,
            heroSceneOrdinal
          },
          selections: matchingPlan.map((item, index) => ({
            sceneOrdinal: index + 1,
            assetId: item.selected?.asset.id ?? null,
            role: item.role,
            score: item.selected?.score ?? null,
            reasons: item.selected?.reasons ?? ['Graphic fallback selected by sequence policy']
          }))
        }), now);

        this.db.raw.prepare(`
          UPDATE script_versions SET locked = 1, script_type = 'provisional', locked_at = ?
          WHERE id = ?
        `).run(now, scriptId);
        this.db.raw.prepare('UPDATE projects SET script_version_id = ?, updated_at = ? WHERE id = ?')
          .run(scriptId, new Date().toISOString(), projectId);
        this.states.transition(projectId, acquisitionManifest.length ? 'WAITING_FOR_DOWNLOADS' : 'BLOCKED_EXCEPTION', {
          progress: acquisitionManifest.length ? 0.27 : 0.15,
          reason: acquisitionManifest.length ? 'Acquisition manifest created' : 'No eligible exact-location footage matched',
          prerequisites: { acquisitionCount: acquisitionManifest.length, sceneCount: script.scenes.length }
        });
      });
      transaction();

      if (!selectedByScene.length) {
        this.db.raw.prepare(`
          INSERT INTO exceptions(
            id, project_id, severity, stage, code, title, message, evidence_json,
            recommended_action, status, created_at
          ) VALUES(?, ?, 'BLOCKER', 'matching', 'NO_ELIGIBLE_FOOTAGE',
            'No exact-location footage matched',
            'The script could not be grounded in eligible catalog footage.',
            ?, 'Narrow the topic or correct location metadata.', 'OPEN', ?)
        `).run(randomUUID(), projectId, JSON.stringify({ destination }), new Date().toISOString());
      }
      return this.get(projectId);
    } catch (error) {
      const current = this.db.raw.prepare('SELECT state FROM projects WHERE id = ?').get(projectId) as { state: import('@shared/types').ProjectState };
      if (current.state !== 'FAILED') {
        this.states.transition(projectId, 'FAILED', { reason: 'Autopilot planning failed' });
      }
      this.db.raw.prepare(`
        INSERT INTO exceptions(
          id, project_id, severity, stage, code, title, message, evidence_json,
          recommended_action, status, created_at
        ) VALUES(?, ?, 'BLOCKER', 'planning', 'AUTOPILOT_PLANNING_FAILED',
          'Autopilot planning failed', ?, '{}',
          'Review AI provider settings or run with the local fallback.', 'OPEN', ?)
      `).run(
        randomUUID(),
        projectId,
        error instanceof Error ? error.message : String(error),
        new Date().toISOString()
      );
      throw error;
    }
  }

  private persistResearchClaim(projectId: string, claim: EvaluatedClaim, now: string): void {
    this.db.raw.prepare(`
      INSERT INTO fact_claims(
        id, project_id, text, category, confidence, stability, valid_as_of, source_ids_json,
        status, material, normalized_key, freshness_days, expires_at, conflict_group,
        omission_reason, evidence_json, updated_at, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      claim.id, projectId, claim.text, claim.category, claim.confidence, claim.stability,
      claim.validAsOf, JSON.stringify(claim.sourceIds), claim.material ? 1 : 0,
      claim.normalizedKey, claim.freshnessDays, claim.expiresAt, claim.conflictGroup,
      claim.omissionReason, JSON.stringify({ policyEvaluatedAt: now }), now, now
    );
    for (const sourceId of claim.sourceIds) {
      this.db.raw.prepare(`INSERT INTO fact_claim_sources(claim_id, source_id, support_type, excerpt, created_at) VALUES(?, ?, 'supports', ?, ?)`).run(claim.id, sourceId, claim.text, now);
    }
    this.db.raw.prepare(`UPDATE fact_claims SET status = ? WHERE id = ?`).run(claim.status, claim.id);
  }

  private persistResearchConflict(projectId: string, claims: EvaluatedClaim[], now: string): void {
    this.db.raw.prepare(`
      INSERT INTO exceptions(
        id, project_id, severity, stage, code, title, message, evidence_json,
        recommended_action, safe_alternatives_json, status, created_at
      ) VALUES(?, ?, 'HIGH', 'research', 'MATERIAL_SOURCE_CONFLICT',
        'Material research sources disagree',
        'Conflicting material claims were omitted from the script.', ?,
        'Review the cited sources or leave the claims omitted.', ?, 'OPEN', ?)
    `).run(
      randomUUID(), projectId,
      JSON.stringify({ claims: claims.map(claim => ({ id: claim.id, text: claim.text, sourceIds: claim.sourceIds, conflictGroup: claim.conflictGroup })) }),
      JSON.stringify(['omit_claims', 'operator_review_sources']), now
    );
  }

  pause(projectId: string): ProjectDetail {
    const project = this.get(projectId);
    if (project.state === 'PAUSED') return project;
    if (['SCHEDULED', 'PUBLISHED', 'ANALYTICS_ACTIVE', 'CANCELLED', 'FAILED', 'ARCHIVED'].includes(project.state)) {
      throw new Error(`Project cannot be paused from ${project.state}.`);
    }
    if (!canTransitionProject(project.state, 'PAUSED')) {
      throw new Error(`Project cannot be paused from ${project.state}.`);
    }
    const lock = this.db.raw.prepare(`SELECT locked_by_job_id FROM projects WHERE id = ?`).get(projectId) as {
      locked_by_job_id: string | null;
    };
    if (lock.locked_by_job_id) {
      if (project.pendingLifecycleAction === 'pause') return project;
      const now = new Date().toISOString();
      this.db.raw.transaction(() => {
        this.db.raw.prepare(`UPDATE projects SET pending_lifecycle_action = 'pause', updated_at = ? WHERE id = ?`)
          .run(now, projectId);
        this.db.raw.prepare(`
          INSERT INTO audit_log(project_id, action, actor, entity_type, entity_id, before_json, after_json, metadata_json, created_at)
          VALUES(?, 'project.pause_requested', 'human', 'project', ?, ?, ?, ?, ?)
        `).run(
          projectId,
          projectId,
          JSON.stringify({ pendingLifecycleAction: null, state: project.state }),
          JSON.stringify({ pendingLifecycleAction: 'pause', state: project.state }),
          JSON.stringify({ activeJobId: lock.locked_by_job_id, applyAt: 'next_job_checkpoint' }),
          now
        );
      })();
      return this.get(projectId);
    }
    this.db.raw.prepare(`UPDATE projects SET pending_lifecycle_action = NULL WHERE id = ?`).run(projectId);
    this.states.transition(projectId, 'PAUSED', {
      reason: 'Operator paused project automation',
      prerequisites: { priorState: project.state }
    });
    return this.get(projectId);
  }

  resume(projectId: string): ProjectDetail {
    const project = this.get(projectId);
    if (!['PAUSED', 'BLOCKED_EXCEPTION'].includes(project.state)) {
      throw new Error(`Project cannot resume from ${project.state}.`);
    }
    this.assertLifecycleUnlocked(projectId);
    this.db.raw.prepare(`UPDATE projects SET pending_lifecycle_action = NULL WHERE id = ?`).run(projectId);
    if (project.state === 'BLOCKED_EXCEPTION') {
      const blockers = this.db.raw.prepare(`
        SELECT count(*) AS count FROM exceptions
        WHERE project_id = ? AND status = 'OPEN' AND severity IN ('BLOCKER','HIGH')
      `).get(projectId) as { count: number };
      if (Number(blockers.count)) {
        throw new Error('Resolve every open blocker and high-severity exception before resuming this project.');
      }
    }
    this.states.resume(projectId, 'Operator resumed project automation');
    return this.get(projectId);
  }

  cancel(projectId: string): ProjectDetail {
    const project = this.get(projectId);
    if (project.state === 'CANCELLED') return project;
    if (['SCHEDULED', 'PUBLISHED', 'ANALYTICS_ACTIVE', 'FAILED', 'ARCHIVED'].includes(project.state)) {
      throw new Error(`Project cannot be cancelled from ${project.state}.`);
    }
    this.assertLifecycleUnlocked(projectId);
    this.db.raw.prepare(`UPDATE projects SET pending_lifecycle_action = NULL WHERE id = ?`).run(projectId);
    this.states.transition(projectId, 'CANCELLED', {
      reason: 'Operator cancelled project production',
      prerequisites: { priorState: project.state }
    });
    this.cancelPendingJobs(projectId, 'Project was cancelled by the operator');
    return this.get(projectId);
  }

  archive(projectId: string): ProjectDetail {
    const project = this.get(projectId);
    if (project.state === 'ARCHIVED') return project;
    if (!['PUBLISHED', 'ANALYTICS_ACTIVE', 'CANCELLED', 'FAILED'].includes(project.state)) {
      throw new Error(`Only completed, cancelled, or failed projects can be archived, not ${project.state}.`);
    }
    this.assertLifecycleUnlocked(projectId);
    this.db.raw.prepare(`UPDATE projects SET pending_lifecycle_action = NULL WHERE id = ?`).run(projectId);
    this.states.transition(projectId, 'ARCHIVED', {
      reason: 'Operator archived inactive project',
      prerequisites: { priorState: project.state }
    });
    this.cancelPendingJobs(projectId, 'Project was archived by the operator');
    return this.get(projectId);
  }

  private cancelPendingJobs(projectId: string, reason: string): void {
    const now = new Date().toISOString();
    this.db.raw.prepare(`
      UPDATE jobs SET state = 'CANCELLED', error = ?, lease_owner = NULL,
        lease_until = NULL, completed_at = ?, transition_version = transition_version + 1,
        updated_at = ?
      WHERE project_id = ?
        AND state IN ('QUEUED','READY','WAITING_EXTERNAL','WAITING_HUMAN',
          'RETRY_SCHEDULED','FAILED_RETRYABLE','FAILED_PERMANENT')
    `).run(reason, now, now, projectId);
  }

  private assertLifecycleUnlocked(projectId: string): void {
    const row = this.db.raw.prepare(`SELECT locked_by_job_id FROM projects WHERE id = ?`).get(projectId) as
      | { locked_by_job_id: string | null }
      | undefined;
    if (!row) throw new Error('Project not found.');
    if (row.locked_by_job_id) {
      throw new Error('Wait for the active project job to reach a checkpoint before changing lifecycle state.');
    }
  }

  applyPendingLifecycle(projectId: string): boolean {
    return this.db.raw.transaction(() => {
      const row = this.db.raw.prepare(`
        SELECT state, locked_by_job_id, pending_lifecycle_action FROM projects WHERE id = ?
      `).get(projectId) as {
        state: import('@shared/types').ProjectState;
        locked_by_job_id: string | null;
        pending_lifecycle_action: string | null;
      } | undefined;
      if (!row || row.locked_by_job_id || row.pending_lifecycle_action !== 'pause') return false;
      this.db.raw.prepare(`UPDATE projects SET pending_lifecycle_action = NULL WHERE id = ?`).run(projectId);
      if (!canTransitionProject(row.state, 'PAUSED') || ['SCHEDULED'].includes(row.state)) return false;
      this.states.transition(projectId, 'PAUSED', {
        reason: 'Applied operator pause request at a completed job checkpoint',
        prerequisites: { priorState: row.state, deferredRequest: true }
      });
      return true;
    })();
  }

  delete(projectId: string): void {
    this.db.raw.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
  }

  generatePackaging(
    projectId: string,
    renderedTimeline?: Array<{ ordinal: number; chapter: string | null; timelineStartMs: number }>
  ): PackagingCandidate[] {
    const project = this.get(projectId);
    this.db.raw.prepare('DELETE FROM packaging_candidates WHERE project_id = ?').run(projectId);
    const destination = project.destination ?? project.topic;
    const chapterLines = this.buildChapters(project.scenes, renderedTimeline);
    const sourceLinks = (this.db.raw.prepare(`
      SELECT DISTINCT source.url
      FROM project_scene_claims scene_claim
      JOIN project_scenes scene ON scene.id = scene_claim.scene_id
      JOIN fact_claims claim ON claim.id = scene_claim.claim_id AND claim.status = 'accepted'
      JOIN fact_claim_sources claim_source ON claim_source.claim_id = claim.id
      JOIN research_sources source ON source.id = claim_source.source_id
      WHERE scene.project_id = ? AND source.url IS NOT NULL
      ORDER BY source.url LIMIT 12
    `).all(projectId) as Array<{ url: string }>).map(row => row.url);
    const concepts = [
      {
        title: `${destination}: A Visual Guide`,
        angle: 'clear utility',
        promise: `See the defining views of ${destination} in one concise visual journey.`
      },
      {
        title: `A Closer Look at ${destination}`,
        angle: 'visual truth',
        promise: `A grounded look at ${destination} using verified footage and sourced graphics.`
      },
      {
        title: `${destination} in Motion`,
        angle: 'curiosity and beauty',
        promise: `Explore the scenes that give ${destination} its visual character.`
      }
    ];
    const now = new Date().toISOString();
    const insert = this.db.raw.prepare(`
      INSERT INTO packaging_candidates(
        id, project_id, ordinal, title, angle, viewer_promise, description,
        chapters, tags_json, risk_status, selected, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'pass', ?, ?)
    `);
    concepts.forEach((concept, index) => {
      const description = [
        concept.promise,
        '',
        project.description ?? '',
        '',
        'CHAPTERS',
        chapterLines,
        ...(sourceLinks.length ? ['', 'SOURCES', ...sourceLinks] : []),
        '',
        'Footage and generated graphics are labeled from persisted project evidence.'
      ].join('\n').trim();
      insert.run(
        randomUUID(),
        projectId,
        index + 1,
        concept.title,
        concept.angle,
        concept.promise,
        description,
        chapterLines,
        JSON.stringify([destination, 'travel', 'visual guide', 'stock footage']),
        index === 0 ? 1 : 0,
        now
      );
    });
    return this.get(projectId).packaging;
  }

  private buildChapters(
    scenes: ProjectScene[],
    renderedTimeline?: Array<{ ordinal: number; chapter: string | null; timelineStartMs: number }>
  ): string {
    if (renderedTimeline?.length) {
      const firstByOrdinal = new Map<number, { chapter: string | null; timelineStartMs: number }>();
      for (const item of [...renderedTimeline].sort((left, right) => left.timelineStartMs - right.timelineStartMs)) {
        if (!firstByOrdinal.has(item.ordinal)) firstByOrdinal.set(item.ordinal, item);
      }
      let previousChapter = '';
      return [...firstByOrdinal.values()].flatMap(item => {
        const chapter = item.chapter ?? 'Visual journey';
        if (chapter === previousChapter) return [];
        previousChapter = chapter;
        const seconds = Math.floor(item.timelineStartMs / 1000);
        return [`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} ${chapter}`];
      }).join('\n');
    }
    let elapsed = 0;
    let previousChapter = '';
    const lines: string[] = [];
    for (const scene of scenes) {
      const chapter = scene.chapter ?? 'Visual journey';
      if (chapter !== previousChapter) {
        const seconds = Math.floor(elapsed / 1000);
        const minutes = Math.floor(seconds / 60);
        const remainder = seconds % 60;
        lines.push(`${minutes}:${String(remainder).padStart(2, '0')} ${chapter}`);
        previousChapter = chapter;
      }
      elapsed += scene.targetDurationMs;
    }
    return lines.join('\n');
  }
}

function BunLikeHash(value: string): string {
  // Avoid runtime-specific hash APIs while keeping deterministic script inputs.
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
