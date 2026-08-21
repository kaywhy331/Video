export type Id = string;

export type ProjectState =
  | 'CREATED'
  | 'ANALYZING_OPPORTUNITY'
  | 'TOPIC_SELECTED'
  | 'RESEARCHING'
  | 'SCRIPTING_PROVISIONAL'
  | 'STORYBOARD_PROVISIONAL'
  | 'WAITING_FOR_DOWNLOADS'
  | 'INGESTING_MEDIA'
  | 'VERIFYING_FOOTAGE'
  | 'FINALIZING_SCRIPT'
  | 'GENERATING_VOICE'
  | 'BUILDING_TIMELINE'
  | 'RENDERING_DRAFT'
  | 'QC_DRAFT'
  | 'RENDERING_FINAL'
  | 'QC_FINAL'
  | 'UPLOADING_PRIVATE'
  | 'WAITING_YOUTUBE_PROCESSING'
  | 'WAITING_FINAL_APPROVAL'
  | 'SCHEDULED'
  | 'PUBLISHED'
  | 'ANALYTICS_ACTIVE'
  | 'PAUSED'
  | 'BLOCKED_EXCEPTION'
  | 'AWAITING_MANUAL_STUDIO_ACTION'
  | 'CANCELLED'
  | 'FAILED'
  | 'ARCHIVED';

export type AcquisitionState =
  | 'PLANNED'
  | 'READY_TO_OPEN'
  | 'ACTIVE_IN_BROWSER'
  | 'WAITING_FOR_FILE'
  | 'FILE_DETECTED'
  | 'FILE_STABLE'
  | 'MAPPED'
  | 'PROCESSING'
  | 'VERIFIED'
  | 'LICENSE_ONLY_PENDING'
  | 'COMPLETE'
  | 'FAILED'
  | 'SKIPPED';

export type LicenseState =
  | 'NOT_REQUIRED'
  | 'PENDING'
  | 'OPERATOR_ATTESTED'
  | 'CERTIFICATE_ATTACHED'
  | 'VERIFIED'
  | 'CONFLICT';

export type JobState =
  | 'QUEUED'
  | 'READY'
  | 'RUNNING'
  | 'WAITING_EXTERNAL'
  | 'WAITING_HUMAN'
  | 'RETRY_SCHEDULED'
  | 'SUCCEEDED'
  | 'FAILED_RETRYABLE'
  | 'FAILED_PERMANENT'
  | 'CANCELLED';

export type ExceptionSeverity = 'BLOCKER' | 'HIGH' | 'MEDIUM' | 'LOW';

export type RepairClass =
  | 'automatic'
  | 'alternate'
  | 'regenerate_range'
  | 'acquisition'
  | 'operator'
  | 'fatal';

export type RepairAttemptStatus =
  | 'routed'
  | 'waiting_acquisition'
  | 'verified'
  | 'exhausted'
  | 'operator_required'
  | 'failed';

export type VisualTreatment =
  | 'EXACT_LOCATION_FOOTAGE'
  | 'CONTEXTUAL_VERIFIED_FOOTAGE'
  | 'MAP_OR_GRAPHIC'
  | 'TEXT_OR_ARCHIVAL';

export interface AppSettings {
  dataRoot: string;
  databasePath: string;
  ingestFolder: string;
  mediaLibraryFolder: string;
  projectFolder: string;
  outputFolder: string;
  backupFolder: string;
  backupIntervalHours: number;
  backupDailyRetention: number;
  backupWeeklyRetention: number;
  backupMonthlyRetention: number;
  catalogImportFile: string;
  catalogRefreshEnabled: boolean;
  catalogRefreshIntervalHours: number;
  catalogValidationTemplateId: string;
  autopilotSchedulerEnabled: boolean;
  autopilotCadenceDays: number;
  autopilotPublicationHourUtc: number;
  musicEnabled: boolean;
  musicTargetGainDb: number;
  musicDuckingDb: number;
  automaticDerivativeCleanup: boolean;
  derivativeCleanupTargetGb: number;
  ffmpegPath: string;
  ffprobePath: string;
  monthlyBudgetUsd: number;
  projectBudgetUsd: number;
  minFreeDiskGb: number;
  maxActiveProjects: number;
  maxWaitingDownloads: number;
  maxPrivateApproval: number;
  targetVideoMinutes: number;
  defaultOutput: '1080p' | 'qualified_4k';
  updateChannel: 'stable' | 'prerelease';
  updateCheckEnabled: boolean;
  preferredShotMinSeconds: number;
  preferredShotMaxSeconds: number;
  hardShotMaxSeconds: number;
  matchingMaxSourceUses: number;
  matchingMaxConsecutiveShotMotion: number;
  matchingPerceptualDistance: number;
  matchingHeroStrategy: 'opening' | 'first_major_transition' | 'disabled';
  narratorProvider: 'windows_sapi' | 'http_tts';
  narratorBaseUrl: string;
  narratorModel: string;
  narratorVoice: string;
  narratorRate: number;
  pronunciationDictionary: Record<string, string>;
  llmProvider: 'mock' | 'openai_compatible';
  llmBaseUrl: string;
  llmModel: string;
  visionProvider: 'disabled' | 'openai_compatible';
  visionBaseUrl: string;
  visionModel: string;
  visionMinimumConfidence: number;
  researchProvider: 'disabled' | 'tavily';
  researchBaseUrl: string;
  researchSearchDepth: 'basic' | 'advanced';
  researchMaxResultsPerQuery: number;
  youtubeCategoryId: string;
  youtubePlaylistId: string;
  youtubePrivacy: 'private';
  youtubeSyntheticMediaDisclosure: boolean;
  channelName: string;
  channelShort: string;
  autoStartWithWindows: boolean;
  autoUploadPrivate: boolean;
  preferredCountries: string[];
  blockedCountries: string[];
}

export interface SecretStatus {
  llmApiKeyConfigured: boolean;
  visionApiKeyConfigured: boolean;
  researchApiKeyConfigured: boolean;
  httpTtsApiKeyConfigured: boolean;
  youtubeClientConfigured: boolean;
  youtubeAuthorized: boolean;
  youtubeApiKeyConfigured: boolean;
}

export interface DiagnosticsReport {
  checkedAt: string;
  platform: string;
  appVersion: string;
  paths: Array<{
    key: string;
    path: string;
    exists: boolean;
    writable?: boolean;
    freeBytes?: number;
  }>;
  ffmpeg: {
    found: boolean;
    path?: string;
    version?: string;
    encoders: string[];
    encoderTests: Array<{
      id: 'h264_nvenc' | 'h264_qsv' | 'h264_amf' | 'libx264';
      label: string;
      advertised: boolean;
      usable: boolean;
      error?: string;
    }>;
    error?: string;
  };
  ffprobe: {
    found: boolean;
    path?: string;
    version?: string;
    error?: string;
  };
  database: {
    path: string;
    open: boolean;
    integrity: string;
    walMode: boolean;
  };
  mediaSmokeTest: {
    encoded: boolean;
    probed: boolean;
    error?: string;
  };
  issues: string[];
  status: 'pass' | 'warning' | 'fail';
  savedRunId: string;
}

export interface BackupRecord {
  path: string;
  checksum: string;
  sizeBytes: number;
  integrity: string;
  createdAt: string;
  missingOriginals: string[];
}

export interface RestoreReport {
  backupPath: string;
  stagedPath: string;
  integrity: string;
  checksum: string;
  restartRequired: boolean;
  missingOriginals: string[];
}

export interface ProjectExportOptions {
  includeOriginals: boolean;
  includeFinalOutput: boolean;
}

export interface ProjectExportReport {
  id: string;
  projectId: string;
  exportPath: string;
  manifestPath: string | null;
  manifestSha256: string | null;
  artifactCount: number;
  totalBytes: number;
  missingFiles: string[];
  status: 'running' | 'complete' | 'partial' | 'failed';
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface DerivativeRebuildReport {
  id: string;
  projectId: string;
  checkedOriginals: number;
  rebuiltProxies: number;
  rebuiltContactSheets: number;
  rebuiltVoiceTimings: number;
  rebuiltEditingLayers: number;
  rebuiltCaptionFiles: number;
  staleRenderFragments: number;
  missingOriginals: string[];
  missingVoice: string[];
  failures: string[];
  status: 'running' | 'complete' | 'partial' | 'failed';
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface QueueSummary {
  activeProjects: number;
  waitingDownloads: number;
  waitingApproval: number;
  openExceptions: number;
  queuedJobs: number;
  runningJobs: number;
}

export interface OperationsHealth {
  budget: {
    spentUsd: number;
    limitUsd: number;
    remainingUsd: number;
    status: 'healthy' | 'warning' | 'blocked';
  };
  disk: {
    freeBytes: number | null;
    minimumBytes: number;
    status: 'healthy' | 'warning' | 'blocked' | 'unknown';
  };
  providers: Array<{
    provider: string;
    status: 'healthy' | 'auth_invalid' | 'quota_exhausted' | 'unavailable';
    message: string | null;
    checkedAt: string;
  }>;
  workers: {
    media: 'active' | 'idle';
    render: 'active' | 'idle';
    upload: 'active' | 'idle';
    runningTypes: string[];
  };
}

export interface AppBootstrap {
  settings: AppSettings;
  secrets: SecretStatus;
  diagnostics: DiagnosticsReport | null;
  queue: QueueSummary;
  catalog: CatalogStats;
  projects: ProjectSummary[];
  exceptions: ExceptionRecord[];
  latestCatalogRefresh: CatalogRefreshRun | null;
  latestUpdateCheck: UpdateCheckResult | null;
  scheduler: SchedulerStatus;
  operationsHealth: OperationsHealth;
  learningRecommendations: LearningRecommendation[];
  musicTracks: MusicTrack[];
  latestStorageCleanup: StorageCleanupReport | null;
  expansion: ExpansionRegistrySnapshot;
}

export type AppStateSnapshot = Pick<AppBootstrap,
  | 'diagnostics'
  | 'queue'
  | 'catalog'
  | 'projects'
  | 'exceptions'
  | 'latestCatalogRefresh'
  | 'latestUpdateCheck'
  | 'scheduler'
  | 'operationsHealth'
  | 'learningRecommendations'
  | 'musicTracks'
  | 'latestStorageCleanup'
  | 'expansion'
>;

export type ExternalQualification = 'unverified' | 'qualified' | 'blocked' | 'not_required';
export type OutputProfileKey = 'landscape_1080p' | 'landscape_4k' | 'vertical_1080p';

export interface ChannelProfile {
  id: string;
  name: string;
  shortCode: string;
  defaultLanguageCode: string;
  defaultVoiceId: string | null;
  youtubeChannelId: string | null;
  youtubeChannelTitle: string | null;
  active: boolean;
  isDefault: boolean;
  policy: Record<string, unknown>;
  externalQualification: Exclude<ExternalQualification, 'not_required'>;
}

export interface LanguageVoiceProfile {
  id: string;
  languageCode: string;
  languageName: string;
  voiceProvider: string;
  voiceId: string;
  displayName: string;
  active: boolean;
  isDefault: boolean;
  settings: Record<string, unknown>;
  externalQualification: Exclude<ExternalQualification, 'not_required'>;
}

export interface ProviderCapabilityRecord {
  id: string;
  providerKey: string;
  displayName: string;
  capability: 'stock' | 'llm' | 'vision' | 'tts' | 'keyword_metrics' | 'research' | 'uploader' | 'analytics' | 'local_ai' | 'render_worker';
  implementation: string;
  configured: boolean;
  available: boolean;
  externalQualification: ExternalQualification;
  capabilities: Record<string, unknown>;
  lastCheckedAt: string | null;
  statusMessage: string | null;
}

export interface OutputProfile {
  id: string;
  profileKey: OutputProfileKey;
  displayName: string;
  width: number;
  height: number;
  orientation: 'landscape' | 'portrait' | 'square';
  frameRate: number;
  videoCodec: string;
  audioCodec: string;
  qualificationPolicy: Record<string, unknown>;
  active: boolean;
  isDefault: boolean;
}

export interface ExpansionRegistrySnapshot {
  channels: ChannelProfile[];
  languages: LanguageVoiceProfile[];
  providers: ProviderCapabilityRecord[];
  outputProfiles: OutputProfile[];
}

export interface KeywordMetricObservation {
  id: string;
  topicCandidateId: string | null;
  keyword: string;
  provider: string;
  metricType: string;
  value: number | null;
  geographyCode: string | null;
  languageCode: string;
  collectedAt: string;
  confidence: number;
  youtubeNative: boolean;
  rawMetadata: Record<string, unknown>;
  truthfulLabel: string;
}

export interface OpportunityAssessment {
  topicCandidateId: string;
  destinationKey: string;
  title: string;
  destination: string;
  feasibility: 'qualified' | 'weak' | 'rejected';
  demandScore: number | null;
  competitionScore: number | null;
  opportunityScore: number;
  components: Record<string, number>;
  observations: KeywordMetricObservation[];
  labels: string[];
}

export interface GoogleSheetsSyncRun {
  id: string;
  configId: string | null;
  spreadsheetId: string;
  sheetRange: string;
  sourceSha256: string | null;
  materializedPath: string | null;
  previewId: string | null;
  rowCount: number;
  status: 'staged' | 'up_to_date' | 'blocked' | 'failed';
  diff: CatalogImportDiff;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface AnalyticsCollectionRun {
  id: string;
  projectId: string;
  videoId: string;
  snapshotDay: 1 | 3 | 7 | 28 | 90;
  provider: string;
  status: 'running' | 'complete' | 'failed';
  analyticsSnapshotId: string | null;
  responseHash: string | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface AnalyticsCollectionRequest {
  projectId: string;
  videoId: string;
  snapshotDay: 1 | 3 | 7 | 28 | 90;
  capturedAt: string;
  startDate: string;
  endDate: string;
}

export interface AnalyticsProviderResult {
  metrics: AnalyticsMetrics;
  retention: RetentionPointInput[];
  rawMetadata?: Record<string, unknown>;
}

export interface MusicTrack {
  id: string;
  sha256: string;
  originalPath: string;
  originalFileName: string;
  title: string;
  provider: string;
  licenseType: string;
  licenseReference: string;
  licenseDocumentPath: string | null;
  licenseVerifiedAt: string;
  moods: string[];
  tempoBpm: number | null;
  durationMs: number;
  loopable: boolean;
  enabled: boolean;
  importedAt: string;
}

export interface ProjectMusicSelection {
  id: string;
  projectId: string;
  musicTrackId: string;
  selectedBy: 'automatic' | 'human';
  targetGainDb: number;
  duckingDb: number;
  fadeInMs: number;
  fadeOutMs: number;
  licenseSnapshot: Record<string, unknown>;
}

export interface StorageCleanupReport {
  id: string;
  trigger: 'manual' | 'disk_pressure' | 'startup';
  status: 'planned' | 'not_needed' | 'complete' | 'partial' | 'failed';
  freeBytesBefore: number | null;
  freeBytesAfter: number | null;
  targetFreeBytes: number;
  candidateBytes: number;
  removedBytes: number;
  removedCount: number;
  skipped: string[];
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface SchedulerStatus {
  enabled: boolean;
  state: 'running' | 'paused' | 'blocked';
  reasonCode: string | null;
  reason: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastProjectId: string | null;
  evaluatedAt: string;
}

export interface AnalyticsMetrics {
  views: number;
  impressions: number | null;
  clickThroughRate: number | null;
  watchTimeMinutes: number | null;
  averageViewDurationSeconds: number | null;
  averagePercentageViewed: number | null;
  subscribersGained: number | null;
  trafficSources: Record<string, number>;
  searchTerms: Record<string, number>;
  playlistStarts: number | null;
  endScreenClicks: number | null;
}

export interface RetentionPointInput {
  elapsedRatio: number;
  audienceWatchRatio: number | null;
  relativeRetention: number | null;
}

export interface AnalyticsSnapshot {
  id: string;
  projectId: string;
  videoId: string;
  snapshotDay: 1 | 3 | 7 | 28 | 90;
  metrics: AnalyticsMetrics;
  retention: RetentionPointInput[];
  capturedAt: string;
  source: 'youtube_api' | 'manual_import';
  sourceHash: string;
  mappings: RetentionMapping[];
}

export interface RetentionMapping {
  positionMs: number;
  elapsedRatio: number;
  audienceWatchRatio: number | null;
  relativeRetention: number | null;
  sceneId: string | null;
  sceneOrdinal: number | null;
  chapter: string | null;
  visualTreatment: string | null;
  shotLengthMs: number | null;
  sourceKind: string | null;
  locationName: string | null;
  voiceWordsPerMinute: number | null;
}

export interface LearningRecommendation {
  id: string;
  metricKey: string;
  scope: Record<string, unknown>;
  beforeValue: unknown;
  proposedValue: unknown;
  currentValue: unknown;
  rationale: string;
  evidenceSnapshotIds: string[];
  evidenceVideoCount: number;
  evidenceTotalViews: number;
  status: 'proposed' | 'applied' | 'rejected' | 'rolled_back';
  appliedAt: string | null;
  rolledBackAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SettingsProfileReport {
  operation: 'export' | 'import';
  path: string;
  sha256: string;
  appliedKeys: string[];
  warnings: string[];
  settings: AppSettings;
}

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string | null;
  releaseUrl: string | null;
  available: boolean;
  status: 'current' | 'available' | 'unpublished' | 'error';
  channel: 'stable' | 'prerelease';
  checkedAt: string;
  error: string | null;
}

export interface CatalogValidationTemplate {
  id: string;
  name: string;
  description: string;
  sourcePattern: string;
  requiredFields: string[];
  identityFields: string[];
  minimumRows: number;
  maximumInvalidRatio: number;
  builtIn: boolean;
}

export interface CatalogRefreshRun {
  id: string;
  sourcePath: string;
  sourceSha256: string | null;
  templateId: string | null;
  previewId: string | null;
  status: 'staged' | 'up_to_date' | 'blocked' | 'failed';
  diff: CatalogImportDiff;
  validation: { valid: boolean; issues: string[] };
  error: string | null;
  createdAt: string;
}

export interface CatalogStats {
  totalAssets: number;
  downloadedAssets: number;
  verifiedAssets: number;
  countries: number;
  cities: number;
  locations: number;
  imports: number;
}

export interface CatalogAsset {
  id: Id;
  provider: string;
  providerAssetId: string | null;
  sourceRowId: string | null;
  canonicalPageUrl: string | null;
  authorName: string | null;
  title: string;
  description: string | null;
  rawAttributes: string | null;
  rawTags: string | null;
  country: string | null;
  city: string | null;
  locationName: string | null;
  activity: string | null;
  shotType: string | null;
  sceneDescription: string | null;
  objects: string | null;
  timeOfDay: string | null;
  style: string | null;
  declaredDurationMs: number | null;
  thumbnailUrl: string | null;
  declaredWidth: number | null;
  declaredHeight: number | null;
  declaredFileSizeBytes: number | null;
  declaredFrameRate: number | null;
  declaredAlpha: boolean | null;
  declaredLooped: boolean | null;
  declaredCodec: string | null;
  orientation: 'landscape' | 'portrait' | 'square' | 'unknown';
  locationGranularity: 'country' | 'region' | 'city' | 'neighborhood' | 'landmark' | 'feature' | 'unknown';
  locationConfidence: number;
  verificationStatus: 'unverified' | 'metadata' | 'ai_suggested' | 'human_verified' | 'conflict';
  availabilityStatus: 'unknown' | 'available' | 'unavailable';
  localFileId: string | null;
  usedProjectCount: number;
  licensedProjectCount: number;
  mediaStatus: 'metadata_only' | 'downloaded' | 'analyzed' | 'usable_1080p' | 'usable_4k';
  perceptualHash?: string | null;
  excluded: boolean;
  importedAt: string;
  updatedAt: string;
}

export interface MetadataRevision {
  id: string;
  fieldName: string;
  previousValue: unknown;
  newValue: unknown;
  reason: string | null;
  createdAt: string;
  revertedAt: string | null;
}

export interface CatalogSearchRequest {
  query?: string;
  country?: string;
  city?: string;
  locationName?: string;
  author?: string;
  orientation?: string;
  verificationStatus?: CatalogAsset['verificationStatus'];
  availabilityStatus?: CatalogAsset['availabilityStatus'];
  minimumLocationConfidence?: number;
  downloaded?: boolean;
  verified?: boolean;
  used?: boolean;
  licensed?: boolean;
  mediaStatus?: CatalogAsset['mediaStatus'];
  metadataField?:
    | 'providerAssetId' | 'sourceRowId' | 'canonicalPageUrl' | 'authorName'
    | 'title' | 'description' | 'rawAttributes' | 'rawTags' | 'country' | 'city'
    | 'locationName' | 'activity' | 'shotType' | 'sceneDescription' | 'objects'
    | 'timeOfDay' | 'style' | 'declaredCodec';
  metadataValue?: string;
  page: number;
  pageSize: number;
  sortBy?: 'title' | 'country' | 'city' | 'location' | 'updated';
  sortDirection?: 'asc' | 'desc';
}

export interface CatalogSearchResult {
  rows: CatalogAsset[];
  total: number;
  page: number;
  pageSize: number;
  facets: {
    countries: Array<{ value: string; count: number }>;
    cities: Array<{ value: string; count: number }>;
    locations: Array<{ value: string; count: number }>;
    authors: Array<{ value: string; count: number }>;
  };
}

export interface CatalogImportPreview {
  previewId: string;
  filePath: string;
  sheetNames: string[];
  selectedSheet: string;
  rowCount: number;
  columns: string[];
  mapping: Record<string, string | null>;
  sampleRows: Record<string, unknown>[];
  diff: CatalogImportDiff;
  warnings: string[];
}

export interface CatalogImportDiff {
  inserted: number;
  changed: number;
  conflicts: number;
  missing: number;
  unchanged: number;
  invalid: number;
  sampleInserted: string[];
  sampleChanged: string[];
  sampleConflicts: string[];
  sampleMissing: string[];
}

export interface CatalogImportResult {
  importId: string;
  inserted: number;
  updated: number;
  unchanged: number;
  conflicts: number;
  missing: number;
  invalid: number;
  total: number;
  warnings: string[];
}

export interface CatalogImportOperationStatus {
  operationId: string;
  operation: 'preview' | 'commit' | 'refresh' | 'stage';
  state: 'running' | 'cancelling';
  progress: number;
  phase: string;
  message: string;
  startedAt: string;
}

export interface CoverageCluster {
  key: string;
  country: string | null;
  city: string | null;
  locationName: string | null;
  assetCount: number;
  uniqueShotTypes: number;
  uniqueActivities: number;
  uniqueTimes: number;
  landscapeCount: number;
  fourKCount: number;
  downloadedCount: number;
  verifiedCount: number;
  portraitCount: number;
  fullHdEligibleCount: number;
  estimatedUniqueShots: number;
  repetitionRisk: number;
  exactConfidenceDistribution: {
    verified: number;
    strong: number;
    contextual: number;
    weak: number;
  };
  shotBalance: {
    aerial: number;
    wide: number;
    medium: number;
    detail: number;
    other: number;
  };
  variety: {
    day: number;
    night: number;
    weather: number;
  };
  representedActivities: string[];
  representedObjects: string[];
  missingVisualCategories: string[];
  coverageScore: number;
}

export type MetadataLayer = 'raw' | 'normalized' | 'ai' | 'human';
export type MetadataAssertionState = 'proposed' | 'accepted' | 'rejected' | 'verified' | 'superseded';

export interface MetadataAssertion {
  id: string;
  assetId: string;
  fieldName: string;
  layer: MetadataLayer;
  value: unknown;
  source: string;
  provider: string | null;
  model: string | null;
  confidence: number | null;
  verificationState: MetadataAssertionState;
  actor: string | null;
  evidenceRef: string | null;
  evidence: Record<string, unknown>;
  effective: boolean;
  createdAt: string;
  updatedAt: string;
  reviewedAt: string | null;
  assetTitle?: string;
}

export interface CatalogExportReport {
  id: string;
  outputPath: string;
  rowCount: number;
  sha256: string;
  createdAt: string;
}

export interface CanonicalPlace {
  id: string;
  name: string;
  normalizedName: string;
  type: 'country' | 'region' | 'city' | 'neighborhood' | 'landmark' | 'feature';
  parentId: string | null;
  latitude: number | null;
  longitude: number | null;
  aliases: string[];
  assetCount: number;
}

export interface TopicCandidate {
  id: string;
  title: string;
  destination: string;
  angle: string;
  viewerPromise: string;
  keywords: string[];
  coverage: CoverageCluster;
  demandScore: number | null;
  competitionScore: number | null;
  opportunityScore: number;
  feasibility: 'qualified' | 'weak' | 'rejected';
  reasons: string[];
}

export interface CreateAutopilotProjectRequest {
  destinationKey?: string;
  targetMinutes?: number;
  topicId?: string;
  startingScript?: string;
  channelId?: string;
  languageVoiceProfileId?: string;
  outputProfileKey?: OutputProfileKey;
}

export interface ProjectGuidance {
  mode: 'automatic' | 'guided';
  startingScript: string | null;
  startingScriptSha256: string | null;
  requestedDestinationKey: string | null;
  requestedTopicId: string | null;
  requestedTargetDurationMs: number | null;
  resolvedDestinationKey: string;
  resolvedDestination: string;
  resolvedTopicTitle: string;
  resolvedTargetDurationMs: number;
  constraints: Record<string, unknown>;
  createdAt: string;
}

export interface ProjectResearchSource {
  id: string;
  url: string;
  title: string;
  publisher: string | null;
  sourceType: string;
  summary: string | null;
  excerpt: string | null;
  contentHash: string | null;
  status: 'active' | 'stale' | 'unavailable' | 'rejected';
  publishedAt: string | null;
  accessedAt: string;
  freshnessDays: number | null;
  expiresAt: string | null;
}

export interface ProjectFactClaim {
  id: string;
  text: string;
  category: string;
  confidence: number;
  stability: string;
  validAsOf: string | null;
  status: string;
  material: boolean;
  sourceIds: string[];
  sceneIds: string[];
  normalizedKey: string | null;
  freshnessDays: number | null;
  expiresAt: string | null;
  conflictGroup: string | null;
  omissionReason: string | null;
  evidence: Record<string, unknown>;
  createdAt: string;
  updatedAt: string | null;
}

export interface ProjectScriptVersion {
  id: string;
  parentId: string | null;
  versionNumber: number;
  title: string;
  topic: string;
  summary: string | null;
  script: Record<string, unknown>;
  generationReason: string;
  provider: string;
  model: string;
  inputHash: string;
  locked: boolean;
  scriptType: 'provisional' | 'final';
  lockedAt: string | null;
  createdAt: string;
}

export interface ProjectLicenseDetail {
  id: string;
  assetId: string;
  assetTitle: string;
  licenseState: LicenseState;
  envatoProjectName: string;
  certificatePath: string | null;
  operatorAttestedAt: string | null;
  verifiedAt: string | null;
  notes: string | null;
  file: {
    id: string;
    fileName: string;
    sha256: string;
    width: number;
    height: number;
    durationMs: number;
    codec: string;
    pipelineVersion: string;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectPublicationDetail {
  id: string;
  videoId: string | null;
  privacyStatus: string;
  processingStatus: string | null;
  selectedPackageId: string | null;
  captionId: string | null;
  thumbnailUploaded: boolean;
  approvedAt: string | null;
  scheduledAt: string | null;
  publishedAt: string | null;
  syntheticMedia: boolean;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuditLogEntry {
  id: number;
  projectId: string | null;
  action: string;
  actor: string;
  entityType: string | null;
  entityId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface ProjectSummary {
  id: string;
  sequence: number;
  slug: string;
  title: string;
  topic: string;
  destination: string | null;
  state: ProjectState;
  progress: number;
  envatoProjectName: string;
  targetDurationMs: number;
  sceneCount: number;
  acquiredCount: number;
  acquisitionCount: number;
  openExceptions: number;
  finalRenderId: string | null;
  finalRenderPath: string | null;
  youtubeVideoId: string | null;
  channelId: string | null;
  languageVoiceProfileId: string | null;
  outputProfileKey: OutputProfileKey;
  pendingLifecycleAction: 'pause' | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectDetail extends ProjectSummary {
  description: string | null;
  opportunityScore: number | null;
  scriptVersionId: string | null;
  channelSnapshot: Record<string, unknown> | null;
  languageVoiceSnapshot: Record<string, unknown> | null;
  outputProfileSnapshot: OutputProfile | null;
  guidance: ProjectGuidance | null;
  researchSources: ProjectResearchSource[];
  factClaims: ProjectFactClaim[];
  scriptVersions: ProjectScriptVersion[];
  scenes: ProjectScene[];
  acquisitions: AcquisitionItem[];
  licenses: ProjectLicenseDetail[];
  renders: RenderRecord[];
  packaging: PackagingCandidate[];
  qc: QcResult[];
  repairs: RepairAttempt[];
  narrationSections: NarrationSection[];
  publicationRecords: ProjectPublicationDetail[];
  analyticsSnapshots: AnalyticsSnapshot[];
  auditLog: AuditLogEntry[];
  exports: ProjectExportReport[];
  rebuilds: DerivativeRebuildReport[];
}

export interface ProjectScene {
  id: string;
  projectId: string;
  ordinal: number;
  chapter: string | null;
  narration: string;
  targetDurationMs: number;
  requiredCountry: string | null;
  requiredCity: string | null;
  requiredLocation: string | null;
  requiredPlaceId: string | null;
  requiredGranularity: CatalogAsset['locationGranularity'];
  requiredObjects: string[];
  requiredActivities: string[];
  preferredShots: string[];
  visualTreatment: VisualTreatment;
  selectedAssetId: string | null;
  selectedFileId: string | null;
  selectedSegmentId: string | null;
  score: number | null;
  scoreExplanation: string[];
  verificationState: 'metadata_only' | 'download_required' | 'verified' | 'rejected' | 'graphic';
  pronunciation: Record<string, string>;
  startMs: number | null;
  endMs: number | null;
}

export interface StoryboardCandidate {
  id: string;
  sceneId: string;
  assetId: string;
  assetTitle: string;
  thumbnailUrl: string | null;
  rank: number;
  score: number;
  status: 'selected' | 'eligible' | 'alternate' | 'rejected';
  country: string | null;
  city: string | null;
  locationName: string | null;
  locationGranularity: CatalogAsset['locationGranularity'];
  explanations: string[];
  fileId: string | null;
  segmentId: string | null;
  acquisitionState: AcquisitionState | null;
  licenseState: LicenseState | null;
  semanticStatus: 'verified' | 'rejected' | 'conflict' | 'provider_required' | 'uncertain' | 'error' | null;
  selected: boolean;
  ready: boolean;
  blockedReasons: string[];
}

export interface StoryboardRecoveryScene {
  projectId: string;
  scene: ProjectScene;
  candidates: StoryboardCandidate[];
  previousSceneId: string | null;
  nextSceneId: string | null;
  editable: boolean;
  editBlockedReason: string | null;
}

export type StoryboardRecoveryAction =
  | 'replace_shot'
  | 'rewrite_beat'
  | 'use_graphic'
  | 'split_beat'
  | 'merge_beats'
  | 'verify_location'
  | 'reject_candidate';

export interface StoryboardMutationResult {
  action: StoryboardRecoveryAction;
  project: ProjectDetail;
  affectedSceneIds: string[];
  affectedRange: RenderScope | null;
  nextAction: 'render_range' | 'continue_workflow' | 'manual_recovery';
}

export interface NarrationWord {
  word: string;
  startMs: number;
  endMs: number;
  confidence: number;
  timingMethod: 'provider_word' | 'duration_weighted_fallback';
}

export interface NarrationSection {
  id: string;
  projectId: string;
  scriptVersionId: string;
  ordinal: number;
  chapter: string | null;
  sceneIds: string[];
  text: string;
  pronunciation: Record<string, string>;
  audioPath: string;
  timingPath: string | null;
  durationMs: number;
  timingMethod: NarrationWord['timingMethod'];
  status: 'ready' | 'stale' | 'failed';
}

export interface RenderScope {
  startSceneOrdinal: number;
  endSceneOrdinal: number;
  sceneOrdinals: number[];
}

export interface AcquisitionItem {
  id: string;
  projectId: string;
  assetId: string;
  ordinal: number;
  role: 'primary' | 'alternate' | 'hero' | 'license_only';
  state: AcquisitionState;
  licenseState: LicenseState;
  sourceUrl: string;
  assetTitle: string;
  thumbnailUrl: string | null;
  requiredForScenes: number[];
  matchScore: number;
  reasons: string[];
  activeAt: string | null;
  detectedPath: string | null;
  mappedFileId: string | null;
  mappingConfidence: number | null;
  error: string | null;
}

export interface AssetFile {
  id: string;
  assetId: string;
  sha256: string;
  originalPath: string;
  proxyPath: string | null;
  contactSheetPath: string | null;
  fileName: string;
  fileSizeBytes: number;
  durationMs: number;
  width: number;
  height: number;
  frameRate: number;
  codec: string;
  pixelFormat: string | null;
  colorSpace: string | null;
  perceptualHash: string | null;
  audioPresent: boolean;
  createdAt: string;
}

export interface MediaSegment {
  id: string;
  assetFileId: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  qualityScore: number;
  blackFrameRisk: number;
  freezeRisk: number;
  effectiveWidth: number;
  effectiveHeight: number;
  eligible1080p: boolean;
  eligible4k: boolean;
  previewPath: string | null;
}

export interface JobRecord {
  id: string;
  projectId: string | null;
  type: string;
  state: JobState;
  progress: number;
  phase: string | null;
  attempt: number;
  maxAttempts: number;
  availableAt: string;
  leaseUntil: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExceptionRecord {
  id: string;
  projectId: string | null;
  projectTitle: string | null;
  severity: ExceptionSeverity;
  stage: string;
  code: string;
  title: string;
  message: string;
  evidence: Record<string, unknown>;
  recommendedAction: string | null;
  safeAlternatives: string[];
  canAcknowledge: boolean;
  canOverride: boolean;
  retryAction: ExceptionRetryAction | null;
  status: 'OPEN' | 'RESOLVED' | 'OVERRIDDEN';
  resolution: Record<string, unknown> | null;
  auditTrail: AuditLogEntry[];
  createdAt: string;
  resolvedAt: string | null;
}

export type ExceptionRetryAction = 'semantic_verification' | 'media_ingest' | 'workflow';

export interface AmbiguousFileMappingCandidate {
  acquisitionId: string;
  projectId: string;
  projectTitle: string;
  assetId: string;
  assetTitle: string;
  thumbnailUrl: string | null;
  requiredForScenes: number[];
  state: AcquisitionState;
}

export interface AmbiguousFileMappingRecovery {
  exceptionId: string;
  filePath: string;
  fileName: string;
  candidates: AmbiguousFileMappingCandidate[];
}

export interface AmbiguousFileMappingResolution {
  exceptionId: string;
  acquisitionId: string;
  projectId: string;
  mappedFileId: string;
  acquisitionState: 'COMPLETE';
}

export interface SemanticVerificationRetryResult {
  exceptionId: string;
  projectId: string;
  sceneId: string;
  verificationId: string;
  status: 'verified' | 'rejected' | 'conflict' | 'provider_required' | 'uncertain' | 'error';
  reasons: string[];
  exceptionResolved: boolean;
  projectState: ProjectState;
}

export interface RenderRecord {
  id: string;
  projectId: string;
  kind: 'range' | 'draft' | 'final';
  profile: 'proxy_720p' | 'draft_720p' | 'final_1080p' | 'final_4k' | 'final_vertical_1080p';
  state: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  manifestPath: string | null;
  outputPath: string | null;
  sha256: string | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
  artifactVersion: number;
  scope: RenderScope | null;
  baseRenderId: string | null;
}

export interface FourKBlocker {
  sceneOrdinal: number;
  reason: string;
  effectiveWidth: number | null;
  effectiveHeight: number | null;
}

export interface PackagingCandidate {
  id: string;
  projectId: string;
  ordinal: number;
  title: string;
  angle: string;
  viewerPromise: string;
  thumbnailPath: string | null;
  thumbnailFrameMs: number | null;
  description: string;
  chapters: string;
  tags: string[];
  riskStatus: 'pass' | 'warning' | 'blocked';
  selected: boolean;
}

export interface QcResult {
  id: string;
  projectId: string;
  renderId: string | null;
  category: 'story' | 'media' | 'audio' | 'packaging' | 'rights' | 'publishing';
  code: string;
  severity: ExceptionSeverity;
  status: 'pass' | 'warning' | 'fail' | 'repaired';
  message: string;
  evidence: Record<string, unknown>;
  repairClass: RepairClass | null;
  repairAttempted: boolean;
  repairAction: string | null;
  createdAt: string;
}

export interface RepairAttempt {
  id: string;
  projectId: string;
  sceneId: string | null;
  renderId: string | null;
  qcResultId: string | null;
  failureCode: string;
  repairClass: RepairClass;
  action: string;
  status: RepairAttemptStatus;
  attemptNumber: number;
  maximumAttempts: number;
  sourceAssetId: string | null;
  replacementAssetId: string | null;
  replacementFileId: string | null;
  replacementSegmentId: string | null;
  sourceArtifactVersion: number | null;
  rangeStartOrdinal: number | null;
  rangeEndOrdinal: number | null;
  targetState: ProjectState | null;
  evidence: Record<string, unknown>;
  createdAt: string;
  completedAt: string | null;
}

export type FinalReviewRevisionCategory =
  | 'packaging'
  | 'caption_typo'
  | 'voice_pronunciation'
  | 'script_factual_issue'
  | 'wrong_or_weak_shot'
  | 'new_footage_required'
  | 'major_story_change';

export interface FinalReviewRevisionRequest {
  projectId: string;
  category: FinalReviewRevisionCategory;
  note: string;
  affectedSceneId?: string;
  affectedSectionId?: string;
  pronunciation?: { term: string; value: string };
}

export interface RevisionRequestRecord {
  id: string;
  projectId: string;
  category: FinalReviewRevisionCategory;
  note: string;
  affectedSceneId: string | null;
  affectedSectionId: string | null;
  pronunciation: { term: string; value: string } | null;
  returnState: ProjectState;
  status: 'requested' | 'in_progress' | 'completed' | 'cancelled';
  createdAt: string;
  completedAt: string | null;
}

export interface FinalReview {
  project: ProjectDetail;
  selectedPackage: PackagingCandidate | null;
  privateVideoUrl: string | null;
  keptPrivateAt: string | null;
  localPreviewUrl: string | null;
  localCaptionsUrl: string | null;
  blockers: QcResult[];
  warnings: QcResult[];
  packageSynced: boolean;
  canUpload: boolean;
  canApprove: boolean;
}

export interface YouTubeConnectionStatus {
  configured: boolean;
  authorized: boolean;
  channelTitle: string | null;
  channelId: string | null;
}

export interface PublicationApprovalResult {
  outcome: 'kept_private' | 'published' | 'scheduled' | 'studio_fallback';
  studioUrl?: string;
  requestedAction?: 'publish' | 'schedule';
}

export interface OperationResult<T = undefined> {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface ProgressEvent {
  jobId: string;
  projectId: string | null;
  type: string;
  progress: number;
  phase: string;
  message: string;
}
