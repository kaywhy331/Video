import type { FinalReview } from '@shared/types';
import type { ProjectService } from './project-service';
import type { AppDatabase } from '../database/database';
import { approvalFingerprint } from '@shared/approval';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
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
      && ['WAITING_FINAL_APPROVAL', 'WAITING_YOUTUBE_PROCESSING', 'UPLOADING_PRIVATE'].includes(input.state),
    canApprove: artifactsReady
      && input.hasYoutubeVideo
      && input.packageSynced
      && input.publicationReady
      && input.state === 'WAITING_FINAL_APPROVAL'
  };
}

export class FinalReviewService {
  constructor(private readonly db: AppDatabase, private readonly projects: ProjectService) {}

  get(projectId: string): FinalReview {
    const project = this.projects.get(projectId);
    const selectedPackage = project.packaging.find(candidate => candidate.selected)
      ?? project.packaging[0]
      ?? null;
    const finalRender = project.renders.find(render => render.kind === 'final' && render.state === 'SUCCEEDED');
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
      SELECT approval_hash, processing_status, caption_id, thumbnail_uploaded
      FROM publication_records
      WHERE project_id = ? AND video_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(projectId, project.youtubeVideoId) as {
      approval_hash: string | null;
      processing_status: string | null;
      caption_id: string | null;
      thumbnail_uploaded: number;
    } | undefined;
    const publicationReady = Boolean(
      publication?.processing_status === 'succeeded'
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
      hasSelectedPackage: Boolean(selectedPackage),
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
      localPreviewUrl: finalRender?.id ? `videofactory://render/${finalRender.id}` : null,
      blockers,
      warnings,
      packageSynced,
      ...gates
    };
  }
}
