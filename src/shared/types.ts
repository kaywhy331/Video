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
  ffmpegPath: string;
  ffprobePath: string;
  monthlyBudgetUsd: number;
  minFreeDiskGb: number;
  maxActiveProjects: number;
  maxWaitingDownloads: number;
  maxPrivateApproval: number;
  targetVideoMinutes: number;
  defaultOutput: '1080p' | 'qualified_4k';
  preferredShotMinSeconds: number;
  preferredShotMaxSeconds: number;
  hardShotMaxSeconds: number;
  narratorProvider: 'windows_sapi' | 'http_tts';
  narratorVoice: string;
  narratorRate: number;
  llmProvider: 'mock' | 'openai_compatible';
  llmBaseUrl: string;
  llmModel: string;
  visionProvider: 'disabled' | 'openai_compatible';
  visionBaseUrl: string;
  visionModel: string;
  visionMinimumConfidence: number;
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

export interface QueueSummary {
  activeProjects: number;
  waitingDownloads: number;
  waitingApproval: number;
  openExceptions: number;
  queuedJobs: number;
  runningJobs: number;
}

export interface AppBootstrap {
  settings: AppSettings;
  secrets: SecretStatus;
  diagnostics: DiagnosticsReport;
  queue: QueueSummary;
  catalog: CatalogStats;
  projects: ProjectSummary[];
  exceptions: ExceptionRecord[];
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
  downloaded?: boolean;
  verified?: boolean;
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
  filePath: string;
  sheetNames: string[];
  selectedSheet: string;
  rowCount: number;
  columns: string[];
  mapping: Record<string, string | null>;
  sampleRows: Record<string, unknown>[];
}

export interface CatalogImportResult {
  importId: string;
  inserted: number;
  updated: number;
  unchanged: number;
  conflicts: number;
  invalid: number;
  total: number;
  warnings: string[];
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
  coverageScore: number;
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
  finalRenderPath: string | null;
  youtubeVideoId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectDetail extends ProjectSummary {
  description: string | null;
  opportunityScore: number | null;
  scriptVersionId: string | null;
  scenes: ProjectScene[];
  acquisitions: AcquisitionItem[];
  renders: RenderRecord[];
  packaging: PackagingCandidate[];
  qc: QcResult[];
  repairs: RepairAttempt[];
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
  startMs: number | null;
  endMs: number | null;
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
  severity: ExceptionSeverity;
  stage: string;
  code: string;
  title: string;
  message: string;
  evidence: Record<string, unknown>;
  recommendedAction: string | null;
  status: 'OPEN' | 'RESOLVED' | 'OVERRIDDEN';
  createdAt: string;
  resolvedAt: string | null;
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
  profile: 'proxy_720p' | 'draft_720p' | 'final_1080p' | 'final_4k';
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
  targetState: ProjectState | null;
  evidence: Record<string, unknown>;
  createdAt: string;
  completedAt: string | null;
}

export interface FinalReview {
  project: ProjectDetail;
  selectedPackage: PackagingCandidate | null;
  privateVideoUrl: string | null;
  localPreviewUrl: string | null;
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
