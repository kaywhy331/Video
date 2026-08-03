import { z } from 'zod';
import type { CatalogAsset, VisualTreatment } from './types';

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

export const SettingsPatchSchema = z.record(z.string(), z.unknown());

export const CreateAutopilotProjectSchema = z.object({
  destinationKey: z.string().max(500).optional(),
  targetMinutes: z.number().min(1).max(30).optional(),
  topicId: z.string().max(200).optional()
});

export const IdSchema = z.string().min(1).max(200);

export const ImportRequestSchema = z.object({
  filePath: z.string().min(1),
  sheetName: z.string().optional(),
  mapping: z.record(z.string(), z.string().nullable()).optional()
});

export const SecretPatchSchema = z.object({
  llmApiKey: z.string().optional(),
  httpTtsApiKey: z.string().optional(),
  youtubeClientId: z.string().optional(),
  youtubeClientSecret: z.string().optional(),
  youtubeApiKey: z.string().optional()
});

export const RenderRequestSchema = z.object({
  projectId: IdSchema,
  kind: z.enum(['draft', 'final']).default('draft')
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
    ])
  })).min(3)
});

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
}

export interface StructuredScript {
  title: string;
  topic: string;
  destination: string;
  summary: string;
  scenes: StructuredScriptScene[];
}

export { IPC } from './ipc-channels';
