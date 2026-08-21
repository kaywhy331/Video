import { createHash, randomUUID } from 'node:crypto';
import type { AppDatabase } from '../database/database';
import type {
  AnalyticsSnapshot,
  AnalyticsCollectionRequest,
  AnalyticsCollectionRun,
  AnalyticsProviderResult,
  AppSettings,
  JobRecord,
  LearningRecommendation,
  RetentionMapping
} from '@shared/types';
import type { z } from 'zod';
import type { AnalyticsSnapshotSchema, LearningRecommendationSchema } from '@shared/contracts';
import { JobService } from './job-service';
import { ProjectStateService } from './project-state-service';

type SnapshotInput = z.infer<typeof AnalyticsSnapshotSchema>;
type RecommendationInput = z.infer<typeof LearningRecommendationSchema>;

export interface AnalyticsProvider {
  collect(request: AnalyticsCollectionRequest): Promise<AnalyticsProviderResult>;
  publicationStatus?(videoId: string): Promise<{
    isPublic: boolean;
    privacyStatus: string | null;
    publishedAt: string | null;
  }>;
}

export interface AnalyticsCadenceResult {
  eligibleProjects: number;
  dueJobs: number;
  succeeded: number;
  deferred: number;
  failed: number;
}

interface ManifestScene {
  sceneId?: string;
  ordinal?: number;
  chapter?: string | null;
  narration?: string;
  timelineStartMs?: number;
  timelineEndMs?: number;
  durationMs?: number;
  visualTreatment?: string;
  requiredLocation?: string | null;
  editingPlan?: { sourceKind?: string };
}

const LEARNING_LIMITS: Record<string, { minimum: number; maximum: number }> = {
  preferredShotMinSeconds: { minimum: 1.5, maximum: 7 },
  preferredShotMaxSeconds: { minimum: 1.5, maximum: 7 },
  targetVideoMinutes: { minimum: 1, maximum: 30 }
};

const SNAPSHOT_DAYS = [1, 3, 7, 28, 90] as const;

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export class AnalyticsService {
  private readonly states: ProjectStateService;

  constructor(
    private readonly db: AppDatabase,
    private readonly settings: () => AppSettings,
    private readonly updateSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>,
    private readonly provider?: AnalyticsProvider,
    private readonly jobs: JobService = new JobService(db),
    private readonly now: () => Date = () => new Date()
  ) {
    this.states = new ProjectStateService(db);
  }

  scheduleCheckpoints(projectId: string): JobRecord[] {
    const row = this.db.raw.prepare(`
      SELECT p.state, p.youtube_video_id, p.published_at,
        r.video_id, r.scheduled_at, r.published_at AS publication_published_at
      FROM projects p
      LEFT JOIN publication_records r ON r.id = (
        SELECT id FROM publication_records
        WHERE project_id = p.id AND video_id IS NOT NULL
        ORDER BY created_at DESC LIMIT 1
      )
      WHERE p.id = ?
    `).get(projectId) as {
      state: import('@shared/types').ProjectState;
      youtube_video_id: string | null;
      published_at: string | null;
      video_id: string | null;
      scheduled_at: string | null;
      publication_published_at: string | null;
    } | undefined;
    if (!row || !['SCHEDULED', 'PUBLISHED', 'ANALYTICS_ACTIVE'].includes(row.state)) return [];
    const videoId = row.youtube_video_id ?? row.video_id;
    const anchorValue = row.scheduled_at
      ?? row.published_at
      ?? row.publication_published_at;
    const anchor = anchorValue ? new Date(anchorValue) : null;
    if (!videoId || !anchor || !Number.isFinite(anchor.getTime())) return [];
    const anchorAt = anchor.toISOString();
    return SNAPSHOT_DAYS.map(snapshotDay => this.jobs.schedule(
      'analytics_checkpoint',
      projectId,
      { projectId, videoId, snapshotDay, anchorAt },
      new Date(anchor.getTime() + snapshotDay * 86_400_000).toISOString(),
      5
    ));
  }

  async processDue(limit = 25): Promise<AnalyticsCadenceResult> {
    const eligible = this.db.raw.prepare(`
      SELECT id FROM projects WHERE state IN ('SCHEDULED','PUBLISHED','ANALYTICS_ACTIVE')
      ORDER BY created_at
    `).all() as Array<{ id: string }>;
    for (const project of eligible) this.scheduleCheckpoints(project.id);
    const now = this.now();
    const rows = this.db.raw.prepare(`
      SELECT id, project_id, input_json FROM jobs
      WHERE type = 'analytics_checkpoint'
        AND state IN ('QUEUED','READY','RETRY_SCHEDULED')
        AND available_at <= ?
      ORDER BY available_at, created_at
      LIMIT ?
    `).all(now.toISOString(), limit) as Array<{
      id: string;
      project_id: string;
      input_json: string;
    }>;
    const result: AnalyticsCadenceResult = {
      eligibleProjects: eligible.length,
      dueJobs: rows.length,
      succeeded: 0,
      deferred: 0,
      failed: 0
    };
    for (const row of rows) {
      const input = JSON.parse(row.input_json) as {
        projectId?: string;
        videoId?: string;
        snapshotDay?: number;
      };
      const projectId = input.projectId ?? row.project_id;
      const snapshotDay = input.snapshotDay;
      if (!projectId || !SNAPSHOT_DAYS.includes(snapshotDay as typeof SNAPSHOT_DAYS[number])) {
        this.jobs.start(row.id, 'Validating analytics checkpoint');
        this.jobs.fail(row.id, new Error('Analytics checkpoint input is invalid.'));
        result.failed += 1;
        continue;
      }
      const project = this.db.raw.prepare(`SELECT state FROM projects WHERE id = ?`).get(projectId) as
        | { state: import('@shared/types').ProjectState }
        | undefined;
      if (project?.state === 'SCHEDULED') {
        try {
          if (!input.videoId || !this.provider?.publicationStatus) {
            throw new Error('Scheduled-publication confirmation is unavailable.');
          }
          const publication = await this.provider.publicationStatus(input.videoId);
          if (!publication.isPublic) {
            this.jobs.reschedule(
              row.id,
              new Date(now.getTime() + 60 * 60_000).toISOString(),
              `Waiting for scheduled publication (${publication.privacyStatus ?? 'unknown'})`
            );
            result.deferred += 1;
            continue;
          }
          this.confirmScheduledPublication(projectId, input.videoId, publication.publishedAt);
        } catch (error) {
          this.jobs.start(row.id, 'Confirming scheduled publication');
          this.jobs.fail(row.id, error);
          result.failed += 1;
          continue;
        }
      }
      try {
        this.jobs.start(row.id, `Collecting day ${snapshotDay} analytics`);
        const collected = await this.collect(projectId, snapshotDay as typeof SNAPSHOT_DAYS[number]);
        this.jobs.succeed(row.id, { analyticsSnapshotId: collected.id, snapshotDay });
        result.succeeded += 1;
      } catch (error) {
        this.jobs.fail(row.id, error);
        result.failed += 1;
      }
    }
    return result;
  }

  async collect(projectId: string, snapshotDay: 1 | 3 | 7 | 28 | 90): Promise<AnalyticsSnapshot> {
    if (!this.provider) throw new Error('The YouTube Analytics provider is unavailable.');
    const project = this.db.raw.prepare(`
      SELECT youtube_video_id, state FROM projects WHERE id = ?
    `).get(projectId) as {
      youtube_video_id: string | null;
      state: import('@shared/types').ProjectState;
    } | undefined;
    if (!project) throw new Error('Analytics project not found.');
    if (!['PUBLISHED', 'ANALYTICS_ACTIVE'].includes(project.state)) {
      throw new Error(`Analytics collection requires a published project, not ${project.state}.`);
    }
    const publication = this.db.raw.prepare(`
      SELECT video_id, coalesce(published_at, scheduled_at, created_at) AS anchor_at
      FROM publication_records
      WHERE project_id = ? AND video_id IS NOT NULL ORDER BY created_at DESC LIMIT 1
    `).get(projectId) as { video_id: string | null; anchor_at: string } | undefined;
    const videoId = project.youtube_video_id ?? publication?.video_id;
    if (!videoId) throw new Error('A persisted YouTube video ID is required for analytics collection.');
    const capturedAt = this.now().toISOString();
    const endDate = capturedAt.slice(0, 10);
    const anchor = publication?.anchor_at
      ? new Date(publication.anchor_at)
      : new Date(this.now().getTime() - snapshotDay * 86_400_000);
    const startDate = Number.isFinite(anchor.getTime()) ? anchor.toISOString().slice(0, 10) : endDate;
    const request: AnalyticsCollectionRequest = {
      projectId, videoId, snapshotDay, capturedAt, startDate, endDate
    };
    const runId = randomUUID();
    this.db.raw.prepare(`
      INSERT INTO analytics_collection_runs(
        id, project_id, video_id, snapshot_day, provider, status,
        request_json, created_at
      ) VALUES(?, ?, ?, ?, 'youtube_analytics', 'running', ?, ?)
    `).run(runId, projectId, videoId, snapshotDay, JSON.stringify(request), capturedAt);
    try {
      const result = await this.provider.collect(request);
      const snapshot = this.importSnapshot({
        projectId, videoId, snapshotDay, capturedAt,
        source: 'youtube_api', metrics: result.metrics, retention: result.retention
      });
      const responseHash = hashJson(result);
      this.db.raw.prepare(`
        UPDATE analytics_collection_runs SET status = 'complete',
          analytics_snapshot_id = ?, response_hash = ?, completed_at = ? WHERE id = ?
      `).run(snapshot.id, responseHash, new Date().toISOString(), runId);
      this.activateAnalytics(projectId, snapshot.id);
      return snapshot;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000);
      this.db.raw.prepare(`
        UPDATE analytics_collection_runs SET status = 'failed', error = ?, completed_at = ? WHERE id = ?
      `).run(message, new Date().toISOString(), runId);
      throw error;
    }
  }

  collectionRuns(projectId?: string): AnalyticsCollectionRun[] {
    const rows = this.db.raw.prepare(`
      SELECT * FROM analytics_collection_runs ${projectId ? 'WHERE project_id = ?' : ''}
      ORDER BY created_at DESC LIMIT 500
    `).all(...(projectId ? [projectId] : [])) as Array<Record<string, unknown>>;
    return rows.map(row => ({
      id: String(row.id), projectId: String(row.project_id), videoId: String(row.video_id),
      snapshotDay: Number(row.snapshot_day) as AnalyticsCollectionRun['snapshotDay'],
      provider: String(row.provider), status: row.status as AnalyticsCollectionRun['status'],
      analyticsSnapshotId: row.analytics_snapshot_id ? String(row.analytics_snapshot_id) : null,
      responseHash: row.response_hash ? String(row.response_hash) : null,
      error: row.error ? String(row.error) : null, createdAt: String(row.created_at),
      completedAt: row.completed_at ? String(row.completed_at) : null
    }));
  }

  importSnapshot(input: SnapshotInput): AnalyticsSnapshot {
    const project = this.db.raw.prepare('SELECT id FROM projects WHERE id = ?').get(input.projectId);
    if (!project) throw new Error('Analytics project not found.');
    const publication = this.db.raw.prepare(`
      SELECT video_id FROM publication_records WHERE project_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(input.projectId) as { video_id: string | null } | undefined;
    if (publication?.video_id && publication.video_id !== input.videoId) {
      throw new Error('Analytics video ID does not match the persisted publication.');
    }
    const manifestRow = this.db.raw.prepare(`
      SELECT r.duration_ms, m.manifest_json FROM renders r
      JOIN render_manifests m ON m.id = r.manifest_id
      WHERE r.project_id = ? AND r.kind = 'final' AND r.state = 'SUCCEEDED'
      ORDER BY r.completed_at DESC LIMIT 1
    `).get(input.projectId) as { duration_ms: number; manifest_json: string } | undefined;
    if (!manifestRow) throw new Error('A completed final render manifest is required for retention mapping.');
    const manifest = JSON.parse(manifestRow.manifest_json) as { scenes?: ManifestScene[] };
    const scenes = (manifest.scenes ?? []).filter(scene => (
      Number.isFinite(scene.timelineStartMs) && Number.isFinite(scene.timelineEndMs)
    ));
    if (!scenes.length) throw new Error('Final render manifest contains no mappable scenes.');
    const durationMs = Number(manifestRow.duration_ms);
    const sourceHash = hashJson(input);
    const existing = this.db.raw.prepare(`
      SELECT id, source_hash FROM analytics_snapshots WHERE project_id = ? AND snapshot_day = ?
    `).get(input.projectId, input.snapshotDay) as { id: string; source_hash: string | null } | undefined;
    if (existing?.source_hash === sourceHash) {
      this.activateAnalytics(input.projectId, existing.id);
      return this.get(existing.id);
    }
    const id = existing?.id ?? randomUUID();
    const now = new Date().toISOString();
    this.db.raw.transaction(() => {
      this.db.raw.prepare(`
        INSERT INTO analytics_snapshots(
          id, project_id, video_id, snapshot_day, metrics_json, retention_json,
          collected_at, captured_at, source, source_hash
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, snapshot_day) DO UPDATE SET
          video_id = excluded.video_id, metrics_json = excluded.metrics_json,
          retention_json = excluded.retention_json, collected_at = excluded.collected_at,
          captured_at = excluded.captured_at, source = excluded.source,
          source_hash = excluded.source_hash
      `).run(
        id, input.projectId, input.videoId, input.snapshotDay,
        JSON.stringify(input.metrics), JSON.stringify(input.retention), now,
        input.capturedAt, input.source, sourceHash
      );
      this.db.raw.prepare('DELETE FROM retention_mappings WHERE analytics_snapshot_id = ?').run(id);
      for (const point of [...input.retention].sort((a, b) => a.elapsedRatio - b.elapsedRatio)) {
        const positionMs = Math.min(durationMs, Math.max(0, Math.round(point.elapsedRatio * durationMs)));
        const scene = scenes.find(item => positionMs >= Number(item.timelineStartMs) && positionMs < Number(item.timelineEndMs))
          ?? (positionMs === durationMs ? scenes.at(-1) : undefined);
        const narrationWords = scene?.narration?.trim().split(/\s+/).filter(Boolean).length ?? 0;
        const sceneDuration = scene ? Number(scene.durationMs ?? Number(scene.timelineEndMs) - Number(scene.timelineStartMs)) : null;
        const wordsPerMinute = sceneDuration && narrationWords ? narrationWords / (sceneDuration / 60_000) : null;
        this.db.raw.prepare(`
          INSERT INTO retention_mappings(
            id, analytics_snapshot_id, project_id, position_ms, elapsed_ratio,
            audience_watch_ratio, relative_retention, scene_id, scene_ordinal,
            chapter, visual_treatment, shot_length_ms, source_kind, location_name,
            voice_words_per_minute, mapping_evidence_json, created_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(), id, input.projectId, positionMs, point.elapsedRatio,
          point.audienceWatchRatio, point.relativeRetention, scene?.sceneId ?? null,
          scene?.ordinal ?? null, scene?.chapter ?? null, scene?.visualTreatment ?? null,
          sceneDuration, scene?.editingPlan?.sourceKind ?? null, scene?.requiredLocation ?? null,
          wordsPerMinute, JSON.stringify({ manifestMatched: Boolean(scene), durationMs }), now
        );
      }
    })();
    this.activateAnalytics(input.projectId, id);
    return this.get(id);
  }

  private confirmScheduledPublication(projectId: string, videoId: string, publishedAt: string | null): void {
    const now = this.now().toISOString();
    const effectivePublishedAt = publishedAt && Number.isFinite(new Date(publishedAt).getTime())
      ? new Date(publishedAt).toISOString()
      : now;
    this.db.raw.prepare(`
      UPDATE publication_records SET privacy_status = 'public', published_at = ?, updated_at = ?
      WHERE project_id = ? AND video_id = ?
    `).run(effectivePublishedAt, now, projectId, videoId);
    const project = this.db.raw.prepare(`SELECT state FROM projects WHERE id = ?`).get(projectId) as {
      state: import('@shared/types').ProjectState;
    };
    if (project.state === 'SCHEDULED') {
      this.states.transition(projectId, 'PUBLISHED', {
        progress: 1,
        publishedAt: effectivePublishedAt,
        reason: 'Scheduled YouTube publication was confirmed public',
        prerequisites: { videoId, confirmedAt: now }
      });
    }
  }

  private activateAnalytics(projectId: string, snapshotId: string): void {
    const project = this.db.raw.prepare(`SELECT state FROM projects WHERE id = ?`).get(projectId) as
      | { state: import('@shared/types').ProjectState }
      | undefined;
    if (project?.state === 'PUBLISHED') {
      this.states.transition(projectId, 'ANALYTICS_ACTIVE', {
        progress: 1,
        reason: 'The first durable analytics snapshot was captured',
        prerequisites: { analyticsSnapshotId: snapshotId }
      });
    }
  }

  list(projectId?: string): AnalyticsSnapshot[] {
    const rows = this.db.raw.prepare(`
      SELECT id FROM analytics_snapshots ${projectId ? 'WHERE project_id = ?' : ''}
      ORDER BY captured_at DESC, snapshot_day DESC LIMIT 500
    `).all(...(projectId ? [projectId] : [])) as Array<{ id: string }>;
    return rows.map(row => this.get(row.id));
  }

  propose(input: RecommendationInput): LearningRecommendation {
    const snapshots = this.db.raw.prepare(`
      SELECT id, project_id, metrics_json FROM analytics_snapshots
      WHERE id IN (${input.evidenceSnapshotIds.map(() => '?').join(',')})
    `).all(...input.evidenceSnapshotIds) as Array<{ id: string; project_id: string; metrics_json: string }>;
    const uniqueVideos = new Set(snapshots.map(row => row.project_id));
    const totalViews = snapshots.reduce((total, row) => total + Number((JSON.parse(row.metrics_json) as { views?: number }).views ?? 0), 0);
    if (snapshots.length !== new Set(input.evidenceSnapshotIds).size) throw new Error('One or more analytics evidence snapshots do not exist.');
    if (uniqueVideos.size < 2 || totalViews < 1_000) {
      throw new Error('Learning recommendations require at least two videos and 1,000 aggregate views.');
    }
    const limits = LEARNING_LIMITS[input.metricKey];
    if (!limits || input.proposedValue < limits.minimum || input.proposedValue > limits.maximum) {
      throw new Error(`Proposed ${input.metricKey} is outside the supported policy range.`);
    }
    const settings = this.settings();
    const beforeValue = settings[input.metricKey as keyof AppSettings];
    const maximumDelta = Math.max(Number(beforeValue) * 0.25, input.metricKey === 'targetVideoMinutes' ? 1 : 0.5);
    if (Math.abs(input.proposedValue - Number(beforeValue)) > maximumDelta) {
      throw new Error('Learning recommendation exceeds the 25% bounded-change policy.');
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.raw.prepare(`
      INSERT INTO learning_recommendations(
        id, metric_key, scope_json, before_value_json, proposed_value_json,
        current_value_json, rationale, evidence_snapshot_ids_json,
        evidence_video_count, evidence_total_views, status, created_at, updated_at
      ) VALUES(?, ?, '{}', ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?)
    `).run(
      id, input.metricKey, JSON.stringify(beforeValue), JSON.stringify(input.proposedValue),
      JSON.stringify(beforeValue), input.rationale, JSON.stringify([...new Set(input.evidenceSnapshotIds)]),
      uniqueVideos.size, totalViews, now, now
    );
    return this.recommendation(id);
  }

  recommendations(): LearningRecommendation[] {
    return (this.db.raw.prepare(`SELECT id FROM learning_recommendations ORDER BY created_at DESC`).all() as Array<{ id: string }>).map(row => this.recommendation(row.id));
  }

  async decide(id: string, decision: 'apply' | 'reject' | 'rollback'): Promise<LearningRecommendation> {
    const recommendation = this.recommendation(id);
    const now = new Date().toISOString();
    if (decision === 'apply') {
      if (recommendation.status !== 'proposed') throw new Error('Only a proposed recommendation can be applied.');
      await this.updateSettings({ [recommendation.metricKey]: recommendation.proposedValue } as Partial<AppSettings>);
      this.db.raw.prepare(`UPDATE learning_recommendations SET status = 'applied', current_value_json = proposed_value_json, applied_at = ?, updated_at = ? WHERE id = ?`).run(now, now, id);
    } else if (decision === 'reject') {
      if (recommendation.status !== 'proposed') throw new Error('Only a proposed recommendation can be rejected.');
      this.db.raw.prepare(`UPDATE learning_recommendations SET status = 'rejected', updated_at = ? WHERE id = ?`).run(now, id);
    } else {
      if (recommendation.status !== 'applied') throw new Error('Only an applied recommendation can be rolled back.');
      await this.updateSettings({ [recommendation.metricKey]: recommendation.beforeValue } as Partial<AppSettings>);
      this.db.raw.prepare(`UPDATE learning_recommendations SET status = 'rolled_back', current_value_json = before_value_json, rolled_back_at = ?, updated_at = ? WHERE id = ?`).run(now, now, id);
    }
    this.db.raw.prepare(`
      INSERT INTO audit_log(action, actor, entity_type, entity_id, after_json, metadata_json, created_at)
      VALUES('learning.recommendation_decided', 'human', 'learning_recommendation', ?, ?, ?, ?)
    `).run(id, JSON.stringify({ decision, status: this.recommendation(id).status }), JSON.stringify({ evidenceSnapshotIds: recommendation.evidenceSnapshotIds }), now);
    return this.recommendation(id);
  }

  private get(id: string): AnalyticsSnapshot {
    const row = this.db.raw.prepare('SELECT * FROM analytics_snapshots WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error('Analytics snapshot not found.');
    const mappings = (this.db.raw.prepare(`SELECT * FROM retention_mappings WHERE analytics_snapshot_id = ? ORDER BY position_ms`).all(id) as Array<Record<string, unknown>>).map(item => this.mapping(item));
    return {
      id: String(row.id), projectId: String(row.project_id), videoId: String(row.video_id),
      snapshotDay: Number(row.snapshot_day) as AnalyticsSnapshot['snapshotDay'],
      metrics: JSON.parse(String(row.metrics_json)), retention: JSON.parse(String(row.retention_json ?? '[]')),
      capturedAt: String(row.captured_at ?? row.collected_at), source: row.source as AnalyticsSnapshot['source'],
      sourceHash: String(row.source_hash ?? ''), mappings
    };
  }

  private mapping(row: Record<string, unknown>): RetentionMapping {
    return {
      positionMs: Number(row.position_ms), elapsedRatio: Number(row.elapsed_ratio),
      audienceWatchRatio: row.audience_watch_ratio === null ? null : Number(row.audience_watch_ratio),
      relativeRetention: row.relative_retention === null ? null : Number(row.relative_retention),
      sceneId: row.scene_id ? String(row.scene_id) : null,
      sceneOrdinal: row.scene_ordinal === null ? null : Number(row.scene_ordinal),
      chapter: row.chapter ? String(row.chapter) : null,
      visualTreatment: row.visual_treatment ? String(row.visual_treatment) : null,
      shotLengthMs: row.shot_length_ms === null ? null : Number(row.shot_length_ms),
      sourceKind: row.source_kind ? String(row.source_kind) : null,
      locationName: row.location_name ? String(row.location_name) : null,
      voiceWordsPerMinute: row.voice_words_per_minute === null ? null : Number(row.voice_words_per_minute)
    };
  }

  private recommendation(id: string): LearningRecommendation {
    const row = this.db.raw.prepare('SELECT * FROM learning_recommendations WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error('Learning recommendation not found.');
    return {
      id: String(row.id), metricKey: String(row.metric_key), scope: JSON.parse(String(row.scope_json)),
      beforeValue: JSON.parse(String(row.before_value_json)), proposedValue: JSON.parse(String(row.proposed_value_json)),
      currentValue: JSON.parse(String(row.current_value_json)), rationale: String(row.rationale),
      evidenceSnapshotIds: JSON.parse(String(row.evidence_snapshot_ids_json)), evidenceVideoCount: Number(row.evidence_video_count),
      evidenceTotalViews: Number(row.evidence_total_views), status: row.status as LearningRecommendation['status'],
      appliedAt: row.applied_at ? String(row.applied_at) : null, rolledBackAt: row.rolled_back_at ? String(row.rolled_back_at) : null,
      createdAt: String(row.created_at), updatedAt: String(row.updated_at)
    };
  }
}
