import { describe, expect, it } from 'vitest';
import {
  CatalogUpdateAssetSchema,
  PathChoiceRequestSchema,
  ProjectExportSchema,
  ProjectRebuildSchema,
  RenderRequestSchema,
  SemanticVerificationRetrySchema,
  SettingsPatchSchema
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
    expect(SettingsPatchSchema.safeParse({ youtubePrivacy: 'public' }).success).toBe(false);
  });

  it('rejects unknown asset patch fields and out-of-range confidence', () => {
    expect(CatalogUpdateAssetSchema.safeParse({ assetId: 'a', patch: { city: 'Paris', locationConfidence: 0.9 } }).success).toBe(true);
    expect(CatalogUpdateAssetSchema.safeParse({ assetId: 'a', patch: { stableKey: 'hijack' } }).success).toBe(false);
    expect(CatalogUpdateAssetSchema.safeParse({ assetId: 'a', patch: { locationConfidence: 4 } }).success).toBe(false);
  });

  it('bounds file-picker filters', () => {
    expect(PathChoiceRequestSchema.safeParse({ kind: 'file', filters: [{ name: 'Video', extensions: ['mp4'] }] }).success).toBe(true);
    expect(PathChoiceRequestSchema.safeParse({ kind: 'shell', command: 'calc.exe' }).success).toBe(false);
  });

  it('accepts only a bounded semantic retry exception identifier', () => {
    expect(SemanticVerificationRetrySchema.safeParse({ exceptionId: 'exception-1' }).success).toBe(true);
    expect(SemanticVerificationRetrySchema.safeParse({ exceptionId: '' }).success).toBe(false);
    expect(SemanticVerificationRetrySchema.safeParse({ exceptionId: 'exception-1', force: true }).success).toBe(false);
  });

  it('accepts bounded range renders without leaking range fields into full renders', () => {
    expect(RenderRequestSchema.safeParse({ projectId: 'p1', kind: 'range', startSceneOrdinal: 3, endSceneOrdinal: 5 }).success).toBe(true);
    expect(RenderRequestSchema.safeParse({ projectId: 'p1', kind: 'range' }).success).toBe(false);
    expect(RenderRequestSchema.safeParse({ projectId: 'p1', kind: 'range', startSceneOrdinal: 5, endSceneOrdinal: 3 }).success).toBe(false);
    expect(RenderRequestSchema.safeParse({ projectId: 'p1', kind: 'final', startSceneOrdinal: 1 }).success).toBe(false);
  });

  it('bounds project portability actions', () => {
    expect(ProjectExportSchema.safeParse({ projectId: 'p1', includeOriginals: true, includeFinalOutput: false }).success).toBe(true);
    expect(ProjectExportSchema.safeParse({ projectId: 'p1', arbitraryPath: '/tmp' }).success).toBe(false);
    expect(ProjectRebuildSchema.safeParse({ projectId: 'p1' }).success).toBe(true);
    expect(ProjectRebuildSchema.safeParse({ projectId: '' }).success).toBe(false);
  });
});
