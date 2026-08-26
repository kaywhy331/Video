import type {
  FinalReview,
  FinalReviewRevisionCategory,
  FinalReviewRevisionRequest,
  ProjectState,
  RevisionRequestRecord
} from '@shared/types';
import type { ProjectService } from './project-service';
import type { AppDatabase } from '../database/database';
import { approvalFingerprint } from '@shared/approval';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { captionPathFromManifest } from '../media-protocol';
import {
  ActiveFinalService,
  invalidatePublicationSnapshots
} from './active-final-service';

function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const REVISION_ROUTES: Record<FinalReviewRevisionCategory, ProjectState> = {
  packaging: 'QC_FINAL',
  caption_typo: 'BUILDING_TIMELINE',
  voice_pronunciation: 'GENERATING_VOICE',
  script_factual_issue: 'FINALIZING_SCRIPT',
  wrong_or_weak_shot: 'VERIFYING_FOOTAGE',
  new_footage_required: 'WAITING_FOR_DOWNLOADS',
  major_story_change: 'SCRIPTING_PROVISIONAL'
};

function revisionFromRow(row: Record<string, unknown>): RevisionRequestRecord {
  const term = row.pronunciation_term ? String(row.pronunciation_term) : null;
  const value = row.pronunciation_value ? String(row.pronunciation_value) : null;
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    category: row.category as FinalReviewRevisionCategory,
    note: String(row.note),
    affectedSceneId: row.affected_scene_id ? String(row.affected_scene_id) : null,
    affectedSectionId: row.affected_section_id ? String(row.affected_section_id) : null,
    pronunciation: term && value ? { term, value } : null,
    returnState: row.return_state as ProjectState,
    status: row.status as RevisionRequestRecord['status'],
    createdAt: String(row.created_at),
    completedAt: row.completed_at ? String(row.completed_at) : null
  };
}

export function finalReviewGates(input: {
  hasFinalRender: boolean;
  hasSelectedPackage: boolean;
  blockerCount: number;
  state: import('@shared/types').ProjectState;
  hasYoutubeVideo: boolean;
  packageSynced: boolean;
  publicationReady: boolean;
}): { canUpload: boolean; canApprove: boolean } {
  const artifactsReady = input.hasFinalRender && input.hasSelectedPackage && input.blockerCount === 0;
  return {
    canUpload: artifactsReady
      && ['QC_FINAL', 'WAITING_FINAL_APPROVAL', 'WAITING_YOUTUBE_PROCESSING', 'UPLOADING_PRIVATE'].includes(input.state),
    canApprove: artifactsReady
      && input.hasYoutubeVideo
      && input.packageSynced
      && input.publicationReady
      && input.state === 'WAITING_FINAL_APPROVAL'
  };
}

export class FinalReviewService {
  constructor(
    private readonly db: AppDatabase,
    private readonly projects: ProjectService,
    private readonly projectFolder: () => string | null = () => null,
    private readonly activeFinal = new ActiveFinalService(db, () => projectFolder() ?? process.cwd())
  ) {}

  get(projectId: string): FinalReview {
    const project = this.projects.get(projectId);
    const selectedPackage = project.packaging.find(candidate => candidate.selected) ?? null;
    const selectedPackageReady = Boolean(
      selectedPackage?.thumbnailPath && existsSync(selectedPackage.thumbnailPath)
      && selectedPackage.riskStatus !== 'blocked'
    );
    let finalRender: ReturnType<ActiveFinalService['requireActiveFinal']> | undefined;
    try {
      finalRender = this.activeFinal.requireActiveFinal(projectId);
    } catch {
      finalRender = undefined;
    }
    const relevantQc = finalRender
      ? project.qc.filter(item => item.renderId === finalRender.id)
      : project.qc;
    const blockers = relevantQc.filter(item =>
      item.status === 'fail' && ['BLOCKER', 'HIGH'].includes(item.severity)
    );
    const warnings = relevantQc.filter(item =>
      item.status === 'warning'
      || (item.status === 'fail' && !['BLOCKER', 'HIGH'].includes(item.severity))
    );
    const publication = this.db.raw.prepare(`
      SELECT approval_hash, processing_status, caption_id, thumbnail_uploaded,
        approved_at, privacy_status, final_render_id, final_sha256, snapshot_status
      FROM publication_records
      WHERE project_id = ? AND video_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(projectId, project.youtubeVideoId) as {
      approval_hash: string | null;
      processing_status: string | null;
      caption_id: string | null;
      thumbnail_uploaded: number;
      approved_at: string | null;
      privacy_status: string;
      final_render_id: string | null;
      final_sha256: string;
      snapshot_status: string;
    } | undefined;
    const publicationReady = Boolean(
      publication?.snapshot_status === 'current'
      && publication.final_render_id === finalRender?.id
      && publication.final_sha256 === finalRender?.sha256
      && publication.processing_status === 'succeeded'
      && publication.caption_id
      && publication.thumbnail_uploaded
    );
    const packageSynced = Boolean(!project.youtubeVideoId || (publicationReady && (
      finalRender?.sha256
      && selectedPackage
      && publication?.approval_hash === approvalFingerprint({
        finalSha256: finalRender.sha256,
        packageId: selectedPackage.id,
        title: selectedPackage.title,
        description: selectedPackage.description,
        chapters: selectedPackage.chapters,
        tags: selectedPackage.tags,
        thumbnailSha256: selectedPackage.thumbnailPath && existsSync(selectedPackage.thumbnailPath)
          ? fileSha256(selectedPackage.thumbnailPath)
          : null
      })
    )));
    const gates = finalReviewGates({
      hasFinalRender: Boolean(finalRender),
      hasSelectedPackage: selectedPackageReady,
      blockerCount: blockers.length,
      state: project.state,
      hasYoutubeVideo: Boolean(project.youtubeVideoId),
      packageSynced,
      publicationReady
    });
    return {
      project,
      selectedPackage,
      privateVideoUrl: project.youtubeVideoId
        ? `https://www.youtube.com/watch?v=${project.youtubeVideoId}`
        : null,
      keptPrivateAt: publication?.privacy_status === 'private' ? publication.approved_at : null,
      localPreviewUrl: finalRender?.id ? `videofactory://render/${finalRender.id}` : null,
      localCaptionsUrl: finalRender?.id
        && captionPathFromManifest(finalRender.manifestPath, this.projectFolder() ?? '')
        ? `videofactory://caption/${finalRender.id}`
        : null,
      blockers,
      warnings,
      packageSynced,
      ...gates
    };
  }

  requestRevision(input: FinalReviewRevisionRequest): RevisionRequestRecord {
    const project = this.projects.get(input.projectId);
    if (project.state !== 'WAITING_FINAL_APPROVAL') {
      throw new Error(`A final-review revision can be requested only from WAITING_FINAL_APPROVAL, not ${project.state}.`);
    }
    const returnState = REVISION_ROUTES[input.category];
    if (!returnState) throw new Error('Unsupported final-review revision category.');
    if (input.affectedSceneId) {
      const scene = this.db.raw.prepare(`
        SELECT pronunciation_json FROM project_scenes WHERE id = ? AND project_id = ?
      `).get(input.affectedSceneId, input.projectId) as { pronunciation_json: string } | undefined;
      if (!scene) throw new Error('The affected scene does not belong to this project.');
    }
    if (input.affectedSectionId) {
      const section = this.db.raw.prepare(`
        SELECT 1 FROM narration_sections WHERE id = ? AND project_id = ?
      `).get(input.affectedSectionId, input.projectId);
      if (!section) throw new Error('The affected narration section does not belong to this project.');
    }
    if (input.category === 'voice_pronunciation' && (!input.affectedSceneId || !input.pronunciation)) {
      throw new Error('A voice-pronunciation revision requires an affected scene and a structured pronunciation override.');
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const automatic = input.category === 'voice_pronunciation' || input.category === 'script_factual_issue';
    this.db.raw.transaction(() => {
      if (input.category === 'voice_pronunciation' && input.affectedSceneId && input.pronunciation) {
        const row = this.db.raw.prepare(`SELECT pronunciation_json FROM project_scenes WHERE id = ?`).get(input.affectedSceneId) as {
          pronunciation_json: string;
        };
        let pronunciation: Record<string, string> = {};
        try {
          const parsed = JSON.parse(row.pronunciation_json);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) pronunciation = parsed as Record<string, string>;
        } catch {
          pronunciation = {};
        }
        pronunciation[input.pronunciation.term] = input.pronunciation.value;
        this.db.raw.prepare(`
          UPDATE project_scenes SET pronunciation_json = ?, updated_at = ? WHERE id = ?
        `).run(JSON.stringify(pronunciation), now, input.affectedSceneId);
        this.db.raw.prepare(`
          UPDATE narration_sections SET status = 'stale', updated_at = ?
          WHERE project_id = ? AND EXISTS (
            SELECT 1 FROM json_each(narration_sections.scene_ids_json) WHERE value = ?
          )
        `).run(now, input.projectId, input.affectedSceneId);
      }
      this.db.raw.prepare(`
        INSERT INTO revision_requests(
          id, project_id, category, note, affected_scene_id, affected_section_id,
          pronunciation_term, pronunciation_value, return_state, status, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.projectId,
        input.category,
        input.note,
        input.affectedSceneId ?? null,
        input.affectedSectionId ?? null,
        input.pronunciation?.term ?? null,
        input.pronunciation?.value ?? null,
        returnState,
        automatic ? 'in_progress' : 'requested',
        now
      );
      invalidatePublicationSnapshots(
        this.db,
        input.projectId,
        'A final-review revision changed the active publication snapshot. The prior upload must remain private.',
        'final_review_revision',
        now
      );
      if (input.category !== 'packaging') {
        this.db.raw.prepare(`
          UPDATE projects SET final_render_id = NULL, youtube_video_id = NULL, updated_at = ?
          WHERE id = ?
        `).run(now, input.projectId);
      }
      this.db.raw.prepare(`
        INSERT INTO audit_log(
          project_id, action, actor, entity_type, entity_id, after_json, metadata_json, created_at
        ) VALUES(?, 'final_review.revision_requested', 'human', 'revision_request', ?, ?, ?, ?)
      `).run(
        input.projectId,
        id,
        JSON.stringify({ category: input.category, returnState, status: automatic ? 'in_progress' : 'requested' }),
        JSON.stringify({ note: input.note, affectedSceneId: input.affectedSceneId ?? null, affectedSectionId: input.affectedSectionId ?? null }),
        now
      );
      this.projects.states.transition(input.projectId, returnState, {
        reason: `Final review returned the project for ${input.category.replaceAll('_', ' ')}`,
        prerequisites: { revisionRequestId: id, affectedSceneId: input.affectedSceneId ?? null }
      });
    })();
    return revisionFromRow(this.db.raw.prepare('SELECT * FROM revision_requests WHERE id = ?').get(id) as Record<string, unknown>);
  }

  completeAutomaticRevisions(projectId: string): number {
    const now = new Date().toISOString();
    return Number(this.db.raw.prepare(`
      UPDATE revision_requests SET status = 'completed', completed_at = ?
      WHERE project_id = ? AND status = 'in_progress'
    `).run(now, projectId).changes);
  }
}

export { REVISION_ROUTES };
