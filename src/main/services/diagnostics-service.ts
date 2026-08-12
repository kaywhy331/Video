import { constants, accessSync, existsSync, statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AppDatabase } from '../database/database';
import type { AppSettings, DiagnosticsReport } from '@shared/types';
import { resolveFfmpeg, resolveFfprobe } from '../tool-paths';
import { runProcess } from './process-utils';

function pathInfo(key: string, path: string): DiagnosticsReport['paths'][number] {
  const exists = existsSync(path);
  let writable = false;
  let freeBytes: number | undefined;
  try {
    accessSync(exists ? path : dirname(path), constants.W_OK);
    writable = true;
  } catch {
    writable = false;
  }
  try {
    const stats = statfsSync(exists ? path : dirname(path));
    freeBytes = stats.bavail * stats.bsize;
  } catch {
    freeBytes = undefined;
  }
  return { key, path, exists, writable, ...(freeBytes === undefined ? {} : { freeBytes }) };
}

export class DiagnosticsService {
  constructor(
    private readonly db: AppDatabase,
    private readonly settings: () => AppSettings,
    private readonly appVersion: string
  ) {}

  async run(): Promise<DiagnosticsReport> {
    const settings = this.settings();
    const ffmpegPath = resolveFfmpeg(settings.ffmpegPath);
    const ffprobePath = resolveFfprobe(settings.ffprobePath);
    const report: DiagnosticsReport = {
      checkedAt: new Date().toISOString(),
      platform: `${process.platform}-${process.arch}`,
      appVersion: this.appVersion,
      paths: [
        pathInfo('Data root', settings.dataRoot),
        pathInfo('Database', settings.databasePath),
        pathInfo('Ingest folder', settings.ingestFolder),
        pathInfo('Media library', settings.mediaLibraryFolder),
        pathInfo('Projects', settings.projectFolder),
        pathInfo('Output', settings.outputFolder),
        pathInfo('Backups', settings.backupFolder)
      ],
      ffmpeg: { found: Boolean(ffmpegPath), path: ffmpegPath ?? undefined, encoders: [] },
      ffprobe: { found: Boolean(ffprobePath), path: ffprobePath ?? undefined },
      database: {
        path: this.db.path,
        open: this.db.raw.open,
        integrity: this.db.integrityCheck(),
        walMode: String(this.db.raw.pragma('journal_mode', { simple: true })).toLowerCase() === 'wal'
      }
    };

    if (ffmpegPath) {
      const version = await runProcess(ffmpegPath, ['-hide_banner', '-version']);
      report.ffmpeg.version = version.stdout.split(/\r?\n/)[0] ?? version.stderr.split(/\r?\n/)[0];
      const encoders = await runProcess(ffmpegPath, ['-hide_banner', '-encoders']);
      const all = `${encoders.stdout}\n${encoders.stderr}`;
      const encoderCandidates: Array<readonly [needle: string, label: string]> = [
        ['h264_nvenc', 'NVIDIA NVENC'],
        ['h264_qsv', 'Intel Quick Sync'],
        ['h264_amf', 'AMD AMF'],
        ['libx264', 'Software H.264']
      ];
      report.ffmpeg.encoders = encoderCandidates
        .filter(([needle]) => all.includes(needle))
        .map(([, label]) => label);
      if (version.code !== 0) report.ffmpeg.error = version.stderr || `Exit code ${version.code}`;
    } else {
      report.ffmpeg.error = 'FFmpeg was not found.';
    }

    if (ffprobePath) {
      const version = await runProcess(ffprobePath, ['-hide_banner', '-version']);
      report.ffprobe.version = version.stdout.split(/\r?\n/)[0] ?? version.stderr.split(/\r?\n/)[0];
      if (version.code !== 0) report.ffprobe.error = version.stderr || `Exit code ${version.code}`;
    } else {
      report.ffprobe.error = 'FFprobe was not found.';
    }

    return report;
  }
}
