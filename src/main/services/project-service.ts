import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '../database/database';
import type { AppSettings, CreateAutopilotProjectRequest, PackagingCandidate, ProjectDetail, ProjectScene, ProjectSummary, QcResult, RenderRecord } from '@shared/types';
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

function jsonArray(value: unknown): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function projectSummary(row: Record<string, unknown>): ProjectSummary {
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
    finalRenderPath: row.final_render_path ? String(row.final_render_path) : null,
    youtubeVideoId: row.youtube_video_id ? String(row.youtube_video_id) : null,
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
      artifactVersion: Number(row.artifact_version ?? 1)
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

    return {
      ...projectSummary(row),
      description: row.description ? String(row.description) : null,
      opportunityScore: row.opportunity_score === null || row.opportunity_score === undefined
        ? null : Number(row.opportunity_score),
      scriptVersionId: row.script_version_id ? String(row.script_version_id) : null,
      scenes,
      acquisitions,
      renders,
      packaging,
      qc,
      repairs: this.repairs.list(projectId)
    };
  }

  private loadAssetsForCluster(cluster: { country: string | null; city: string | null; locationName: string | null }): import('@shared/types').CatalogAsset[] {
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
        CASE WHEN orientation = 'landscape' THEN 0 ELSE 1 END,
        declared_width DESC,
        updated_at DESC
      LIMIT 600
    `).all(...params) as Array<Record<string, unknown>>;

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
    const coverage = this.catalog.coverage(250);
    if (!coverage.length) throw new Error('Import a footage catalog before starting Autopilot.');
    const requestedCluster = request.destinationKey
      ? coverage.find(cluster => cluster.key === request.destinationKey)
      : undefined;
    const cluster = requestedCluster
      ?? coverage.find(item => item.assetCount >= 12 && item.landscapeCount >= Math.max(6, item.assetCount * 0.45))
      ?? coverage[0];
    if (!cluster) throw new Error('No supportable destination cluster is available.');

    const destination = cluster.locationName ?? cluster.city ?? cluster.country ?? 'Selected destination';
    const title = `A Visual Guide to ${destination}`;
    assertPlanningCapacity(this.db, settings, title);
    if (settings.researchProvider === 'tavily' && !this.research?.configured()) {
      throw new Error('Tavily research is enabled but its encrypted API key is not configured; no project or provider call was started.');
    }
    if (settings.llmProvider === 'openai_compatible' && !this.ai.configured()) {
      throw new Error('The language provider is enabled but its encrypted API key is not configured; no project or provider call was started.');
    }
    if (settings.researchProvider === 'tavily' && settings.llmProvider !== 'openai_compatible') {
      throw new Error('Web research requires the configured language provider and encrypted API key for cited claim extraction; no project or provider call was started.');
    }
    if (settings.visionProvider === 'openai_compatible' && !this.vision?.configured()) {
      throw new Error('The semantic vision provider is enabled but its encrypted API key is not configured; no project or provider call was started.');
    }
    const targetMinutes = request.targetMinutes ?? settings.targetVideoMinutes;
    const planning = evaluateCoverage(cluster, targetMinutes);
    if (!planning.qualified) {
      throw new Error(`Destination coverage is below the production threshold: ${planning.reasons.join('; ')}`);
    }
    const assets = this.loadAssetsForCluster(cluster);
    if (assets.length < 3) {
      throw new Error(`Not enough eligible assets for ${destination}.`);
    }

    const sequenceRow = this.db.raw.prepare(`SELECT coalesce(max(sequence), 0) + 1 AS next FROM projects`).get() as { next: number };
    const sequence = sequenceRow.next;
    const slug = slugify(title);
    const projectId = randomUUID();
    const now = new Date().toISOString();
    const envatoProjectName = `YT-${new Date().getFullYear()}-${settings.channelShort || 'TRAVEL'}-${String(sequence).padStart(4, '0')}-${slug.toUpperCase()}`;

    this.db.raw.prepare(`
      INSERT INTO projects(
        id, sequence, slug, title, topic, description, destination_key, destination,
        state, progress, envato_project_name, target_duration_ms, opportunity_score,
        provider_budget_usd, provider_policy_json,
        created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'CREATED', 0.02, ?, ?, ?, ?, ?, ?, ?)
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
      Math.round(targetMinutes * 60_000),
      planning.opportunityScore,
      settings.projectBudgetUsd,
      JSON.stringify({
        monthlyBudgetUsd: settings.monthlyBudgetUsd,
        projectBudgetUsd: settings.projectBudgetUsd,
        researchProvider: settings.researchProvider,
        llmProvider: settings.llmProvider,
        visionProvider: settings.visionProvider,
        capturedAt: now
      }),
      now,
      now
    );

    this.db.raw.prepare(`
      INSERT INTO topic_candidates(
        id, project_id, destination_key, title, destination, angle, viewer_promise,
        keywords_json, coverage_json, demand_score, competition_score, opportunity_score,
        feasibility, reasons_json, raw_metrics_json, created_at
      ) VALUES(?, ?, ?, ?, ?, 'visual guide', ?, ?, ?, NULL, NULL, ?, 'qualified', ?, ?, ?)
    `).run(
      randomUUID(), projectId, cluster.key, title, destination,
      `A truthful visual journey grounded in available ${destination} footage.`,
      JSON.stringify([destination, 'travel', 'visual guide']), JSON.stringify(cluster),
      planning.opportunityScore, JSON.stringify(planning.reasons), JSON.stringify({
        signalLabel: 'catalog-coverage-only',
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
        acceptedClaims: acceptedResearchClaims.map(claim => ({ id: claim.id, text: claim.text, category: claim.category, sourceIds: claim.sourceIds }))
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

      const useCount = new Map<string, number>();
      const plannedAlternateBudget = Math.max(1, Math.min(5, Math.ceil(script.scenes.length * 0.15)));
      let plannedAlternates = 0;
      const selectedByScene: Array<{
        sceneOrdinal: number;
        assetId: string;
        score: number;
        reasons: string[];
        role: 'selected' | 'alternate';
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
          const ranked = this.matcher.rank({
            requiredCountry: scene.requiredCountry,
            requiredCity: scene.requiredCity,
            requiredLocation: scene.requiredLocation,
            requiredGranularity: scene.requiredGranularity,
            requiredObjects: scene.requiredObjects,
            requiredActivities: scene.requiredActivities,
            preferredShots: scene.preferredShots,
            narration: scene.narration
          }, assets, useCount);
          const selected = ranked[0];
          const alternates = selected && ranked[1] && plannedAlternates < plannedAlternateBudget && shouldAcquireAlternate({
            score: selected.score,
            locationConfidence: selected.asset.locationConfidence,
            verificationStatus: selected.asset.verificationStatus,
            localFileId: selected.asset.localFileId
          }) && (ranked[1].asset.canonicalPageUrl || ranked[1].asset.localFileId)
            ? ranked.slice(1, 2)
            : [];
          const treatment = selected ? scene.visualTreatment : 'MAP_OR_GRAPHIC';
          if (selected) {
            useCount.set(selected.asset.id, (useCount.get(selected.asset.id) ?? 0) + 1);
            selectedByScene.push({
              sceneOrdinal: ordinal,
              assetId: selected.asset.id,
              score: selected.score,
              reasons: selected.reasons,
              role: 'selected'
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
            selected?.asset.id ?? null,
            selected?.asset.localFileId ?? null,
            selected?.score ?? null,
            JSON.stringify(selected?.reasons ?? ['No eligible exact-location footage; graphic fallback assigned']),
            selected
              ? (selected.asset.localFileId ? 'download_required' : 'metadata_only')
              : 'graphic',
            now,
            now
          );
          ranked.slice(0, 3).forEach((candidate, rankIndex) => {
            this.db.raw.prepare(`
              INSERT INTO shot_candidates(
                id, project_id, scene_id, asset_id, candidate_rank,
                candidate_score, score_components_json, explanation_json,
                status, created_at, updated_at
              ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              randomUUID(), projectId, sceneId, candidate.asset.id, rankIndex + 1,
              candidate.score, JSON.stringify(candidate.components), JSON.stringify(candidate.reasons),
              rankIndex === 0 ? 'selected' : 'eligible', now, now
            );
          });
          for (const alternate of alternates) {
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
          if (selected) {
            const sourceId = catalogSourceIds.get(selected.asset.id);
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
                Math.max(0, Math.min(1, selected.asset.locationConfidence)),
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

        const grouped = new Map<string, {
          ordinals: number[];
          score: number;
          reasons: string[];
          selected: boolean;
          alternate: boolean;
        }>();
        for (const selected of selectedByScene) {
          const current = grouped.get(selected.assetId) ?? {
            ordinals: [],
            score: selected.score,
            reasons: selected.reasons,
            selected: false,
            alternate: false
          };
          current.ordinals.push(selected.sceneOrdinal);
          current.score = Math.max(current.score, selected.score);
          current.selected ||= selected.role === 'selected';
          current.alternate ||= selected.role === 'alternate';
          grouped.set(selected.assetId, current);
        }

        let acqOrdinal = 1;
        for (const [assetId, data] of grouped) {
          const asset = assets.find(item => item.id === assetId);
          if (!asset) continue;
          const local = Boolean(asset.localFileId);
          if (!local && !asset.canonicalPageUrl) continue;
          const role = local
            ? 'license_only'
            : data.selected && data.ordinals.includes(1)
              ? 'hero'
              : data.selected ? 'primary' : 'alternate';
          this.db.raw.prepare(`
            INSERT INTO acquisition_items(
              id, project_id, asset_id, ordinal, role, state, license_state,
              source_url, required_scene_ordinals_json, match_score, reasons_json,
              created_at, updated_at
            ) VALUES(?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?)
          `).run(
            randomUUID(),
            projectId,
            assetId,
            acqOrdinal++,
            role,
            local ? 'LICENSE_ONLY_PENDING' : 'READY_TO_OPEN',
            asset.canonicalPageUrl ?? `urn:videofactory:catalog:${asset.id}`,
            JSON.stringify(data.ordinals),
            data.score,
            JSON.stringify(data.reasons),
            now,
            now
          );
          this.db.raw.prepare(`
            INSERT INTO project_licenses(
              id, project_id, asset_id, license_state, envato_project_name,
              created_at, updated_at
            ) VALUES(?, ?, ?, 'PENDING', ?, ?, ?)
          `).run(randomUUID(), projectId, assetId, envatoProjectName, now, now);
        }

        this.db.raw.prepare('UPDATE script_versions SET locked = 1 WHERE id = ?').run(scriptId);
        this.db.raw.prepare('UPDATE projects SET script_version_id = ?, updated_at = ? WHERE id = ?')
          .run(scriptId, new Date().toISOString(), projectId);
        this.states.transition(projectId, grouped.size ? 'WAITING_FOR_DOWNLOADS' : 'BLOCKED_EXCEPTION', {
          progress: grouped.size ? 0.27 : 0.15,
          reason: grouped.size ? 'Acquisition manifest created' : 'No eligible exact-location footage matched',
          prerequisites: { acquisitionCount: grouped.size, sceneCount: script.scenes.length }
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

  delete(projectId: string): void {
    this.db.raw.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
  }

  generatePackaging(projectId: string): PackagingCandidate[] {
    const project = this.get(projectId);
    this.db.raw.prepare('DELETE FROM packaging_candidates WHERE project_id = ?').run(projectId);
    const destination = project.destination ?? project.topic;
    const chapterLines = this.buildChapters(project.scenes);
    const concepts = [
      {
        title: `${destination}: A Visual Guide`,
        angle: 'clear utility',
        promise: `See the defining views of ${destination} in one concise visual journey.`
      },
      {
        title: `Inside ${destination}: What the Views Really Look Like`,
        angle: 'visual truth',
        promise: `A grounded look at ${destination} using footage matched to the exact place.`
      },
      {
        title: `The Most Striking Views of ${destination}`,
        angle: 'curiosity and beauty',
        promise: `Discover the scenes that make ${destination} visually distinctive.`
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
        '',
        `Footage locations are matched to the destination shown.`
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

  private buildChapters(scenes: ProjectScene[]): string {
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
