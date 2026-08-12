import { describe, expect, it } from 'vitest';
import { finalReviewGates } from '@main/services/final-review-service';

describe('final review release gates', () => {
  const readyArtifacts = {
    hasFinalRender: true,
    hasSelectedPackage: true,
    blockerCount: 0,
    state: 'WAITING_FINAL_APPROVAL' as const,
    hasYoutubeVideo: false,
    packageSynced: true,
    publicationReady: false
  };

  it('allows private upload after local artifacts and QC are ready', () => {
    expect(finalReviewGates(readyArtifacts)).toEqual({ canUpload: true, canApprove: false });
  });

  it('requires the exact processed upload package before publish approval', () => {
    expect(finalReviewGates({
      ...readyArtifacts,
      hasYoutubeVideo: true,
      publicationReady: true
    })).toEqual({ canUpload: true, canApprove: true });

    for (const blocked of [
      { blockerCount: 1 },
      { hasYoutubeVideo: false },
      { packageSynced: false },
      { publicationReady: false },
      { state: 'WAITING_YOUTUBE_PROCESSING' as const }
    ]) {
      expect(finalReviewGates({
        ...readyArtifacts,
        hasYoutubeVideo: true,
        publicationReady: true,
        ...blocked
      }).canApprove).toBe(false);
    }
  });
});
