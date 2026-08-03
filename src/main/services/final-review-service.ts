import type { FinalReview } from '@shared/types';
import type { ProjectService } from './project-service';

export class FinalReviewService {
  constructor(private readonly projects: ProjectService) {}

  get(projectId: string): FinalReview {
    const project = this.projects.get(projectId);
    const selectedPackage = project.packaging.find(candidate => candidate.selected)
      ?? project.packaging[0]
      ?? null;
    const finalRender = project.renders.find(render => render.kind === 'final' && render.state === 'SUCCEEDED');
    const relevantQc = finalRender
      ? project.qc.filter(item => item.renderId === finalRender.id)
      : project.qc;
    const blockers = relevantQc.filter(item => item.status === 'fail' && item.severity === 'BLOCKER');
    const warnings = relevantQc.filter(item => item.status === 'warning' || (item.status === 'fail' && item.severity !== 'BLOCKER'));
    return {
      project,
      selectedPackage,
      privateVideoUrl: project.youtubeVideoId
        ? `https://www.youtube.com/watch?v=${project.youtubeVideoId}`
        : null,
      localPreviewUrl: finalRender?.id ? `videofactory://render/${finalRender.id}` : null,
      blockers,
      warnings,
      canApprove: Boolean(finalRender && selectedPackage && blockers.length === 0)
    };
  }
}
