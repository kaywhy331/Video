import { describe, expect, it } from 'vitest';
import { CatalogUpdateAssetSchema, PathChoiceRequestSchema, SettingsPatchSchema } from '@shared/contracts';

describe('IPC request contracts', () => {
  it('rejects unknown settings keys and unsafe policy values', () => {
    expect(SettingsPatchSchema.safeParse({ maxActiveProjects: 3 }).success).toBe(true);
    expect(SettingsPatchSchema.safeParse({ maxActiveProjects: 0 }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ backupIntervalHours: 24, backupDailyRetention: 7 }).success).toBe(true);
    expect(SettingsPatchSchema.safeParse({ backupIntervalHours: 0 }).success).toBe(false);
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
});
