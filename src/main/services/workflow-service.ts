import { createHash, randomUUID } from 'node:crypto';
import type { AppDatabase } from '../database/database';
import type { ProjectDetail, ProjectState } from '@shared/types';
import { JobResourceBusyError, type JobService } from './job-service';
import type { ProjectService } from './project-service';
import type { ScriptFinalizationService } from './script-finalization-service';
import type { NarrationService } from './narration-service';
import type { RenderService } from './render-service';
import type { FinalReviewService } from './final-review-service';
import type { YouTubeService } from './youtube-service';
import { StalePublicationSnapshotError, type PublicationSnapshot } from './active-final-service';

const AUTOMATIC_STATES: readonly ProjectState[] = [
  'FINALIZING_SCRIPT',
  'GENERATING_VOICE',
  'BUILDING_TIMELINE',
  'RENDERING_DRAFT',
  'QC_DRAFT',
  'RENDERING_FINAL',
  'QC_FINAL',
  'UPLOADING_PRIVATE',
  'WAITING_YOUTUBE_PROCESSING'
];

const STOP_STATES = new Set<ProjectState>([
  'WAITING_FOR_DOWNLOADS',
  'WAITING_FINAL_APPROVAL',
  'AWAITING_MANUAL_STUDIO_ACTION',
  'PAUSED',
  'BLOCKED_EXCEPTION',
  'SCHEDULED',
  'PUBLISHED',
  'ANALYTICS_ACTIVE',
  'CANCELLED',
  'FAILED',
  'ARCHIVED'
]);

type StageResult = 'completed' | 'deferred';
type StageOutcome<T> =
  | { state: 'completed'; output: T | undefined }
  | { state: 'deferred' };
type PrivateUploadReceipt = Awaited<ReturnType<YouTubeService['uploadPrivate']>>;

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export class WorkflowService {
  private readonly running = new Map<string, Promise<ProjectDetail>>();

  constructor(
    private readonly db: AppDatabase,
    private readonly jobs: JobService,
    private readonly projects: ProjectService,
    private readonly scriptFinalization: ScriptFinalizationService,
    private readonly narration: NarrationService,
    private readonly renders: RenderService,
    private readonly finalReview: FinalReviewService,
    private readonly youtube: YouTubeService,
    private readonly emitState: () => void,
    private readonly setLongOperationActive: (active: boolean) => void
  ) {}

  advance(projectId: string): Promise<ProjectDetail> {
    const existing = this.running.get(projectId);
    if (existing) return existing;
    const operation = this.run(projectId).finally(() => {
      if (this.running.get(projectId) === operation) this.running.delete(projectId);
    });
    this.running.set(projectId, operation);
    return operation;
  }

  async resumeOldest(): Promise<ProjectDetail | null> {
    const placeholders = AUTOMATIC_STATES.map(() => '?').join(',');
    const row = this.db.raw.prepare(`
      SELECT p.id FROM projects p
      WHERE p.state IN (${placeholders}) AND p.locked_by_job_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM revision_requests r
          WHERE r.project_id = p.id AND r.status = 'requested'
        )
      ORDER BY created_at ASC, sequence ASC LIMIT 1
    `).get(...AUTOMATIC_STATES) as { id: string } | undefined;
    return row ? this.advance(row.id) : null;
  }

  async prepareRepairWithinRenderJob(projectId: string, targetState: ProjectState): Promise<void> {
    if (targetState === 'FINALIZING_SCRIPT') {
      await this.scriptFinalization.finalize(projectId);
      await this.narration.generate(projectId);
    } else if (targetState === 'GENERATING_VOICE') {
      await this.narration.generate(projectId);
    }
  }

  async uploadPrivate(projectId: string): Promise<PrivateUploadReceipt> {
    const review = this.finalReview.get(projectId);
    if (!review.canUpload) {
      throw new Error('Final render, selected package, and blocker-free QC are required before private upload.');
    }
    const snapshot = this.uploadIdentity(projectId);
    const outcome = await this.runStageJob(
      'workflow_upload_private',
      projectId,
      snapshot,
      () => this.youtube.uploadPrivate(projectId, snapshot)
    );
    if (outcome.state === 'deferred') {
      throw new Error('Private upload is already running or the project is busy with another state-mutating workflow. Try again after the active job completes.');
    }
    if (outcome.output) return outcome.output;
    return this.completedUploadReceipt(snapshot);
  }

  private async run(projectId: string): Promise<ProjectDetail> {
    this.setLongOperationActive(true);
    try {
      for (let step = 0; step < 24; step += 1) {
        const project = this.projects.get(projectId);
        if (this.hasPendingManualRevision(projectId)) return project;
        if (project.state === 'WAITING_FINAL_APPROVAL') {
          this.finalReview.completeAutomaticRevisions(projectId);
          return project;
        }
        if (STOP_STATES.has(project.state) || !AUTOMATIC_STATES.includes(project.state)) return project;
        const lock = this.db.raw.prepare('SELECT locked_by_job_id FROM projects WHERE id = ?').get(projectId) as {
          locked_by_job_id: string | null;
        };
        if (lock.locked_by_job_id) return project;

        const before = project.state;
        try {
          const result = await this.execute(project);
          if (result === 'deferred') return this.projects.get(projectId);
        } catch (error) {
          this.blockFailure(projectId, before, error);
          this.emitState();
          return this.projects.get(projectId);
        }
        this.emitState();
        if (this.projects.get(projectId).state === before) {
          this.blockFailure(projectId, before, new Error(`Automatic stage ${before} completed without a state transition.`));
          this.emitState();
          return this.projects.get(projectId);
        }
      }
      this.blockFailure(projectId, this.projects.get(projectId).state, new Error('Automatic workflow exceeded its bounded transition count.'));
      this.emitState();
      return this.projects.get(projectId);
    } finally {
      this.setLongOperationActive(false);
    }
  }

  private async execute(project: ProjectDetail): Promise<StageResult> {
    if (project.state === 'FINALIZING_SCRIPT') {
      const outcome = await this.runStageJob('workflow_finalize_script', project.id, this.scriptIdentity(project.id), async () => {
        await this.scriptFinalization.finalize(project.id);
      });
      return outcome.state;
    }
    if (project.state === 'GENERATING_VOICE') {
      const outcome = await this.runStageJob('workflow_generate_voice', project.id, this.scriptIdentity(project.id), async () => {
        await this.narration.generate(project.id);
      });
      return outcome.state;
    }
    if (project.state === 'BUILDING_TIMELINE' || project.state === 'RENDERING_DRAFT') {
      return this.runRender(project, 'draft');
    }
    if (project.state === 'QC_DRAFT' || project.state === 'RENDERING_FINAL') {
      return this.runRender(project, 'final');
    }
    if (project.state === 'QC_FINAL') {
      const review = this.finalReview.get(project.id);
      if (!review.canUpload) {
        throw new Error('Final render, selected package, and blocker-free QC are required before private upload.');
      }
      const readiness = this.youtube.uploadReadiness();
      if (!readiness.ready) {
        this.block(project.id, readiness.code, readiness.title, readiness.message, { state: project.state });
        return 'completed';
      }
      return this.runUploadJob(project.id);
    }
    if (project.state === 'UPLOADING_PRIVATE' || project.state === 'WAITING_YOUTUBE_PROCESSING') {
      return this.runUploadJob(project.id);
    }
    return 'deferred';
  }

  private async runRender(project: ProjectDetail, kind: 'draft' | 'final'): Promise<StageResult> {
    try {
      await this.renders.render(project.id, { kind, outputProfileKey: project.outputProfileKey });
      return 'completed';
    } catch (error) {
      if (error instanceof JobResourceBusyError) return 'deferred';
      throw error;
    }
  }

  private async runUploadJob(projectId: string): Promise<StageResult> {
    const snapshot = this.uploadIdentity(projectId);
    const outcome = await this.runStageJob('workflow_upload_private', projectId, snapshot, async () => {
      await this.youtube.uploadPrivate(projectId, snapshot);
    });
    return outcome.state;
  }

  private async runStageJob<T>(
    type: string,
    projectId: string,
    identity: unknown,
    work: () => Promise<T>
  ): Promise<StageOutcome<T>> {
    const job = this.jobs.create(type, projectId, identity, 3);
    if (job.state === 'SUCCEEDED') {
      const stored = this.db.raw.prepare(`SELECT output_json FROM jobs WHERE id = ?`).get(job.id) as {
        output_json: string | null;
      } | undefined;
      let output: T | undefined;
      try {
        output = stored?.output_json
          ? (JSON.parse(stored.output_json) as { result?: T }).result
          : undefined;
      } catch {
        output = undefined;
      }
      return { state: 'completed', output };
    }
    if (job.state === 'RUNNING' || (job.state === 'RETRY_SCHEDULED' && job.availableAt > new Date().toISOString())) {
      return { state: 'deferred' };
    }
    try {
      this.jobs.start(job.id, `Running ${type.replaceAll('_', ' ')}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/locked by another|cannot start from RUNNING|backoff has not elapsed/i.test(message)) return { state: 'deferred' };
      throw error;
    }
    const heartbeat = setInterval(() => {
      this.jobs.progress(job.id, 0, `Running ${type.replaceAll('_', ' ')}`);
    }, 60_000);
    heartbeat.unref();
    try {
      const output = await work();
      this.jobs.succeed(job.id, {
        state: this.projects.get(projectId).state,
        identityHash: stableHash(identity),
        result: output
      });
      return { state: 'completed', output };
    } catch (error) {
      this.jobs.fail(job.id, error);
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  }

  private scriptIdentity(projectId: string): Record<string, unknown> {
    const project = this.db.raw.prepare(`
      SELECT script_version_id FROM projects WHERE id = ?
    `).get(projectId) as { script_version_id: string | null };
    const scenes = this.db.raw.prepare(`
      SELECT id, narration, pronunciation_json, selected_file_id, selected_segment_id
      FROM project_scenes WHERE project_id = ? ORDER BY ordinal
    `).all(projectId);
    const revisionTable = this.db.raw.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'revision_requests'
    `).get();
    const revision = revisionTable
      ? this.db.raw.prepare(`
          SELECT id, category, note, affected_scene_id, affected_section_id
          FROM revision_requests WHERE project_id = ? ORDER BY created_at DESC LIMIT 1
        `).get(projectId)
      : null;
    return { projectId, scriptVersionId: project.script_version_id, scenes, revision };
  }

  private uploadIdentity(projectId: string): PublicationSnapshot {
    return this.youtube.createUploadSnapshot(projectId);
  }

  private completedUploadReceipt(snapshot: PublicationSnapshot): PrivateUploadReceipt {
    const publication = this.db.raw.prepare(`
      SELECT video_id FROM publication_records
      WHERE project_id = ? AND channel_id = ? AND final_render_id = ? AND final_sha256 = ?
        AND selected_package_id = ? AND approval_hash = ? AND snapshot_version = ?
        AND snapshot_status = 'current' AND video_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 1
    `).get(
      snapshot.projectId,
      snapshot.confirmedChannelId,
      snapshot.finalRenderId,
      snapshot.finalSha256,
      snapshot.selectedPackageId,
      snapshot.approvalHash,
      snapshot.snapshotVersion
    ) as { video_id: string } | undefined;
    if (!publication?.video_id) {
      throw new Error('The private upload job completed without a durable YouTube video receipt.');
    }
    return {
      videoId: publication.video_id,
      url: `https://www.youtube.com/watch?v=${publication.video_id}`
    };
  }

  private hasPendingManualRevision(projectId: string): boolean {
    return Boolean(this.db.raw.prepare(`
      SELECT 1 FROM revision_requests
      WHERE project_id = ? AND status = 'requested' LIMIT 1
    `).get(projectId));
  }

  private blockFailure(projectId: string, state: ProjectState, error: unknown): void {
    const current = this.projects.get(projectId);
    if (current.state === 'BLOCKED_EXCEPTION') return;
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof StalePublicationSnapshotError) {
      this.block(
        projectId,
        'STALE_PUBLICATION_SNAPSHOT',
        'The private YouTube upload is stale',
        message,
        { state, boundary: error.boundary },
        'Review the active final, upload its current package privately, then remove the stale private video in YouTube Studio.'
      );
      return;
    }
    this.block(
      projectId,
      state === 'QC_FINAL' || state === 'UPLOADING_PRIVATE' || state === 'WAITING_YOUTUBE_PROCESSING'
        ? 'YOUTUBE_UPLOAD_FAILED'
        : 'AUTOMATION_STAGE_FAILED',
      state === 'QC_FINAL' || state === 'UPLOADING_PRIVATE' || state === 'WAITING_YOUTUBE_PROCESSING'
        ? 'Private upload needs attention'
        : 'Automatic workflow stage failed',
      message,
      { state }
    );
  }

  private block(
    projectId: string,
    code: string,
    title: string,
    message: string,
    evidence: Record<string, unknown>,
    recommendedAction = 'Open Settings, repair the provider configuration, then resume the project.'
  ): void {
    const existing = this.db.raw.prepare(`
      SELECT id FROM exceptions WHERE project_id = ? AND code = ? AND status = 'OPEN' LIMIT 1
    `).get(projectId, code);
    if (!existing) {
      this.db.raw.prepare(`
        INSERT INTO exceptions(
          id, project_id, severity, stage, code, title, message, evidence_json,
          recommended_action, status, created_at
        ) VALUES(?, ?, 'BLOCKER', 'publishing', ?, ?, ?, ?,
          ?, 'OPEN', ?)
      `).run(
        randomUUID(), projectId, code, title, message, JSON.stringify(evidence),
        recommendedAction, new Date().toISOString()
      );
    }
    const current = this.projects.get(projectId);
    if (current.state !== 'BLOCKED_EXCEPTION') {
      this.projects.states.transition(projectId, 'BLOCKED_EXCEPTION', {
        reason: title,
        prerequisites: { code, ...evidence }
      });
    }
  }
}

export { AUTOMATIC_STATES as AUTOMATIC_WORKFLOW_STATES };
