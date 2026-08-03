import { app } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { AppSettings } from '@shared/types';

function ensure(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

export function defaultDataRoot(): string {
  const override = process.env.VIDEOFACTORY_DEV_DATA_ROOT?.trim();
  if (override) return resolve(override);
  return join(app.getPath('documents'), 'VideoFactory');
}

export function buildDefaultSettings(dataRoot = defaultDataRoot()): AppSettings {
  const data = ensure(join(dataRoot, 'data'));
  const ingest = ensure(join(dataRoot, 'ingest', 'envato'));
  const media = ensure(join(dataRoot, 'media'));
  const projects = ensure(join(dataRoot, 'projects'));
  const output = ensure(join(dataRoot, 'output'));
  const backups = ensure(join(dataRoot, 'backups'));

  ensure(join(media, 'originals'));
  ensure(join(media, 'proxies'));
  ensure(join(media, 'keyframes'));
  ensure(join(media, 'segments'));
  ensure(join(media, 'quarantine'));
  ensure(join(output, 'draft'));
  ensure(join(output, 'review'));
  ensure(join(output, 'published'));

  return {
    dataRoot,
    databasePath: join(data, 'videofactory.sqlite'),
    ingestFolder: ingest,
    mediaLibraryFolder: media,
    projectFolder: projects,
    outputFolder: output,
    backupFolder: backups,
    ffmpegPath: '',
    ffprobePath: '',
    monthlyBudgetUsd: 100,
    minFreeDiskGb: 25,
    maxActiveProjects: 2,
    maxWaitingDownloads: 1,
    maxPrivateApproval: 1,
    targetVideoMinutes: 5,
    defaultOutput: '1080p',
    preferredShotMinSeconds: 3,
    preferredShotMaxSeconds: 5.5,
    hardShotMaxSeconds: 7,
    narratorProvider: 'windows_sapi',
    narratorVoice: '',
    narratorRate: 0,
    llmProvider: 'mock',
    llmBaseUrl: 'https://api.openai.com/v1',
    llmModel: 'gpt-4.1-mini',
    youtubeCategoryId: '19',
    youtubePlaylistId: '',
    youtubePrivacy: 'private',
    channelName: '',
    channelShort: 'TRAVEL',
    autoStartWithWindows: false,
    autoUploadPrivate: false,
    preferredCountries: [],
    blockedCountries: []
  };
}

export function ensureSettingsPaths(settings: AppSettings): void {
  const directoryPaths = [
    settings.dataRoot,
    dirname(settings.databasePath),
    settings.ingestFolder,
    settings.mediaLibraryFolder,
    settings.projectFolder,
    settings.outputFolder,
    settings.backupFolder,
    join(settings.mediaLibraryFolder, 'originals'),
    join(settings.mediaLibraryFolder, 'proxies'),
    join(settings.mediaLibraryFolder, 'keyframes'),
    join(settings.mediaLibraryFolder, 'segments'),
    join(settings.mediaLibraryFolder, 'quarantine'),
    join(settings.outputFolder, 'draft'),
    join(settings.outputFolder, 'review'),
    join(settings.outputFolder, 'published')
  ];
  for (const path of directoryPaths) {
    if (!existsSync(path)) mkdirSync(path, { recursive: true });
  }
}
