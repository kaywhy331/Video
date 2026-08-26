import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase } from '@main/database/database';
import { SettingsProfileService, UpdateService, compareVersions } from '@main/services/operations-service';
import type { AppSettings } from '@shared/types';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function settings(root: string): AppSettings {
  return {
    dataRoot: root,
    databasePath: join(root, 'db.sqlite'),
    ingestFolder: join(root, 'ingest'),
    mediaLibraryFolder: join(root, 'media'),
    projectFolder: join(root, 'projects'),
    outputFolder: join(root, 'output'),
    backupFolder: join(root, 'backups'),
    backupIntervalHours: 24,
    backupDailyRetention: 7,
    backupWeeklyRetention: 4,
    backupMonthlyRetention: 6,
    catalogImportFile: '',
    catalogRefreshEnabled: false,
    catalogRefreshIntervalHours: 24,
    catalogValidationTemplateId: 'envato-default',
    autopilotSchedulerEnabled: false,
    autopilotCadenceDays: 7,
    autopilotPublicationHourUtc: 17,
    musicEnabled: false,
    musicTargetGainDb: -24,
    musicDuckingDb: -12,
    automaticDerivativeCleanup: true,
    derivativeCleanupTargetGb: 5,
    ffmpegPath: '',
    ffprobePath: '',
    monthlyBudgetUsd: 100,
    projectBudgetUsd: 15,
    minFreeDiskGb: 25,
    maxActiveProjects: 2,
    maxWaitingDownloads: 1,
    maxPrivateApproval: 1,
    targetVideoMinutes: 5,
    defaultOutput: '1080p',
    updateChannel: 'prerelease',
    updateCheckEnabled: true,
    preferredShotMinSeconds: 3,
    preferredShotMaxSeconds: 5.5,
    hardShotMaxSeconds: 7,
    matchingMaxSourceUses: 2,
    matchingMaxConsecutiveShotMotion: 2,
    matchingPerceptualDistance: 6,
    matchingHeroStrategy: 'opening',
    narratorProvider: 'windows_sapi', narratorBaseUrl: 'https://api.example.test', narratorEndpointTrust: 'custom_remote', narratorModel: 'default', narratorVoice: '', narratorRate: 0,
    pronunciationDictionary: {}, llmProvider: 'mock', llmBaseUrl: 'https://api.example.test', llmEndpointTrust: 'custom_remote', llmModel: 'local',
    visionProvider: 'disabled', visionBaseUrl: 'https://api.example.test', visionEndpointTrust: 'custom_remote', visionModel: 'local', visionMinimumConfidence: 0.82,
    researchProvider: 'disabled', researchBaseUrl: 'https://api.example.test', researchEndpointTrust: 'custom_remote', researchSearchDepth: 'basic', researchMaxResultsPerQuery: 5,
    youtubeCategoryId: '19', youtubePlaylistId: '', youtubePrivacy: 'private', youtubeSyntheticMediaDisclosure: true,
    channelName: 'Fixture', channelShort: 'FIXTURE', autoStartWithWindows: false, autoUploadPrivate: false,
    preferredCountries: [], blockedCountries: []
  };
}

describe('operational profiles and release discovery', () => {
  it('exports a secret-free portable profile and imports validated settings without replacing active storage', async () => {
    const root = mkdtempSync(join(tmpdir(), 'videofactory-profile-'));
    roots.push(root);
    const db = new AppDatabase(join(root, 'db.sqlite'));
    let current = settings(root);
    const service = new SettingsProfileService(db, () => current, async patch => {
      current = { ...current, ...patch };
      return current;
    }, '0.1.0-alpha.3');
    const path = join(root, 'backups', 'profile.json');
    const exported = service.export(path);
    const payload = readFileSync(path, 'utf8');
    expect(payload).not.toContain('databasePath');
    expect(payload).not.toContain('dataRoot');
    expect(payload).not.toContain('apiKey');
    expect(exported.warnings[0]).toContain('Credentials');

    const decoded = JSON.parse(payload) as { settings: Record<string, unknown> };
    decoded.settings.defaultOutput = 'qualified_4k';
    decoded.settings.maxActiveProjects = 3;
    decoded.settings.llmBaseUrl = 'https://replacement-provider.example/v1';
    decoded.settings.llmEndpointTrust = 'custom_remote';
    decoded.settings.databasePath = '/unsafe/replacement.sqlite';
    writeFileSync(path, JSON.stringify(decoded), 'utf8');
    const imported = await service.import(path);
    expect(imported.appliedKeys).toContain('defaultOutput');
    expect(imported.warnings).toContain('databasePath was ignored because active storage migration requires a controlled operation.');
    expect(imported.warnings).toContain('Language provider endpoint changes were applied as an untrusted proposal; confirm the saved canonical origin locally before use.');
    expect(current.defaultOutput).toBe('qualified_4k');
    expect(current.databasePath).toBe(join(root, 'db.sqlite'));
    expect(db.raw.prepare('SELECT count(*) AS count FROM settings_profile_operations').get()).toEqual({ count: 2 });
    db.close();
  });

  it('compares prereleases and records a newer GitHub release without installing it', async () => {
    expect(compareVersions('0.1.0-alpha.4', '0.1.0-alpha.3')).toBeGreaterThan(0);
    expect(compareVersions('0.1.0', '0.1.0-alpha.99')).toBeGreaterThan(0);
    const root = mkdtempSync(join(tmpdir(), 'videofactory-update-'));
    roots.push(root);
    const db = new AppDatabase(join(root, 'db.sqlite'));
    const request = vi.fn(async () => new Response(JSON.stringify([
      { tag_name: 'v0.1.0-alpha.4', html_url: 'https://github.com/kaywhy331/Video/releases/tag/v0.1.0-alpha.4', draft: false, prerelease: true }
    ]), { status: 200, headers: { 'content-type': 'application/json' } }));
    const service = new UpdateService(db, () => settings(root), '0.1.0-alpha.3', request as typeof fetch);
    const result = await service.check();
    expect(result).toMatchObject({ status: 'available', latestVersion: '0.1.0-alpha.4', available: true });
    expect(result.releaseUrl).toContain('github.com/kaywhy331/Video/releases');
    expect(service.latest()).toEqual(result);
    expect(request).toHaveBeenCalledOnce();
    db.close();
  });
});
