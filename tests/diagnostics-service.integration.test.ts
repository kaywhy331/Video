import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { AppDatabase } from '@main/database/database';
import { DiagnosticsService } from '@main/services/diagnostics-service';
import type { AppSettings } from '@shared/types';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('persisted system diagnostics', () => {
  it('exercises a usable H.264 fallback, performs an encode/probe round trip, and saves the report', async () => {
    if (!ffmpegPath) throw new Error('ffmpeg-static is unavailable.');
    const root = mkdtempSync(join(tmpdir(), 'videofactory-diagnostics-'));
    roots.push(root);
    const db = new AppDatabase(join(root, 'videofactory.sqlite'));
    const settings = {
      dataRoot: root,
      databasePath: db.path,
      ingestFolder: root,
      mediaLibraryFolder: root,
      projectFolder: root,
      outputFolder: root,
      backupFolder: root,
      ffmpegPath,
      ffprobePath: ffprobeStatic.path,
      minFreeDiskGb: 1
    } as AppSettings;
    const service = new DiagnosticsService(db, () => settings, 'test-version');
    const report = await service.run();
    expect(report.mediaSmokeTest).toEqual({ encoded: true, probed: true });
    expect(report.ffmpeg.encoderTests).toContainEqual(expect.objectContaining({ id: 'libx264', advertised: true, usable: true }));
    expect(report.status).not.toBe('fail');
    expect(db.raw.prepare('SELECT id, status, app_version FROM diagnostic_runs WHERE id = ?').get(report.savedRunId))
      .toEqual({ id: report.savedRunId, status: report.status, app_version: 'test-version' });
    expect(service.latest()).toEqual(report);
    expect(db.raw.prepare('SELECT count(*) AS count FROM diagnostic_runs').get()).toEqual({ count: 1 });
    db.close();
  }, 30_000);

  it('invalidates a cached report when a diagnostic input changes or the report expires', async () => {
    if (!ffmpegPath) throw new Error('ffmpeg-static is unavailable.');
    const root = mkdtempSync(join(tmpdir(), 'videofactory-diagnostics-cache-'));
    roots.push(root);
    const db = new AppDatabase(join(root, 'videofactory.sqlite'));
    const settings = {
      dataRoot: root,
      databasePath: db.path,
      ingestFolder: root,
      mediaLibraryFolder: root,
      projectFolder: root,
      outputFolder: root,
      backupFolder: root,
      ffmpegPath,
      ffprobePath: ffprobeStatic.path,
      minFreeDiskGb: 1
    } as AppSettings;
    const service = new DiagnosticsService(db, () => settings, 'test-version');
    const report = await service.run();
    expect(service.latest(60_000, new Date(report.checkedAt))).toEqual(report);
    settings.outputFolder = join(root, 'changed-output');
    expect(service.latest(60_000, new Date(report.checkedAt))).toBeNull();
    settings.outputFolder = root;
    expect(service.latest(1, new Date(Date.parse(report.checkedAt) + 2))).toBeNull();
    db.close();
  }, 30_000);
});
