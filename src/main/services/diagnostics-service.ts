import { randomUUID } from 'node:crypto';
import { constants, accessSync, existsSync, mkdtempSync, rmSync, statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

  latest(maxAgeMs = 24 * 60 * 60 * 1_000, now = new Date()): DiagnosticsReport | null {
    const row = this.db.raw.prepare(`
      SELECT report_json, created_at FROM diagnostic_runs
      ORDER BY created_at DESC LIMIT 1
    `).get() as { report_json: string; created_at: string } | undefined;
    if (!row) return null;
    const checkedAt = Date.parse(row.created_at);
    if (!Number.isFinite(checkedAt) || now.getTime() - checkedAt > maxAgeMs) return null;

    let report: DiagnosticsReport;
    try {
      report = JSON.parse(row.report_json) as DiagnosticsReport;
    } catch {
      return null;
    }
    const settings = this.settings();
    const expectedPaths = new Map([
      ['Data root', settings.dataRoot],
      ['Database', settings.databasePath],
      ['Ingest folder', settings.ingestFolder],
      ['Media library', settings.mediaLibraryFolder],
      ['Projects', settings.projectFolder],
      ['Output', settings.outputFolder],
      ['Backups', settings.backupFolder]
    ]);
    const reportedPaths = new Map(report.paths.map(item => [item.key, item.path]));
    const pathsMatch = [...expectedPaths].every(([key, path]) => reportedPaths.get(key) === path);
    const ffmpegPath = resolveFfmpeg(settings.ffmpegPath) ?? null;
    const ffprobePath = resolveFfprobe(settings.ffprobePath) ?? null;
    if (
      report.appVersion !== this.appVersion
      || report.platform !== `${process.platform}-${process.arch}`
      || !pathsMatch
      || (report.ffmpeg.path ?? null) !== ffmpegPath
      || (report.ffprobe.path ?? null) !== ffprobePath
    ) return null;
    return report;
  }

  async run(): Promise<DiagnosticsReport> {
    const settings = this.settings();
    const ffmpegPath = resolveFfmpeg(settings.ffmpegPath);
    const ffprobePath = resolveFfprobe(settings.ffprobePath);
    const savedRunId = randomUUID();
    const encoderCandidates: Array<readonly [
      id: DiagnosticsReport['ffmpeg']['encoderTests'][number]['id'],
      label: string
    ]> = [
      ['h264_nvenc', 'NVIDIA NVENC'],
      ['h264_qsv', 'Intel Quick Sync'],
      ['h264_amf', 'AMD AMF'],
      ['libx264', 'Software H.264']
    ];
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
      ffmpeg: {
        found: Boolean(ffmpegPath),
        path: ffmpegPath ?? undefined,
        encoders: [],
        encoderTests: encoderCandidates.map(([id, label]) => ({ id, label, advertised: false, usable: false }))
      },
      ffprobe: { found: Boolean(ffprobePath), path: ffprobePath ?? undefined },
      database: {
        path: this.db.path,
        open: this.db.raw.open,
        integrity: this.db.integrityCheck(),
        walMode: String(this.db.raw.pragma('journal_mode', { simple: true })).toLowerCase() === 'wal'
      },
      mediaSmokeTest: { encoded: false, probed: false },
      issues: [],
      status: 'fail',
      savedRunId
    };

    if (ffmpegPath) {
      const version = await runProcess(ffmpegPath, ['-hide_banner', '-version']);
      report.ffmpeg.version = version.stdout.split(/\r?\n/)[0] ?? version.stderr.split(/\r?\n/)[0];
      const encoders = await runProcess(ffmpegPath, ['-hide_banner', '-encoders']);
      const all = `${encoders.stdout}\n${encoders.stderr}`;
      report.ffmpeg.encoders = encoderCandidates
        .filter(([needle]) => all.includes(needle))
        .map(([, label]) => label);
      for (const [id, label] of encoderCandidates) {
        const advertised = all.includes(id);
        if (!advertised) continue;
        const trial = await runProcess(ffmpegPath, [
          '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
          '-i', 'color=c=black:s=64x64:r=1:d=1', '-frames:v', '1', '-an',
          '-c:v', id, '-f', 'null', '-'
        ]);
        const index = report.ffmpeg.encoderTests.findIndex(item => item.id === id);
        report.ffmpeg.encoderTests[index] = {
          id,
          label,
          advertised,
          usable: trial.code === 0,
          ...(trial.code === 0 ? {} : { error: (trial.stderr || `Exit code ${trial.code}`).slice(0, 1_000) })
        };
      }
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

    if (ffmpegPath && ffprobePath) {
      const root = mkdtempSync(join(tmpdir(), 'videofactory-diagnostic-'));
      const output = join(root, 'smoke.mp4');
      try {
        const encode = await runProcess(ffmpegPath, [
          '-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
          '-i', 'color=c=black:s=128x72:r=30:d=0.2', '-frames:v', '6', '-an',
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output
        ]);
        report.mediaSmokeTest.encoded = encode.code === 0 && existsSync(output);
        if (!report.mediaSmokeTest.encoded) throw new Error(encode.stderr || `Diagnostic encode exited ${encode.code}.`);
        const probe = await runProcess(ffprobePath, [
          '-v', 'error', '-select_streams', 'v:0', '-show_entries',
          'stream=codec_name,width,height,pix_fmt', '-of', 'json', output
        ]);
        const parsed = probe.code === 0 ? JSON.parse(probe.stdout) as { streams?: Array<Record<string, unknown>> } : {};
        const stream = parsed.streams?.[0];
        report.mediaSmokeTest.probed = Boolean(
          stream?.codec_name === 'h264' && stream.width === 128 && stream.height === 72 && stream.pix_fmt === 'yuv420p'
        );
        if (!report.mediaSmokeTest.probed) throw new Error(probe.stderr || 'Diagnostic probe did not confirm the expected H.264 test media.');
      } catch (error) {
        report.mediaSmokeTest.error = error instanceof Error ? error.message : String(error);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }

    const minimumFreeBytes = settings.minFreeDiskGb * 1024 ** 3;
    for (const path of report.paths) {
      if (!path.exists) report.issues.push(`${path.key} does not exist.`);
      if (!path.writable) report.issues.push(`${path.key} is not writable.`);
      if (path.freeBytes !== undefined && path.freeBytes < minimumFreeBytes) {
        report.issues.push(`${path.key} has less than ${settings.minFreeDiskGb} GB free.`);
      }
    }
    if (!report.ffmpeg.found || report.ffmpeg.error) report.issues.push(report.ffmpeg.error ?? 'FFmpeg is unavailable.');
    if (!report.ffprobe.found || report.ffprobe.error) report.issues.push(report.ffprobe.error ?? 'FFprobe is unavailable.');
    if (!report.ffmpeg.encoderTests.some(test => test.id === 'libx264' && test.usable)) {
      report.issues.push('Software H.264 encoder test failed; no guaranteed fallback is usable.');
    }
    if (!report.mediaSmokeTest.encoded || !report.mediaSmokeTest.probed) {
      report.issues.push(report.mediaSmokeTest.error ?? 'Media encode/probe smoke test failed.');
    }
    if (!report.database.open || report.database.integrity !== 'ok' || !report.database.walMode) {
      report.issues.push('Database health, integrity, or WAL mode failed validation.');
    }
    const hardFailure = report.issues.length > 0;
    report.status = hardFailure ? 'fail'
      : report.ffmpeg.encoderTests.some(test => test.id !== 'libx264' && test.usable) ? 'pass' : 'warning';
    this.db.raw.prepare(`
      INSERT INTO diagnostic_runs(id, status, report_json, app_version, platform, created_at)
      VALUES(?, ?, ?, ?, ?, ?)
    `).run(savedRunId, report.status, JSON.stringify(report), report.appVersion, report.platform, report.checkedAt);

    return report;
  }
}
