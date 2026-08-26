import type { ProjectState } from '@shared/types';
import { assertProjectTransition } from '@shared/state-machine';
import type { AppDatabase } from '../database/database';
import { invalidatePublicationSnapshots } from './active-final-service';

interface TransitionOptions {
  progress?: number;
  reason: string;
  prerequisites?: Record<string, unknown>;
  finalRenderId?: string;
  youtubeVideoId?: string;
  publishedAt?: string | null;
}

export class ProjectStateService {
  constructor(private readonly db: AppDatabase) {}

  transition(projectId: string, to: ProjectState, options: TransitionOptions): ProjectState {
    return this.db.raw.transaction(() => {
      const row = this.db.raw.prepare('SELECT state, progress, resume_state, final_render_id FROM projects WHERE id = ?').get(projectId) as
        | { state: ProjectState; progress: number; resume_state: ProjectState | null; final_render_id: string | null }
        | undefined;
      if (!row) throw new Error('Project not found.');
      assertProjectTransition(row.state, to);
      const now = new Date().toISOString();
      const enteringWait = ['PAUSED', 'BLOCKED_EXCEPTION'].includes(to);
      const leavingWait = ['PAUSED', 'BLOCKED_EXCEPTION'].includes(row.state) && !enteringWait;
      const resumeState = enteringWait
        ? (['PAUSED', 'BLOCKED_EXCEPTION'].includes(row.state) ? row.resume_state : row.state)
        : leavingWait ? null : row.resume_state;
      if (options.finalRenderId && options.finalRenderId !== row.final_render_id) {
        invalidatePublicationSnapshots(
          this.db,
          projectId,
          'A newly completed final render replaced the publication snapshot. The prior upload must remain private.',
          'active_final_changed',
          now
        );
      }
      this.db.raw.prepare(`
        UPDATE projects SET state = ?, progress = ?, final_render_id = COALESCE(?, final_render_id),
          youtube_video_id = COALESCE(?, youtube_video_id), published_at = COALESCE(?, published_at),
          resume_state = ?, updated_at = ? WHERE id = ?
      `).run(
        to, options.progress ?? row.progress, options.finalRenderId ?? null,
        options.youtubeVideoId ?? null, options.publishedAt ?? null, resumeState, now, projectId
      );
      this.db.raw.prepare(`
        INSERT INTO audit_log(project_id, action, actor, entity_type, entity_id, before_json, after_json, metadata_json, created_at)
        VALUES(?, 'project.state_changed', 'system', 'project', ?, ?, ?, ?, ?)
      `).run(
        projectId, projectId,
        JSON.stringify({ state: row.state, resumeState: row.resume_state }),
        JSON.stringify({ state: to, resumeState }),
        JSON.stringify({ reason: options.reason, prerequisiteSnapshot: options.prerequisites ?? {} }), now
      );
      return to;
    })();
  }

  resume(projectId: string, reason: string, target?: ProjectState): ProjectState {
    const row = this.db.raw.prepare('SELECT state, resume_state FROM projects WHERE id = ?').get(projectId) as
      | { state: ProjectState; resume_state: ProjectState | null }
      | undefined;
    if (!row) throw new Error('Project not found.');
    if (!['PAUSED', 'BLOCKED_EXCEPTION'].includes(row.state)) {
      throw new Error(`Project cannot resume from ${row.state}.`);
    }
    const destination = target ?? row.resume_state;
    if (!destination) throw new Error('Project has no durable resume state.');
    return this.transition(projectId, destination, {
      reason,
      prerequisites: { storedResumeState: row.resume_state, requestedTarget: target ?? null }
    });
  }
}
