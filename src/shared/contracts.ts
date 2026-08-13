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
  orientation: z.string().trim().max(40).optional(),
  downloaded: z.boolean().optional(),
  verified: z.boolean().optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(10).max(500).default(100),
  sortBy: z.enum(['title', 'country', 'city', 'location', 'updated']).optional(),
  sortDirection: z.enum(['asc', 'desc']).optional()
});

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
  preferredShotMinSeconds: z.number().min(1.5).max(7).optional(),
  preferredShotMaxSeconds: z.number().min(1.5).max(7).optional(),
  hardShotMaxSeconds: z.number().min(2).max(7).optional(),
  narratorProvider: z.enum(['windows_sapi', 'http_tts']).optional(),
  narratorBaseUrl: z.string().url().max(2_000).optional(),
  narratorModel: z.string().trim().min(1).max(200).optional(),
  narratorVoice: z.string().max(200).optional(),
  narratorRate: z.number().min(-10).max(10).optional(),
  pronunciationDictionary: z.record(
    z.string().trim().min(1).max(200),
    z.string().trim().min(1).max(300)
  ).refine(value => Object.keys(value).length <= 500, 'Pronunciation dictionary is limited to 500 entries.').optional(),
  llmProvider: z.enum(['mock', 'openai_compatible']).optional(),
  llmBaseUrl: z.string().url().max(2_000).optional(),
  llmModel: z.string().trim().min(1).max(200).optional(),
  visionProvider: z.enum(['disabled', 'openai_compatible']).optional(),
  visionBaseUrl: z.string().url().max(2_000).optional(),
  visionModel: z.string().trim().min(1).max(200).optional(),
  visionMinimumConfidence: z.number().min(0.5).max(0.99).optional(),
  researchProvider: z.enum(['disabled', 'tavily']).optional(),
  researchBaseUrl: z.string().url().max(2_000).optional(),
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
  destinationKey: z.string().max(500).optional(),
  targetMinutes: z.number().min(1).max(30).optional(),
  topicId: z.string().max(200).optional()
});

export const IdSchema = z.string().min(1).max(200);

export const ImportRequestSchema = z.object({
  filePath: FilePathSchema,
  sheetName: z.string().max(250).optional(),
  mapping: z.record(z.string().max(100), z.string().max(250).nullable()).optional()
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

export const AcquisitionAttestSchema = z.object({
  acquisitionId: IdSchema,
  certificatePath: FilePathSchema.optional()
}).strict();

export const AcquisitionMapFileSchema = z.object({
  acquisitionId: IdSchema,
  filePath: FilePathSchema.optional()
}).strict();

export const PackageSelectSchema = z.object({ projectId: IdSchema, packageId: IdSchema }).strict();
export const ExceptionListSchema = z.object({ projectId: IdSchema.optional(), openOnly: z.boolean().optional() }).strict();
export const ExceptionResolveSchema = z.object({
  id: IdSchema,
  resolution: z.record(z.string().max(100), z.unknown()).optional()
}).strict();
export const SemanticVerificationRetrySchema = z.object({ exceptionId: IdSchema }).strict();
export const BackupRestoreSchema = FilePathSchema.optional();
export const ExternalUrlSchema = z.string().url().max(2_000);
export const OpenPathSchema = FilePathSchema;

export const RenderRequestSchema = z.object({
  projectId: IdSchema,
  kind: z.enum(['range', 'draft', 'final']).default('draft'),
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
