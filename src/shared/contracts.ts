import { z } from 'zod';
import type { CatalogAsset, VisualTreatment } from './types';

const FilePathSchema = z.string().trim().min(1).max(32_767);
const NullableText = (max: number) => z.string().trim().max(max).nullable();

export const CatalogSearchRequestSchema = z.object({
  query: z.string().trim().max(500).optional(),
  country: z.string().trim().max(120).optional(),
  city: z.string().trim().max(120).optional(),
  locationName: z.string().trim().max(200).optional(),
  author: z.string().trim().max(200).optional(),
  orientation: z.enum(['landscape','portrait','square','unknown']).optional(),
  verificationStatus: z.enum(['unverified','metadata','ai_suggested','human_verified','conflict']).optional(),
  availabilityStatus: z.enum(['unknown','available','unavailable']).optional(),
  minimumLocationConfidence: z.number().min(0).max(1).optional(),
  downloaded: z.boolean().optional(),
  verified: z.boolean().optional(),
  used: z.boolean().optional(),
  licensed: z.boolean().optional(),
  mediaStatus: z.enum(['metadata_only','downloaded','analyzed','usable_1080p','usable_4k']).optional(),
  metadataField: z.enum([
    'providerAssetId','sourceRowId','canonicalPageUrl','authorName','title','description',
    'rawAttributes','rawTags','country','city','locationName','activity','shotType',
    'sceneDescription','objects','timeOfDay','style','declaredCodec'
  ]).optional(),
  metadataValue: z.string().trim().min(1).max(2_000).optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(10).max(500).default(100),
  sortBy: z.enum(['title', 'country', 'city', 'location', 'updated']).optional(),
  sortDirection: z.enum(['asc', 'desc']).optional()
}).strict().refine(
  value => Boolean(value.metadataField) === Boolean(value.metadataValue),
  { message: 'Metadata field and value must be supplied together.' }
);

export const SettingsPatchSchema = z.object({
  dataRoot: FilePathSchema.optional(),
  databasePath: FilePathSchema.optional(),
  ingestFolder: FilePathSchema.optional(),
  mediaLibraryFolder: FilePathSchema.optional(),
  projectFolder: FilePathSchema.optional(),
  outputFolder: FilePathSchema.optional(),
  backupFolder: FilePathSchema.optional(),
  backupIntervalHours: z.number().int().min(1).max(168).optional(),
  backupDailyRetention: z.number().int().min(1).max(365).optional(),
  backupWeeklyRetention: z.number().int().min(1).max(260).optional(),
  backupMonthlyRetention: z.number().int().min(1).max(120).optional(),
  catalogImportFile: z.string().max(32_767).optional(),
  catalogRefreshEnabled: z.boolean().optional(),
  catalogRefreshIntervalHours: z.number().int().min(1).max(720).optional(),
  catalogValidationTemplateId: z.string().trim().min(1).max(200).optional(),
  autopilotSchedulerEnabled: z.boolean().optional(),
  autopilotCadenceDays: z.number().int().min(1).max(90).optional(),
  autopilotPublicationHourUtc: z.number().int().min(0).max(23).optional(),
  musicEnabled: z.boolean().optional(),
  musicTargetGainDb: z.number().min(-40).max(-12).optional(),
  musicDuckingDb: z.number().min(-30).max(-6).optional(),
  automaticDerivativeCleanup: z.boolean().optional(),
  derivativeCleanupTargetGb: z.number().min(1).max(1_000).optional(),
  ffmpegPath: z.string().max(32_767).optional(),
  ffprobePath: z.string().max(32_767).optional(),
  monthlyBudgetUsd: z.number().min(0).max(100_000).optional(),
  projectBudgetUsd: z.number().min(0).max(100_000).optional(),
  minFreeDiskGb: z.number().min(1).max(100_000).optional(),
  maxActiveProjects: z.number().int().min(1).max(20).optional(),
  maxWaitingDownloads: z.number().int().min(1).max(20).optional(),
  maxPrivateApproval: z.number().int().min(1).max(20).optional(),
  targetVideoMinutes: z.number().min(1).max(30).optional(),
  defaultOutput: z.enum(['1080p', 'qualified_4k']).optional(),
  updateChannel: z.enum(['stable', 'prerelease']).optional(),
  updateCheckEnabled: z.boolean().optional(),
  preferredShotMinSeconds: z.number().min(1.5).max(7).optional(),
  preferredShotMaxSeconds: z.number().min(1.5).max(7).optional(),
  hardShotMaxSeconds: z.number().min(2).max(7).optional(),
  matchingMaxSourceUses: z.number().int().min(1).max(10).optional(),
  matchingMaxConsecutiveShotMotion: z.number().int().min(1).max(5).optional(),
  matchingPerceptualDistance: z.number().int().min(0).max(16).optional(),
  matchingHeroStrategy: z.enum(['opening', 'first_major_transition', 'disabled']).optional(),
  narratorProvider: z.enum(['windows_sapi', 'http_tts']).optional(),
  narratorBaseUrl: z.string().url().max(2_000).optional(),
  narratorEndpointTrust: z.enum(['managed', 'custom_remote', 'custom_local']).optional(),
  narratorModel: z.string().trim().min(1).max(200).optional(),
  narratorVoice: z.string().max(200).optional(),
  narratorRate: z.number().min(-10).max(10).optional(),
  pronunciationDictionary: z.record(
    z.string().trim().min(1).max(200),
    z.string().trim().min(1).max(300)
  ).refine(value => Object.keys(value).length <= 500, 'Pronunciation dictionary is limited to 500 entries.').optional(),
  llmProvider: z.enum(['mock', 'openai_compatible']).optional(),
  llmBaseUrl: z.string().url().max(2_000).optional(),
  llmEndpointTrust: z.enum(['managed', 'custom_remote', 'custom_local']).optional(),
  llmModel: z.string().trim().min(1).max(200).optional(),
  visionProvider: z.enum(['disabled', 'openai_compatible']).optional(),
  visionBaseUrl: z.string().url().max(2_000).optional(),
  visionEndpointTrust: z.enum(['managed', 'custom_remote', 'custom_local']).optional(),
  visionModel: z.string().trim().min(1).max(200).optional(),
  visionMinimumConfidence: z.number().min(0.5).max(0.99).optional(),
  researchProvider: z.enum(['disabled', 'tavily']).optional(),
  researchBaseUrl: z.string().url().max(2_000).optional(),
  researchEndpointTrust: z.enum(['managed', 'custom_remote', 'custom_local']).optional(),
  researchSearchDepth: z.enum(['basic', 'advanced']).optional(),
  researchMaxResultsPerQuery: z.number().int().min(1).max(5).optional(),
  youtubeCategoryId: z.string().regex(/^\d{1,4}$/).optional(),
  youtubePlaylistId: z.string().max(200).optional(),
  youtubePrivacy: z.literal('private').optional(),
  youtubeSyntheticMediaDisclosure: z.boolean().optional(),
  channelName: z.string().max(200).optional(),
  channelShort: z.string().regex(/^[A-Za-z0-9_-]{0,12}$/).optional(),
  autoStartWithWindows: z.boolean().optional(),
  autoUploadPrivate: z.boolean().optional(),
  preferredCountries: z.array(z.string().trim().min(1).max(120)).max(250).optional(),
  blockedCountries: z.array(z.string().trim().min(1).max(120)).max(250).optional()
}).strict().superRefine((settings, context) => {
  if (settings.preferredShotMinSeconds !== undefined
    && settings.preferredShotMaxSeconds !== undefined
    && settings.preferredShotMinSeconds > settings.preferredShotMaxSeconds) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Preferred shot minimum cannot exceed the maximum.' });
  }
});

export const CreateAutopilotProjectSchema = z.object({
  destinationKey: z.string().trim().min(1).max(500).optional(),
  targetMinutes: z.number().min(1).max(30).optional(),
  topicId: z.string().trim().min(1).max(200).optional(),
  startingScript: z.string().max(20_000).refine(value => value.trim().length > 0, {
    message: 'Starting-script guidance cannot be blank.'
  }).optional(),
  channelId: z.string().trim().min(1).max(200).optional(),
  languageVoiceProfileId: z.string().trim().min(1).max(200).optional(),
  outputProfileKey: z.enum(['landscape_1080p', 'landscape_4k', 'vertical_1080p']).optional()
}).strict();

export const IdSchema = z.string().min(1).max(200);

export const ProjectExportSchema = z.object({
  projectId: IdSchema,
  destinationPath: FilePathSchema.optional(),
  includeOriginals: z.boolean().default(false),
  includeFinalOutput: z.boolean().default(true)
}).strict();

export const ProjectRebuildSchema = z.object({ projectId: IdSchema }).strict();

export const SettingsProfilePathSchema = FilePathSchema.optional();

export const CatalogRefreshSchema = z.object({
  sourcePath: FilePathSchema.optional(),
  templateId: IdSchema.optional(),
  operationId: IdSchema.optional()
}).strict();

export const AnalyticsSnapshotSchema = z.object({
  projectId: IdSchema,
  videoId: z.string().trim().min(1).max(200),
  snapshotDay: z.union([z.literal(1), z.literal(3), z.literal(7), z.literal(28), z.literal(90)]),
  capturedAt: z.string().datetime(),
  source: z.enum(['youtube_api', 'manual_import']),
  metrics: z.object({
    views: z.number().int().min(0),
    impressions: z.number().int().min(0).nullable(),
    clickThroughRate: z.number().min(0).max(1).nullable(),
    watchTimeMinutes: z.number().min(0).nullable(),
    averageViewDurationSeconds: z.number().min(0).nullable(),
    averagePercentageViewed: z.number().min(0).max(1).nullable(),
    subscribersGained: z.number().int().nullable(),
    trafficSources: z.record(z.number().min(0)),
    searchTerms: z.record(z.number().min(0)),
    playlistStarts: z.number().int().min(0).nullable(),
    endScreenClicks: z.number().int().min(0).nullable()
  }).strict(),
  retention: z.array(z.object({
    elapsedRatio: z.number().min(0).max(1),
    audienceWatchRatio: z.number().min(0).nullable(),
    relativeRetention: z.number().nullable()
  }).strict()).max(10_000)
}).strict();

export const KeywordMetricObservationSchema = z.object({
  topicCandidateId: IdSchema.optional(),
  keyword: z.string().trim().min(1).max(500),
  provider: z.string().trim().min(1).max(200),
  metricType: z.string().trim().min(1).max(200),
  value: z.number().finite().nullable(),
  geographyCode: z.string().trim().max(30).nullable().optional(),
  languageCode: z.string().trim().min(2).max(35),
  collectedAt: z.string().datetime(),
  confidence: z.number().min(0).max(1),
  youtubeNative: z.boolean(),
  rawMetadata: z.record(z.unknown()).default({})
}).strict().superRefine((input, context) => {
  const normalized = `${input.provider} ${input.metricType}`.toLowerCase();
  if (input.youtubeNative && (normalized.includes('google ads') || normalized.includes('google search'))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['youtubeNative'],
      message: 'Google Search or Google Ads metrics are proxies and cannot be marked YouTube-native.'
    });
  }
});

export const GoogleSheetsSyncSchema = z.object({
  configId: IdSchema.optional(),
  name: z.string().trim().min(1).max(200).optional(),
  spreadsheetId: z.string().trim().min(5).max(500),
  sheetRange: z.string().trim().min(1).max(500),
  validationTemplateId: IdSchema.optional(),
  operationId: IdSchema.optional()
}).strict();

export const ChannelProfileSchema = z.object({
  id: IdSchema.optional(),
  name: z.string().trim().min(1).max(200),
  shortCode: z.string().trim().regex(/^[A-Za-z0-9_-]{1,12}$/),
  defaultLanguageCode: z.string().trim().min(2).max(35),
  defaultVoiceId: z.string().trim().max(200).nullable().optional(),
  youtubeChannelId: z.string().trim().max(200).nullable().optional(),
  youtubeChannelTitle: z.string().trim().max(200).nullable().optional(),
  active: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  policy: z.record(z.unknown()).optional()
}).strict();

export const LanguageVoiceProfileSchema = z.object({
  id: IdSchema.optional(),
  languageCode: z.string().trim().min(2).max(35),
  languageName: z.string().trim().min(1).max(100),
  voiceProvider: z.string().trim().min(1).max(100),
  voiceId: z.string().trim().min(1).max(200),
  displayName: z.string().trim().min(1).max(200),
  active: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  settings: z.record(z.unknown()).optional()
}).strict();

export const AnalyticsCollectSchema = z.object({
  projectId: IdSchema,
  snapshotDay: z.union([z.literal(1), z.literal(3), z.literal(7), z.literal(28), z.literal(90)])
}).strict();

export const LearningRecommendationSchema = z.object({
  metricKey: z.enum(['preferredShotMinSeconds','preferredShotMaxSeconds','targetVideoMinutes']),
  proposedValue: z.number().positive(),
  rationale: z.string().trim().min(20).max(2_000),
  evidenceSnapshotIds: z.array(IdSchema).min(2).max(250)
}).strict();

export const LearningDecisionSchema = z.object({
  id: IdSchema,
  decision: z.enum(['apply','reject','rollback'])
}).strict();

export const MusicImportSchema = z.object({
  filePath: FilePathSchema.optional(),
  title: z.string().trim().min(1).max(300),
  provider: z.string().trim().min(1).max(200),
  licenseType: z.string().trim().min(1).max(200),
  licenseReference: z.string().trim().min(1).max(1_000),
  licenseDocumentPath: FilePathSchema.optional(),
  moods: z.array(z.string().trim().min(1).max(100)).max(25).default([]),
  tempoBpm: z.number().min(20).max(300).nullable().optional(),
  loopable: z.boolean().default(true),
  licenseAttested: z.literal(true)
}).strict();

export const MusicSelectSchema = z.object({
  projectId: IdSchema,
  trackId: IdSchema,
  selectedBy: z.enum(['automatic','human']).default('human')
}).strict();

export const StorageCleanupSchema = z.object({
  dryRun: z.boolean().default(false),
  trigger: z.enum(['manual','disk_pressure','startup']).default('manual')
}).strict();

export const ImportRequestSchema = z.object({
  filePath: FilePathSchema,
  sheetName: z.string().max(250).optional(),
  mapping: z.record(z.string().max(100), z.string().max(250).nullable()).optional(),
  previewId: IdSchema.optional(),
  operationId: IdSchema.optional()
}).strict();

export const SecretPatchSchema = z.object({
  llmApiKey: z.string().optional(),
  visionApiKey: z.string().optional(),
  researchApiKey: z.string().optional(),
  httpTtsApiKey: z.string().optional(),
  youtubeClientId: z.string().optional(),
  youtubeClientSecret: z.string().optional(),
  youtubeApiKey: z.string().optional()
}).strict();

export const ProviderEndpointActionSchema = z.object({
  provider: z.enum(['openai_compatible', 'openai_compatible_vision', 'tavily', 'http_tts'])
}).strict();

const VisionRequirementAssessmentSchema = z.object({
  requirement: z.string().trim().min(1).max(250),
  present: z.boolean().nullable(),
  confidence: z.number().min(0).max(1),
  evidence: z.string().trim().max(1_000)
}).strict();

export const VisionFootageAssessmentSchema = z.object({
  geography: z.object({
    verdict: z.enum(['match', 'mismatch', 'unknown']),
    confidence: z.number().min(0).max(1),
    country: z.string().trim().max(120).nullable(),
    city: z.string().trim().max(120).nullable(),
    location: z.string().trim().max(250).nullable(),
    granularity: z.enum(['country', 'region', 'city', 'neighborhood', 'landmark', 'feature', 'unknown']),
    evidence: z.array(z.string().trim().max(1_000)).max(12)
  }).strict(),
  objects: z.array(VisionRequirementAssessmentSchema).max(40),
  activities: z.array(VisionRequirementAssessmentSchema).max(40),
  disallowedContent: z.array(z.string().trim().max(500)).max(20),
  technicalConcerns: z.array(z.string().trim().max(500)).max(20),
  summary: z.string().trim().min(1).max(2_000)
}).strict();

export const PathChoiceRequestSchema = z.object({
  kind: z.enum(['directory', 'file']),
  title: z.string().max(200).optional(),
  filters: z.array(z.object({
    name: z.string().max(100),
    extensions: z.array(z.string().regex(/^[A-Za-z0-9]+$/)).max(50)
  }).strict()).max(20).optional()
}).strict();

export const CatalogAssetPatchSchema = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  description: NullableText(10_000).optional(),
  country: NullableText(120).optional(),
  city: NullableText(120).optional(),
  locationName: NullableText(250).optional(),
  activity: NullableText(500).optional(),
  shotType: NullableText(250).optional(),
  sceneDescription: NullableText(2_000).optional(),
  objects: NullableText(2_000).optional(),
  timeOfDay: NullableText(250).optional(),
  style: NullableText(500).optional(),
  orientation: z.enum(['landscape', 'portrait', 'square', 'unknown']).optional(),
  locationGranularity: z.enum(['country', 'region', 'city', 'neighborhood', 'landmark', 'feature', 'unknown']).optional(),
  locationConfidence: z.number().min(0).max(1).optional(),
  verificationStatus: z.enum(['unverified', 'metadata', 'ai_suggested', 'human_verified', 'conflict']).optional(),
  availabilityStatus: z.enum(['unknown', 'available', 'unavailable']).optional(),
  excluded: z.boolean().optional()
}).strict();

export const CatalogUpdateAssetSchema = z.object({
  assetId: IdSchema,
  patch: CatalogAssetPatchSchema,
  reason: z.string().trim().min(1).max(500).optional()
}).strict();

export const CatalogBulkUpdateSchema = z.object({
  assetIds: z.array(IdSchema).min(1).max(5_000),
  patch: CatalogAssetPatchSchema,
  reason: z.string().trim().min(1).max(500).optional()
}).strict();

export const CatalogSuggestionSchema = z.object({
  assetId: IdSchema,
  fieldName: z.enum([
    'title','description','country','city','locationName','activity','shotType',
    'sceneDescription','objects','timeOfDay','style','orientation',
    'locationGranularity','locationConfidence','verificationStatus','availabilityStatus','excluded'
  ]),
  value: z.union([
    z.string().max(10_000),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(z.unknown()).max(500),
    z.record(z.unknown())
  ]),
  provider: z.string().trim().min(1).max(200),
  model: z.string().trim().min(1).max(200),
  confidence: z.number().min(0).max(1),
  evidenceRef: z.string().trim().max(2_000).nullable().optional(),
  evidence: z.record(z.unknown()).optional()
}).strict();

export const CatalogReviewSuggestionSchema = z.object({
  assertionId: IdSchema,
  decision: z.enum(['accept','reject'])
}).strict();

export const CatalogExportSchema = z.object({
  request: CatalogSearchRequestSchema,
  outputPath: FilePathSchema.optional()
}).strict();

export const PlaceMergeSchema = z.object({
  sourcePlaceIds: z.array(IdSchema).min(1).max(100),
  targetPlaceId: IdSchema,
  reason: z.string().trim().min(1).max(1_000)
}).strict().refine(value => !value.sourcePlaceIds.includes(value.targetPlaceId), {
  message: 'The merge target cannot also be a source place.'
});

export const PlaceSplitSchema = z.object({
  sourcePlaceId: IdSchema,
  assetIds: z.array(IdSchema).min(1).max(5_000),
  name: z.string().trim().min(1).max(250),
  type: z.enum(['country','region','city','neighborhood','landmark','feature']),
  parentId: IdSchema.nullable(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  aliases: z.array(z.string().trim().min(1).max(250)).max(100).default([]),
  reason: z.string().trim().min(1).max(1_000)
}).strict();

export const AcquisitionAttestSchema = z.object({
  acquisitionId: IdSchema,
  attachCertificate: z.boolean().default(false)
}).strict();

export const AcquisitionBatchAttestSchema = z.object({
  projectId: IdSchema,
  attachCertificate: z.boolean().default(false)
}).strict();

export const AcquisitionMapFileSchema = z.object({
  acquisitionId: IdSchema,
  filePath: FilePathSchema.optional()
}).strict();

const StoryboardReasonSchema = z.string().trim().min(3).max(2_000);
const StoryboardNarrationSchema = z.string().trim().min(1).max(4_000);
const StoryboardGraphicTreatmentSchema = z.enum(['MAP_OR_GRAPHIC', 'TEXT_OR_ARCHIVAL']);

export const StoryboardSceneSchema = z.object({
  projectId: IdSchema,
  sceneId: IdSchema
}).strict();

export const StoryboardReplaceShotSchema = StoryboardSceneSchema.extend({
  candidateId: IdSchema,
  reason: StoryboardReasonSchema
}).strict();

export const StoryboardRewriteBeatSchema = StoryboardSceneSchema.extend({
  narration: StoryboardNarrationSchema,
  reason: StoryboardReasonSchema
}).strict();

export const StoryboardUseGraphicSchema = StoryboardSceneSchema.extend({
  treatment: StoryboardGraphicTreatmentSchema,
  reason: StoryboardReasonSchema
}).strict();

export const StoryboardSplitBeatSchema = StoryboardSceneSchema.extend({
  firstNarration: StoryboardNarrationSchema,
  secondNarration: StoryboardNarrationSchema,
  secondTreatment: StoryboardGraphicTreatmentSchema,
  reason: StoryboardReasonSchema
}).strict();

export const StoryboardMergeBeatsSchema = z.object({
  projectId: IdSchema,
  firstSceneId: IdSchema,
  secondSceneId: IdSchema,
  narration: StoryboardNarrationSchema,
  graphicTreatment: StoryboardGraphicTreatmentSchema.optional(),
  reason: StoryboardReasonSchema
}).strict().refine(request => request.firstSceneId !== request.secondSceneId, {
  message: 'Two distinct adjacent scenes are required for a merge.',
  path: ['secondSceneId']
});

export const StoryboardVerifyLocationSchema = StoryboardSceneSchema.extend({
  reason: StoryboardReasonSchema
}).strict();

export const StoryboardRejectCandidateSchema = StoryboardSceneSchema.extend({
  candidateId: IdSchema,
  reason: StoryboardReasonSchema
}).strict();

export const PackageSelectSchema = z.object({ projectId: IdSchema, packageId: IdSchema }).strict();
export const ExceptionListSchema = z.object({ projectId: IdSchema.optional(), openOnly: z.boolean().optional() }).strict();
export const ExceptionResolveSchema = z.object({
  id: IdSchema,
  resolution: z.record(z.string().max(100), z.unknown()).optional()
}).strict();
export const ExceptionOverrideSchema = z.object({
  id: IdSchema,
  reason: z.string().trim().min(10).max(2_000)
}).strict();
export const ExceptionRetrySchema = z.object({ id: IdSchema }).strict();

export const AmbiguousMappingResolveSchema = z.object({
  exceptionId: IdSchema,
  acquisitionId: IdSchema
}).strict();
export const SemanticVerificationRetrySchema = z.object({ exceptionId: IdSchema }).strict();
export const BackupRestoreSchema = FilePathSchema.optional();
export const ExternalUrlSchema = z.string().url().max(2_000);
export const OpenPathSchema = FilePathSchema;

export const RenderRequestSchema = z.object({
  projectId: IdSchema,
  kind: z.enum(['range', 'draft', 'final']).default('draft'),
  outputProfileKey: z.enum(['landscape_1080p', 'landscape_4k', 'vertical_1080p']).optional(),
  startSceneOrdinal: z.number().int().min(1).optional(),
  endSceneOrdinal: z.number().int().min(1).optional()
}).strict().superRefine((request, context) => {
  const hasRange = request.startSceneOrdinal !== undefined || request.endSceneOrdinal !== undefined;
  if (request.kind === 'range' && !hasRange) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Range renders require at least one scene ordinal.' });
  }
  if (request.kind !== 'range' && hasRange) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Scene ordinals are accepted only for range renders.' });
  }
  if (
    request.startSceneOrdinal !== undefined
    && request.endSceneOrdinal !== undefined
    && request.startSceneOrdinal > request.endSceneOrdinal
  ) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Range start cannot exceed range end.' });
  }
});

export const ApprovePublicationSchema = z.object({
  projectId: IdSchema,
  action: z.enum(['keep_private', 'publish', 'schedule']),
  scheduledAt: z.string().datetime().optional()
});

export const YouTubeAuthorizationConfirmationSchema = z.object({
  pendingAuthorizationId: IdSchema,
  expectedChannelId: IdSchema,
  replaceExisting: z.boolean()
}).strict();

export const YouTubeAuthorizationCancellationSchema = z.object({
  pendingAuthorizationId: IdSchema
}).strict();

export const FinalReviewRevisionSchema = z.object({
  projectId: IdSchema,
  category: z.enum([
    'packaging',
    'caption_typo',
    'voice_pronunciation',
    'script_factual_issue',
    'wrong_or_weak_shot',
    'new_footage_required',
    'major_story_change'
  ]),
  note: z.string().trim().min(3).max(2_000),
  affectedSceneId: IdSchema.optional(),
  affectedSectionId: IdSchema.optional(),
  pronunciation: z.object({
    term: z.string().trim().min(1).max(200),
    value: z.string().trim().min(1).max(500)
  }).strict().optional()
}).strict().superRefine((request, context) => {
  if (request.category === 'voice_pronunciation') {
    if (!request.affectedSceneId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['affectedSceneId'], message: 'A pronunciation revision requires an affected scene.' });
    }
    if (!request.pronunciation) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['pronunciation'], message: 'A pronunciation revision requires the corrected term and pronunciation.' });
    }
  } else if (request.pronunciation) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['pronunciation'], message: 'Pronunciation data is accepted only for voice-pronunciation revisions.' });
  }
});

export const SceneContractSchema = z.object({
  sceneId: IdSchema,
  narration: z.string().min(1),
  requiredGeography: z.object({
    country: z.string().nullable(),
    city: z.string().nullable(),
    location: z.string().nullable(),
    granularity: z.enum(['country', 'region', 'city', 'neighborhood', 'landmark', 'feature', 'unknown'])
  }),
  allowedTreatments: z.array(
    z.enum([
      'EXACT_LOCATION_FOOTAGE',
      'CONTEXTUAL_VERIFIED_FOOTAGE',
      'MAP_OR_GRAPHIC',
      'TEXT_OR_ARCHIVAL'
    ])
  ).min(1),
  requiredObjects: z.array(z.string()).default([]),
  requiredActivities: z.array(z.string()).default([]),
  preferredShots: z.array(z.string()).default([]),
  disallowedContent: z.array(z.string()).default([]),
  targetDurationMs: z.number().int().min(1500).max(7000),
  maxVisualDurationMs: z.number().int().max(7000),
  selectedAssetId: z.string().nullable(),
  selectedSegmentId: z.string().nullable(),
  verificationState: z.enum(['metadata_only', 'download_required', 'verified', 'rejected', 'graphic'])
});

export const StructuredScriptSchema = z.object({
  title: z.string().min(1),
  topic: z.string().min(1),
  destination: z.string().min(1),
  summary: z.string(),
  scenes: z.array(z.object({
    chapter: z.string().nullable().default(null),
    narration: z.string().min(1),
    targetDurationMs: z.number().int().min(1500).max(7000),
    requiredCountry: z.string().nullable(),
    requiredCity: z.string().nullable(),
    requiredLocation: z.string().nullable(),
    requiredGranularity: z.enum(['country', 'region', 'city', 'neighborhood', 'landmark', 'feature', 'unknown']),
    requiredObjects: z.array(z.string()).default([]),
    requiredActivities: z.array(z.string()).default([]),
    preferredShots: z.array(z.string()).default([]),
    visualTreatment: z.enum([
      'EXACT_LOCATION_FOOTAGE',
      'CONTEXTUAL_VERIFIED_FOOTAGE',
      'MAP_OR_GRAPHIC',
      'TEXT_OR_ARCHIVAL'
    ]),
    claimIds: z.array(z.string().trim().min(1).max(200)).max(20).default([])
})).min(3)
});

export const FinalScriptRewriteSchema = z.object({
  scenes: z.array(z.object({
    sceneId: IdSchema,
    narration: z.string().trim().min(1).max(1_200),
    pronunciation: z.record(
      z.string().trim().min(1).max(200),
      z.string().trim().min(1).max(300)
    ).refine(value => Object.keys(value).length <= 50, 'A scene may contain at most 50 pronunciation overrides.')
  }).strict()).min(1).max(500)
}).strict();

export type FinalScriptRewrite = z.infer<typeof FinalScriptRewriteSchema>;

export interface StructuredScriptScene {
  chapter: string | null;
  narration: string;
  targetDurationMs: number;
  requiredCountry: string | null;
  requiredCity: string | null;
  requiredLocation: string | null;
  requiredGranularity: CatalogAsset['locationGranularity'];
  requiredObjects: string[];
  requiredActivities: string[];
  preferredShots: string[];
  visualTreatment: VisualTreatment;
  claimIds: string[];
}

export interface StructuredScript {
  title: string;
  topic: string;
  destination: string;
  summary: string;
  scenes: StructuredScriptScene[];
}

export { IPC } from './ipc-channels';
