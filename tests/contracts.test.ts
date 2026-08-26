import { describe, expect, it } from 'vitest';
import {
  CatalogSearchRequestSchema,
  CatalogRefreshSchema,
  AnalyticsSnapshotSchema,
  AmbiguousMappingResolveSchema,
  KeywordMetricObservationSchema,
  GoogleSheetsSyncSchema,
  JobExpediteSchema,
  JobRetryCapabilitySchema,
  JobRetrySchema,
  AcquisitionAttestSchema,
  AcquisitionBatchAttestSchema,
  CreateAutopilotProjectSchema,
  FinalReviewRevisionSchema,
  LearningRecommendationSchema,
  MusicImportSchema,
  StorageCleanupSchema,
  CatalogUpdateAssetSchema,
  PathChoiceRequestSchema,
  ProviderEndpointActionSchema,
  ProjectExportSchema,
  ProjectRebuildSchema,
  RenderRequestSchema,
  SemanticVerificationRetrySchema,
  StoryboardMergeBeatsSchema,
  StoryboardRejectCandidateSchema,
  StoryboardReplaceShotSchema,
  StoryboardRewriteBeatSchema,
  StoryboardSplitBeatSchema,
  StoryboardUseGraphicSchema,
  StoryboardVerifyLocationSchema,
  SettingsPatchSchema,
  YouTubeAuthorizationCancellationSchema,
  YouTubeAuthorizationConfirmationSchema
} from '@shared/contracts';

describe('IPC request contracts', () => {
  it('rejects unknown settings keys and unsafe policy values', () => {
    expect(SettingsPatchSchema.safeParse({ maxActiveProjects: 3 }).success).toBe(true);
    expect(SettingsPatchSchema.safeParse({ maxActiveProjects: 0 }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ backupIntervalHours: 24, backupDailyRetention: 7 }).success).toBe(true);
    expect(SettingsPatchSchema.safeParse({ backupIntervalHours: 0 }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ visionProvider: 'openai_compatible', visionMinimumConfidence: 0.82 }).success).toBe(true);
    expect(SettingsPatchSchema.safeParse({ visionMinimumConfidence: 0.2 }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ researchProvider: 'tavily', researchMaxResultsPerQuery: 5, projectBudgetUsd: 15 }).success).toBe(true);
    expect(SettingsPatchSchema.safeParse({ researchMaxResultsPerQuery: 50 }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ arbitrarySql: 'DROP TABLE assets' }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ ffmpegPath: '/tmp/ffmpeg' }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ ffprobePath: '/tmp/ffprobe' }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ youtubePrivacy: 'public' }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ catalogRefreshEnabled: true, catalogRefreshIntervalHours: 24, updateChannel: 'stable' }).success).toBe(true);
    expect(SettingsPatchSchema.safeParse({ catalogRefreshIntervalHours: 0, updateChannel: 'nightly' }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ autopilotSchedulerEnabled: true, autopilotCadenceDays: 7, autopilotPublicationHourUtc: 17 }).success).toBe(true);
    expect(SettingsPatchSchema.safeParse({ autopilotCadenceDays: 0, autopilotPublicationHourUtc: 24 }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ musicEnabled: true, musicTargetGainDb: -24, musicDuckingDb: -12, automaticDerivativeCleanup: true, derivativeCleanupTargetGb: 5 }).success).toBe(true);
    expect(SettingsPatchSchema.safeParse({ musicTargetGainDb: 0, derivativeCleanupTargetGb: 0 }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ llmEndpointTrust: 'custom_local', researchEndpointTrust: 'managed' }).success).toBe(true);
    expect(SettingsPatchSchema.safeParse({ visionEndpointTrust: 'trust_everything' }).success).toBe(false);
    expect(ProviderEndpointActionSchema.safeParse({ provider: 'tavily' }).success).toBe(true);
    expect(ProviderEndpointActionSchema.safeParse({ provider: 'youtube', apiKey: 'secret' }).success).toBe(false);
  });

  it('requires explicit music licensing and bounded cleanup requests', () => {
    expect(MusicImportSchema.safeParse({
      title: 'Licensed bed', provider: 'Fixture', licenseType: 'project',
      licenseReference: 'receipt-1', moods: ['warm'], loopable: true, licenseAttested: true
    }).success).toBe(true);
    expect(MusicImportSchema.safeParse({
      title: 'Unlicensed bed', provider: 'Fixture', licenseType: 'unknown',
      licenseReference: '', licenseAttested: false
    }).success).toBe(false);
    expect(StorageCleanupSchema.safeParse({ dryRun: true, trigger: 'manual' }).success).toBe(true);
    expect(StorageCleanupSchema.safeParse({ recursiveDelete: true }).success).toBe(false);
  });

  it('requires exact pending and channel identities for YouTube confirmation or cancellation', () => {
    expect(YouTubeAuthorizationConfirmationSchema.safeParse({
      pendingAuthorizationId: 'pending-1', expectedChannelId: 'UC-exact', replaceExisting: false
    }).success).toBe(true);
    expect(YouTubeAuthorizationConfirmationSchema.safeParse({
      pendingAuthorizationId: 'pending-1', expectedChannelId: 'UC-exact', replaceExisting: false,
      refreshToken: 'renderer-must-not-send-this'
    }).success).toBe(false);
    expect(YouTubeAuthorizationConfirmationSchema.safeParse({
      pendingAuthorizationId: '', expectedChannelId: 'UC-exact', replaceExisting: true
    }).success).toBe(false);
    expect(YouTubeAuthorizationCancellationSchema.safeParse({ pendingAuthorizationId: 'pending-1' }).success)
      .toBe(true);
    expect(YouTubeAuthorizationCancellationSchema.safeParse({ pendingAuthorizationId: 'pending-1', force: true }).success)
      .toBe(false);
  });

  it('[JOB-011] requires exact retry state/version contracts even when renderer controls are bypassed', () => {
    expect(JobRetryCapabilitySchema.safeParse({ jobId: 'job-1' }).success).toBe(true);
    expect(JobRetryCapabilitySchema.safeParse({ jobId: 'job-1', force: true }).success).toBe(false);
    expect(JobRetrySchema.safeParse({
      jobId: 'job-1', expectedState: 'FAILED_RETRYABLE', expectedVersion: 4
    }).success).toBe(true);
    expect(JobRetrySchema.safeParse({ jobId: 'job-1' }).success).toBe(false);
    expect(JobRetrySchema.safeParse({
      jobId: 'job-1', expectedState: 'RUNNING', expectedVersion: -1, force: true
    }).success).toBe(false);
    expect(JobExpediteSchema.safeParse({ jobId: 'job-1', expectedVersion: 4 }).success).toBe(true);
    expect(JobExpediteSchema.safeParse({
      jobId: 'job-1', expectedVersion: 4, expectedState: 'FAILED_RETRYABLE'
    }).success).toBe(false);
  });

  it('bounds analytics snapshots and evidence-gated learning requests', () => {
    const snapshot = {
      projectId: 'p1', videoId: 'video-1', snapshotDay: 7,
      capturedAt: '2026-08-12T12:00:00.000Z', source: 'manual_import',
      metrics: {
        views: 1000, impressions: 5000, clickThroughRate: 0.1, watchTimeMinutes: 2500,
        averageViewDurationSeconds: 150, averagePercentageViewed: 0.5, subscribersGained: 20,
        trafficSources: { search: 500 }, searchTerms: { oaxaca: 100 }, playlistStarts: 10, endScreenClicks: 20
      },
      retention: [{ elapsedRatio: 0.5, audienceWatchRatio: 0.6, relativeRetention: 0.1 }]
    };
    expect(AnalyticsSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(AnalyticsSnapshotSchema.safeParse({ ...snapshot, snapshotDay: 2 }).success).toBe(false);
    expect(LearningRecommendationSchema.safeParse({ metricKey: 'preferredShotMaxSeconds', proposedValue: 5, rationale: 'Repeated evidence across qualified publications supports this bounded adjustment.', evidenceSnapshotIds: ['a', 'b'] }).success).toBe(true);
    expect(LearningRecommendationSchema.safeParse({ metricKey: 'arbitraryPolicy', proposedValue: 99, rationale: 'too short', evidenceSnapshotIds: ['a'] }).success).toBe(false);
  });

  it('preserves truthful keyword labels and bounded expansion requests', () => {
    const metric = {
      keyword: 'oaxaca travel', provider: 'Google Search', metricType: 'monthly search volume',
      value: 1200, geographyCode: 'US', languageCode: 'en',
      collectedAt: '2026-08-12T12:00:00.000Z', confidence: 0.8,
      youtubeNative: false, rawMetadata: {}
    };
    expect(KeywordMetricObservationSchema.safeParse(metric).success).toBe(true);
    expect(KeywordMetricObservationSchema.safeParse({ ...metric, youtubeNative: true }).success).toBe(false);
    expect(GoogleSheetsSyncSchema.safeParse({
      spreadsheetId: 'sheet-12345', sheetRange: 'Catalog!A:Z', operationId: 'sheet-operation-1'
    }).success).toBe(true);
    expect(GoogleSheetsSyncSchema.safeParse({ spreadsheetId: '', sheetRange: '', write: true }).success).toBe(false);
    expect(CreateAutopilotProjectSchema.safeParse({
      channelId: 'channel-default', languageVoiceProfileId: 'language-en-default', outputProfileKey: 'vertical_1080p'
    }).success).toBe(true);
    expect(CreateAutopilotProjectSchema.safeParse({
      destinationKey: 'france|paris', targetMinutes: 8,
      startingScript: 'Open cinematically, move briskly, and close on a reflective view.'
    }).success).toBe(true);
    expect(CreateAutopilotProjectSchema.safeParse({ startingScript: 'x'.repeat(20_001) }).success).toBe(false);
    expect(CreateAutopilotProjectSchema.safeParse({ startingScript: '   ' }).success).toBe(false);
    expect(CreateAutopilotProjectSchema.safeParse({ outputProfileKey: '8k', forcePublish: true }).success).toBe(false);
  });

  it('bounds catalog refresh requests', () => {
    expect(CatalogRefreshSchema.safeParse({ sourcePath: '/data/catalog.xlsx', templateId: 'envato-default' }).success).toBe(true);
    expect(CatalogRefreshSchema.safeParse({ sourcePath: '', forceCommit: true }).success).toBe(false);
  });

  it('rejects unknown asset patch fields and out-of-range confidence', () => {
    expect(CatalogUpdateAssetSchema.safeParse({ assetId: 'a', patch: { city: 'Paris', locationConfidence: 0.9 } }).success).toBe(true);
    expect(CatalogUpdateAssetSchema.safeParse({ assetId: 'a', patch: { stableKey: 'hijack' } }).success).toBe(false);
    expect(CatalogUpdateAssetSchema.safeParse({ assetId: 'a', patch: { locationConfidence: 4 } }).success).toBe(false);
  });

  it('pairs bounded metadata field filters and rejects unpaired values', () => {
    expect(CatalogSearchRequestSchema.safeParse({
      metadataField: 'objects', metadataValue: 'tram', page: 1, pageSize: 50
    }).success).toBe(true);
    expect(CatalogSearchRequestSchema.safeParse({
      metadataField: 'objects', page: 1, pageSize: 50
    }).success).toBe(false);
    expect(CatalogSearchRequestSchema.safeParse({
      metadataField: 'stableKey', metadataValue: 'x', page: 1, pageSize: 50
    }).success).toBe(false);
  });

  it('bounds file-picker filters', () => {
    expect(PathChoiceRequestSchema.safeParse({ kind: 'file', filters: [{ name: 'Video', extensions: ['mp4'] }] }).success).toBe(true);
    expect(PathChoiceRequestSchema.safeParse({ kind: 'shell', command: 'calc.exe' }).success).toBe(false);
  });

  it('keeps license certificates behind a main-process picker', () => {
    expect(AcquisitionAttestSchema.safeParse({ acquisitionId: 'acquisition-1' }).success).toBe(true);
    expect(AcquisitionAttestSchema.safeParse({
      acquisitionId: 'acquisition-1', attachCertificate: true
    }).success).toBe(true);
    expect(AcquisitionBatchAttestSchema.safeParse({
      projectId: 'project-1', attachCertificate: true
    }).success).toBe(true);
    expect(AcquisitionBatchAttestSchema.safeParse({
      projectId: 'project-1', certificatePath: '/untrusted/path.pdf'
    }).success).toBe(false);
    expect(AcquisitionBatchAttestSchema.safeParse({ projectId: '' }).success).toBe(false);
  });

  it('accepts only a bounded semantic retry exception identifier', () => {
    expect(SemanticVerificationRetrySchema.safeParse({ exceptionId: 'exception-1' }).success).toBe(true);
    expect(SemanticVerificationRetrySchema.safeParse({ exceptionId: '' }).success).toBe(false);
    expect(SemanticVerificationRetrySchema.safeParse({ exceptionId: 'exception-1', force: true }).success).toBe(false);
  });

  it('requires bounded identifiers for mapping recovery and structured pronunciation revisions', () => {
    expect(AmbiguousMappingResolveSchema.safeParse({
      exceptionId: 'exception-1', acquisitionId: 'acquisition-1'
    }).success).toBe(true);
    expect(AmbiguousMappingResolveSchema.safeParse({
      exceptionId: 'exception-1', acquisitionId: '', force: true
    }).success).toBe(false);
    expect(FinalReviewRevisionSchema.safeParse({
      projectId: 'project-1', category: 'voice_pronunciation', note: 'Correct Oaxaca',
      affectedSceneId: 'scene-1', pronunciation: { term: 'Oaxaca', value: 'wah-HAH-kah' }
    }).success).toBe(true);
    expect(FinalReviewRevisionSchema.safeParse({
      projectId: 'project-1', category: 'voice_pronunciation', note: 'Correct Oaxaca'
    }).success).toBe(false);
  });

  it('accepts bounded range renders without leaking range fields into full renders', () => {
    expect(RenderRequestSchema.safeParse({ projectId: 'p1', kind: 'range', startSceneOrdinal: 3, endSceneOrdinal: 5 }).success).toBe(true);
    expect(RenderRequestSchema.safeParse({ projectId: 'p1', kind: 'range' }).success).toBe(false);
    expect(RenderRequestSchema.safeParse({ projectId: 'p1', kind: 'range', startSceneOrdinal: 5, endSceneOrdinal: 3 }).success).toBe(false);
    expect(RenderRequestSchema.safeParse({ projectId: 'p1', kind: 'final', startSceneOrdinal: 1 }).success).toBe(false);
    expect(RenderRequestSchema.safeParse({ projectId: 'p1', kind: 'final', outputProfileKey: 'vertical_1080p' }).success).toBe(true);
    expect(RenderRequestSchema.safeParse({ projectId: 'p1', kind: 'final', outputProfileKey: 'square_8k' }).success).toBe(false);
  });

  it('strictly bounds every storyboard recovery mutation', () => {
    const base = { projectId: 'project-1', sceneId: 'scene-1', reason: 'Operator reviewed the evidence.' };
    expect(StoryboardReplaceShotSchema.safeParse({ ...base, candidateId: 'candidate-2' }).success).toBe(true);
    expect(StoryboardReplaceShotSchema.safeParse({ ...base, candidateId: 'candidate-2', force: true }).success).toBe(false);
    expect(StoryboardRewriteBeatSchema.safeParse({ ...base, narration: 'A narrower evidence-backed line.' }).success).toBe(true);
    expect(StoryboardRewriteBeatSchema.safeParse({ ...base, narration: '' }).success).toBe(false);
    expect(StoryboardUseGraphicSchema.safeParse({ ...base, treatment: 'MAP_OR_GRAPHIC' }).success).toBe(true);
    expect(StoryboardUseGraphicSchema.safeParse({ ...base, treatment: 'GENERIC_STOCK' }).success).toBe(false);
    expect(StoryboardSplitBeatSchema.safeParse({
      ...base,
      firstNarration: 'First idea.',
      secondNarration: 'Second idea.',
      secondTreatment: 'TEXT_OR_ARCHIVAL'
    }).success).toBe(true);
    expect(StoryboardMergeBeatsSchema.safeParse({
      projectId: 'project-1', firstSceneId: 'scene-1', secondSceneId: 'scene-2',
      narration: 'Merged idea.', reason: base.reason
    }).success).toBe(true);
    expect(StoryboardMergeBeatsSchema.safeParse({
      projectId: 'project-1', firstSceneId: 'scene-1', secondSceneId: 'scene-1',
      narration: 'Merged idea.', reason: base.reason
    }).success).toBe(false);
    expect(StoryboardVerifyLocationSchema.safeParse(base).success).toBe(true);
    expect(StoryboardRejectCandidateSchema.safeParse({ ...base, candidateId: '' }).success).toBe(false);
  });

  it('bounds project portability actions', () => {
    expect(ProjectExportSchema.safeParse({ projectId: 'p1', includeOriginals: true, includeFinalOutput: false }).success).toBe(true);
    expect(ProjectExportSchema.safeParse({ projectId: 'p1', arbitraryPath: '/tmp' }).success).toBe(false);
    expect(ProjectRebuildSchema.safeParse({ projectId: 'p1' }).success).toBe(true);
    expect(ProjectRebuildSchema.safeParse({ projectId: '' }).success).toBe(false);
  });
});
