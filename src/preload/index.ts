import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '@shared/ipc-channels';
import type {
  AppBootstrap,
  AppStateSnapshot,
  AppSettings,
  AmbiguousFileMappingRecovery,
  AmbiguousFileMappingResolution,
  AnalyticsSnapshot,
  AnalyticsCollectionRun,
  AnalyticsMetrics,
  RetentionPointInput,
  BackupRecord,
  CatalogAsset,
  CatalogImportPreview,
  CatalogImportResult,
  CatalogRefreshRun,
  CatalogValidationTemplate,
  CatalogExportReport,
  CatalogSearchRequest,
  CatalogSearchResult,
  CatalogStats,
  CanonicalPlace,
  CoverageCluster,
  CreateAutopilotProjectRequest,
  DiagnosticsReport,
  ExceptionRecord,
  FinalReview,
  FinalReviewRevisionRequest,
  FourKBlocker,
  JobRecord,
  LearningRecommendation,
  MusicTrack,
  ProjectMusicSelection,
  MetadataRevision,
  MetadataAssertion,
  ProgressEvent,
  PublicationApprovalResult,
  ProjectDetail,
  ProjectExportReport,
  ProjectSummary,
  RevisionRequestRecord,
  RenderRecord,
  RestoreReport,
  DerivativeRebuildReport,
  SemanticVerificationRetryResult,
  SecretStatus,
  SchedulerStatus,
  SettingsProfileReport,
  StoryboardMutationResult,
  StoryboardRecoveryScene,
  StorageCleanupReport,
  UpdateCheckResult,
  YouTubeConnectionStatus,
  ExpansionRegistrySnapshot,
  ChannelProfile,
  LanguageVoiceProfile,
  KeywordMetricObservation,
  OpportunityAssessment,
  GoogleSheetsSyncRun,
  CatalogImportOperationStatus
} from '@shared/types';

const api = {
  app: {
    bootstrap: (): Promise<AppBootstrap> => ipcRenderer.invoke(IPC.bootstrap),
    onProgress: (listener: (event: ProgressEvent) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, value: ProgressEvent): void => listener(value);
      ipcRenderer.on(IPC.progressEvent, handler);
      return () => ipcRenderer.removeListener(IPC.progressEvent, handler);
    },
    onState: (listener: (value: AppStateSnapshot) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, value: AppStateSnapshot): void => listener(value);
      ipcRenderer.on(IPC.stateEvent, handler);
      return () => ipcRenderer.removeListener(IPC.stateEvent, handler);
    }
  },
  diagnostics: {
    run: (): Promise<DiagnosticsReport> => ipcRenderer.invoke(IPC.diagnosticsRun)
  },
  backups: {
    create: (): Promise<BackupRecord> => ipcRenderer.invoke(IPC.backupCreate),
    list: (): Promise<BackupRecord[]> => ipcRenderer.invoke(IPC.backupList),
    restore: (path?: string): Promise<RestoreReport | null> => ipcRenderer.invoke(IPC.backupRestore, path)
  },
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.settingsGet),
    update: (patch: Partial<AppSettings>): Promise<AppSettings> => ipcRenderer.invoke(IPC.settingsUpdate, patch),
    updateSecrets: (patch: Record<string, string | undefined>): Promise<SecretStatus> =>
      ipcRenderer.invoke(IPC.secretsUpdate, patch),
    exportProfile: (path?: string): Promise<SettingsProfileReport | null> =>
      ipcRenderer.invoke(IPC.settingsProfileExport, path),
    importProfile: (path?: string): Promise<SettingsProfileReport | null> =>
      ipcRenderer.invoke(IPC.settingsProfileImport, path),
    choosePath: (request: { kind: 'directory' | 'file'; title?: string; filters?: Electron.FileFilter[] }): Promise<string | null> =>
      ipcRenderer.invoke(IPC.pathsChoose, request)
  },
  updates: {
    check: (): Promise<UpdateCheckResult> => ipcRenderer.invoke(IPC.appCheckUpdate)
  },
  scheduler: {
    status: (): Promise<SchedulerStatus> => ipcRenderer.invoke(IPC.schedulerStatus),
    evaluate: (): Promise<SchedulerStatus> => ipcRenderer.invoke(IPC.schedulerEvaluate)
  },
  catalog: {
    chooseImport: (operationId?: string): Promise<CatalogImportPreview | null> => ipcRenderer.invoke(IPC.catalogChooseImport, operationId),
    previewImport: (request: { filePath: string; sheetName?: string; mapping?: Record<string, string | null>; operationId?: string }): Promise<CatalogImportPreview> =>
      ipcRenderer.invoke(IPC.catalogPreviewImport, request),
    cancelImport: (previewId: string): Promise<boolean> => ipcRenderer.invoke(IPC.catalogCancelImport, previewId),
    cancelOperation: (operationId: string): Promise<boolean> => ipcRenderer.invoke(IPC.catalogCancelOperation, operationId),
    importStatus: (): Promise<CatalogImportOperationStatus | null> => ipcRenderer.invoke(IPC.catalogImportStatus),
    ping: (): Promise<{ receivedAt: number; activeOperation: CatalogImportOperationStatus | null }> => ipcRenderer.invoke(IPC.catalogPing),
    commitImport: (request: {
      filePath: string;
      sheetName?: string;
      mapping?: Record<string, string | null>;
      previewId: string;
      operationId?: string;
    }): Promise<CatalogImportResult> => ipcRenderer.invoke(IPC.catalogCommitImport, request),
    search: (request: CatalogSearchRequest): Promise<CatalogSearchResult> =>
      ipcRenderer.invoke(IPC.catalogSearch, request),
    stats: (): Promise<CatalogStats> => ipcRenderer.invoke(IPC.catalogStats),
    coverage: (limit = 100): Promise<CoverageCluster[]> => ipcRenderer.invoke(IPC.catalogCoverage, limit),
    validationTemplates: (): Promise<CatalogValidationTemplate[]> => ipcRenderer.invoke(IPC.catalogValidationTemplates),
    latestRefresh: (): Promise<CatalogRefreshRun | null> => ipcRenderer.invoke(IPC.catalogRefreshLatest),
    refresh: (request?: { sourcePath?: string; templateId?: string }): Promise<CatalogRefreshRun> =>
      ipcRenderer.invoke(IPC.catalogRefreshRun, request ?? {}),
    updateAsset: (request: {
      assetId: string;
      patch: Record<string, unknown>;
      reason?: string;
    }) => ipcRenderer.invoke(IPC.catalogUpdateAsset, request),
    bulkUpdate: (request: {
      assetIds: string[];
      patch: Record<string, unknown>;
      reason?: string;
    }): Promise<CatalogAsset[]> => ipcRenderer.invoke(IPC.catalogBulkUpdate, request),
    metadataAssertions: (assetId: string): Promise<MetadataAssertion[]> =>
      ipcRenderer.invoke(IPC.catalogMetadataAssertions, assetId),
    metadataInbox: (limit = 500): Promise<MetadataAssertion[]> =>
      ipcRenderer.invoke(IPC.catalogMetadataInbox, limit),
    suggestMetadata: (request: {
      assetId: string;
      fieldName: string;
      value: unknown;
      provider: string;
      model: string;
      confidence: number;
      evidenceRef?: string | null;
      evidence?: Record<string, unknown>;
    }): Promise<MetadataAssertion> => ipcRenderer.invoke(IPC.catalogSuggestMetadata, request),
    reviewSuggestion: (assertionId: string, decision: 'accept' | 'reject'): Promise<MetadataAssertion> =>
      ipcRenderer.invoke(IPC.catalogReviewSuggestion, { assertionId, decision }),
    exportFiltered: (request: CatalogSearchRequest, outputPath?: string): Promise<CatalogExportReport | null> =>
      ipcRenderer.invoke(IPC.catalogExportFiltered, { request, outputPath }),
    revisions: (assetId: string): Promise<MetadataRevision[]> => ipcRenderer.invoke(IPC.catalogRevisions, assetId),
    revertRevision: (revisionId: string) => ipcRenderer.invoke(IPC.catalogRevertRevision, revisionId)
  },
  analytics: {
    list: (projectId?: string): Promise<AnalyticsSnapshot[]> => ipcRenderer.invoke(IPC.analyticsList, projectId),
    importSnapshot: (request: {
      projectId: string;
      videoId: string;
      snapshotDay: 1 | 3 | 7 | 28 | 90;
      capturedAt: string;
      source: 'youtube_api' | 'manual_import';
      metrics: AnalyticsMetrics;
      retention: RetentionPointInput[];
    }): Promise<AnalyticsSnapshot> => ipcRenderer.invoke(IPC.analyticsImport, request),
    collect: (projectId: string, snapshotDay: 1 | 3 | 7 | 28 | 90): Promise<AnalyticsSnapshot> =>
      ipcRenderer.invoke(IPC.analyticsCollect, { projectId, snapshotDay }),
    collectionRuns: (projectId?: string): Promise<AnalyticsCollectionRun[]> =>
      ipcRenderer.invoke(IPC.analyticsCollectionRuns, projectId),
    recommendations: (): Promise<LearningRecommendation[]> => ipcRenderer.invoke(IPC.learningList),
    propose: (request: {
      metricKey: 'preferredShotMinSeconds' | 'preferredShotMaxSeconds' | 'targetVideoMinutes';
      proposedValue: number;
      rationale: string;
      evidenceSnapshotIds: string[];
    }): Promise<LearningRecommendation> => ipcRenderer.invoke(IPC.learningPropose, request),
    decide: (id: string, decision: 'apply' | 'reject' | 'rollback'): Promise<LearningRecommendation> =>
      ipcRenderer.invoke(IPC.learningDecide, { id, decision })
  },
  music: {
    list: (): Promise<MusicTrack[]> => ipcRenderer.invoke(IPC.musicList),
    selection: (projectId: string): Promise<ProjectMusicSelection | null> =>
      ipcRenderer.invoke(IPC.musicSelection, projectId),
    import: (request: {
      filePath?: string;
      title: string;
      provider: string;
      licenseType: string;
      licenseReference: string;
      licenseDocumentPath?: string;
      moods?: string[];
      tempoBpm?: number | null;
      loopable?: boolean;
      licenseAttested: true;
    }): Promise<MusicTrack | null> => ipcRenderer.invoke(IPC.musicImport, request),
    select: (projectId: string, trackId: string, selectedBy: 'automatic' | 'human' = 'human'): Promise<ProjectMusicSelection> =>
      ipcRenderer.invoke(IPC.musicSelect, { projectId, trackId, selectedBy })
  },
  storage: {
    cleanup: (request?: { dryRun?: boolean; trigger?: 'manual' | 'disk_pressure' | 'startup' }): Promise<StorageCleanupReport> =>
      ipcRenderer.invoke(IPC.storageCleanup, request ?? {}),
    latest: (): Promise<StorageCleanupReport | null> => ipcRenderer.invoke(IPC.storageCleanupLatest)
  },
  expansion: {
    registry: (): Promise<ExpansionRegistrySnapshot> => ipcRenderer.invoke(IPC.expansionRegistry),
    saveChannel: (request: {
      id?: string;
      name: string;
      shortCode: string;
      defaultLanguageCode: string;
      defaultVoiceId?: string | null;
      youtubeChannelId?: string | null;
      youtubeChannelTitle?: string | null;
      active?: boolean;
      isDefault?: boolean;
      policy?: Record<string, unknown>;
    }): Promise<ChannelProfile> => ipcRenderer.invoke(IPC.expansionSaveChannel, request),
    saveLanguage: (request: {
      id?: string;
      languageCode: string;
      languageName: string;
      voiceProvider: string;
      voiceId: string;
      displayName: string;
      active?: boolean;
      isDefault?: boolean;
      settings?: Record<string, unknown>;
    }): Promise<LanguageVoiceProfile> => ipcRenderer.invoke(IPC.expansionSaveLanguage, request),
    keywordMetrics: (topicCandidateId?: string): Promise<KeywordMetricObservation[]> =>
      ipcRenderer.invoke(IPC.keywordMetricsList, topicCandidateId),
    importKeywordMetric: (request: {
      topicCandidateId?: string;
      keyword: string;
      provider: string;
      metricType: string;
      value: number | null;
      geographyCode?: string | null;
      languageCode: string;
      collectedAt: string;
      confidence: number;
      youtubeNative: boolean;
      rawMetadata?: Record<string, unknown>;
    }): Promise<KeywordMetricObservation> => ipcRenderer.invoke(IPC.keywordMetricsImport, request),
    opportunities: (limit = 100): Promise<OpportunityAssessment[]> =>
      ipcRenderer.invoke(IPC.opportunityList, limit),
    stageGoogleSheet: (request: {
      configId?: string;
      name?: string;
      spreadsheetId: string;
      sheetRange: string;
      validationTemplateId?: string;
      operationId?: string;
    }): Promise<GoogleSheetsSyncRun> => ipcRenderer.invoke(IPC.googleSheetsSync, request),
    googleSheetsRuns: (): Promise<GoogleSheetsSyncRun[]> => ipcRenderer.invoke(IPC.googleSheetsRuns)
    ,googleSheetsPreview: (previewId: string): Promise<CatalogImportPreview> =>
      ipcRenderer.invoke(IPC.googleSheetsPreview, previewId)
  },
  places: {
    list: (query?: string): Promise<CanonicalPlace[]> => ipcRenderer.invoke(IPC.placesList, query),
    merge: (request: { sourcePlaceIds: string[]; targetPlaceId: string; reason: string }) =>
      ipcRenderer.invoke(IPC.placesMerge, request) as Promise<CanonicalPlace>,
    split: (request: {
      sourcePlaceId: string;
      assetIds: string[];
      name: string;
      type: 'country' | 'region' | 'city' | 'neighborhood' | 'landmark' | 'feature';
      parentId: string | null;
      latitude?: number | null;
      longitude?: number | null;
      aliases?: string[];
      reason: string;
    }): Promise<CanonicalPlace> => ipcRenderer.invoke(IPC.placesSplit, request)
  },
  projects: {
    list: (): Promise<ProjectSummary[]> => ipcRenderer.invoke(IPC.projectsList),
    get: (projectId: string): Promise<ProjectDetail> => ipcRenderer.invoke(IPC.projectGet, projectId),
    createAutopilot: (request: CreateAutopilotProjectRequest): Promise<ProjectDetail> =>
      ipcRenderer.invoke(IPC.projectCreateAutopilot, request),
    advance: (projectId: string) => ipcRenderer.invoke(IPC.projectAdvance, projectId),
    pause: (projectId: string): Promise<ProjectDetail> => ipcRenderer.invoke(IPC.projectPause, projectId),
    resume: (projectId: string): Promise<ProjectDetail> => ipcRenderer.invoke(IPC.projectResume, projectId),
    cancel: (projectId: string): Promise<ProjectDetail> => ipcRenderer.invoke(IPC.projectCancel, projectId),
    archive: (projectId: string): Promise<ProjectDetail> => ipcRenderer.invoke(IPC.projectArchive, projectId),
    export: (request: {
      projectId: string;
      destinationPath?: string;
      includeOriginals?: boolean;
      includeFinalOutput?: boolean;
    }): Promise<ProjectExportReport | null> => ipcRenderer.invoke(IPC.projectExport, request),
    rebuildDerivatives: (projectId: string): Promise<DerivativeRebuildReport> =>
      ipcRenderer.invoke(IPC.projectRebuildDerivatives, { projectId }),
    remove: (projectId: string): Promise<boolean> => ipcRenderer.invoke(IPC.projectDelete, projectId)
  },
  acquisitions: {
    list: (projectId?: string) => ipcRenderer.invoke(IPC.acquisitionList, projectId),
    activate: (id: string) => ipcRenderer.invoke(IPC.acquisitionActivate, id),
    open: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.acquisitionOpen, id),
    attest: (request: { acquisitionId: string; attachCertificate?: boolean }): Promise<import('@shared/types').AcquisitionItem | null> =>
      ipcRenderer.invoke(IPC.acquisitionAttest, request),
    attestProject: (request: { projectId: string; attachCertificate?: boolean }): Promise<import('@shared/types').AcquisitionItem[] | null> =>
      ipcRenderer.invoke(IPC.acquisitionBatchAttest, request),
    mapFile: (request: { acquisitionId: string; filePath?: string }): Promise<boolean> =>
      ipcRenderer.invoke(IPC.acquisitionMapFile, request)
  },
  storyboard: {
    get: (projectId: string, sceneId: string): Promise<StoryboardRecoveryScene> =>
      ipcRenderer.invoke(IPC.storyboardGet, { projectId, sceneId }),
    replaceShot: (request: {
      projectId: string;
      sceneId: string;
      candidateId: string;
      reason: string;
    }): Promise<StoryboardMutationResult> => ipcRenderer.invoke(IPC.storyboardReplaceShot, request),
    rewriteBeat: (request: {
      projectId: string;
      sceneId: string;
      narration: string;
      reason: string;
    }): Promise<StoryboardMutationResult> => ipcRenderer.invoke(IPC.storyboardRewriteBeat, request),
    useGraphic: (request: {
      projectId: string;
      sceneId: string;
      treatment: 'MAP_OR_GRAPHIC' | 'TEXT_OR_ARCHIVAL';
      reason: string;
    }): Promise<StoryboardMutationResult> => ipcRenderer.invoke(IPC.storyboardUseGraphic, request),
    splitBeat: (request: {
      projectId: string;
      sceneId: string;
      firstNarration: string;
      secondNarration: string;
      secondTreatment: 'MAP_OR_GRAPHIC' | 'TEXT_OR_ARCHIVAL';
      reason: string;
    }): Promise<StoryboardMutationResult> => ipcRenderer.invoke(IPC.storyboardSplitBeat, request),
    mergeBeats: (request: {
      projectId: string;
      firstSceneId: string;
      secondSceneId: string;
      narration: string;
      graphicTreatment?: 'MAP_OR_GRAPHIC' | 'TEXT_OR_ARCHIVAL';
      reason: string;
    }): Promise<StoryboardMutationResult> => ipcRenderer.invoke(IPC.storyboardMergeBeats, request),
    verifyLocation: (request: {
      projectId: string;
      sceneId: string;
      reason: string;
    }): Promise<StoryboardMutationResult> => ipcRenderer.invoke(IPC.storyboardVerifyLocation, request),
    rejectCandidate: (request: {
      projectId: string;
      sceneId: string;
      candidateId: string;
      reason: string;
    }): Promise<StoryboardMutationResult> => ipcRenderer.invoke(IPC.storyboardRejectCandidate, request)
  },
  renders: {
    start: (request: {
      projectId: string;
      kind: 'range' | 'draft' | 'final';
      startSceneOrdinal?: number;
      endSceneOrdinal?: number;
      outputProfileKey?: 'landscape_1080p' | 'landscape_4k' | 'vertical_1080p';
    }): Promise<RenderRecord> =>
      ipcRenderer.invoke(IPC.renderStart, request),
    fourKBlockers: (projectId: string): Promise<FourKBlocker[]> =>
      ipcRenderer.invoke(IPC.renderFourKBlockers, projectId)
  },
  finalReview: {
    get: (projectId: string): Promise<FinalReview> => ipcRenderer.invoke(IPC.finalReviewGet, projectId),
    requestRevision: (request: FinalReviewRevisionRequest): Promise<RevisionRequestRecord> =>
      ipcRenderer.invoke(IPC.finalReviewRevision, request),
    selectPackage: (request: { projectId: string; packageId: string }): Promise<FinalReview> =>
      ipcRenderer.invoke(IPC.packagingSelect, request)
  },
  youtube: {
    status: (): Promise<YouTubeConnectionStatus> => ipcRenderer.invoke(IPC.youtubeStatus),
    authorize: (): Promise<YouTubeConnectionStatus> => ipcRenderer.invoke(IPC.youtubeAuthorize),
    uploadPrivate: (projectId: string): Promise<{ videoId: string; url: string }> =>
      ipcRenderer.invoke(IPC.youtubeUploadPrivate, projectId),
    approve: (request: {
      projectId: string;
      action: 'keep_private' | 'publish' | 'schedule';
      scheduledAt?: string;
    }): Promise<PublicationApprovalResult> => ipcRenderer.invoke(IPC.youtubeApprove, request)
  },
  exceptions: {
    list: (request?: { projectId?: string; openOnly?: boolean }): Promise<ExceptionRecord[]> =>
      ipcRenderer.invoke(IPC.exceptionsList, request),
    resolve: (request: { id: string; resolution?: Record<string, unknown> }): Promise<ExceptionRecord> =>
      ipcRenderer.invoke(IPC.exceptionResolve, request),
    override: (request: { id: string; reason: string }): Promise<ExceptionRecord> =>
      ipcRenderer.invoke(IPC.exceptionOverride, request),
    retry: (id: string): Promise<ExceptionRecord> =>
      ipcRenderer.invoke(IPC.exceptionRetry, { id }),
    ambiguousMapping: (exceptionId: string): Promise<AmbiguousFileMappingRecovery> =>
      ipcRenderer.invoke(IPC.ambiguousMappingGet, exceptionId),
    resolveAmbiguousMapping: (request: { exceptionId: string; acquisitionId: string }): Promise<AmbiguousFileMappingResolution> =>
      ipcRenderer.invoke(IPC.ambiguousMappingResolve, request),
    retrySemanticVerification: (exceptionId: string): Promise<SemanticVerificationRetryResult> =>
      ipcRenderer.invoke(IPC.semanticVerificationRetry, { exceptionId })
  },
  jobs: {
    list: (projectId?: string): Promise<JobRecord[]> => ipcRenderer.invoke(IPC.jobsList, projectId),
    retry: (id: string): Promise<JobRecord> => ipcRenderer.invoke(IPC.jobsRetry, id)
  },
  system: {
    openPath: (path: string): Promise<boolean> => ipcRenderer.invoke(IPC.mediaOpenPath, path),
    openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke(IPC.externalOpen, url)
  }
};

contextBridge.exposeInMainWorld('videoFactory', api);

export type VideoFactoryApi = typeof api;
