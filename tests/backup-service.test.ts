import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AppSettings } from '@shared/types';
import { SqliteConnection, type AppDatabase } from '@main/database/database';
import { BackupService } from '@main/services/backup-service';

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'videofactory-backup-'));
  roots.push(root);
  const databasePath = join(root, 'data', 'videofactory.sqlite');
  const backupFolder = join(root, 'backups');
  mkdirSync(join(root, 'data'), { recursive: true });
  const raw = new SqliteConnection(databasePath);
  raw.exec(`
    CREATE TABLE marker(value TEXT NOT NULL);
    INSERT INTO marker(value) VALUES('from-backup');
    CREATE TABLE asset_files(original_path TEXT NOT NULL, sha256 TEXT NOT NULL);
    CREATE TABLE backup_runs(
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      integrity_result TEXT NOT NULL,
      missing_originals_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  const database = {
    path: databasePath,
    raw,
    checkpoint: () => raw.pragma('wal_checkpoint(TRUNCATE)'),
    backup: (destination: string) => {
      raw.pragma('wal_checkpoint(TRUNCATE)');
      copyFileSync(databasePath, destination);
    }
  } as unknown as AppDatabase;
  const settings = {
    databasePath,
    backupFolder,
    backupIntervalHours: 24,
    backupDailyRetention: 7,
    backupWeeklyRetention: 4,
    backupMonthlyRetention: 6
  } as AppSettings;
  return { root, databasePath, backupFolder, raw, database, settings };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('backup and restore', () => {
  it('creates a checksummed, integrity-checked backup and reports missing originals', () => {
    const value = fixture();
    value.raw.prepare('INSERT INTO asset_files(original_path, sha256) VALUES(?, ?)')
      .run(join(value.root, 'missing.mp4'), 'deadbeef');
    const service = new BackupService(value.database, () => value.settings);
    const backup = service.create(new Date('2026-08-12T12:00:00.000Z'));
    expect(backup.integrity).toBe('ok');
    expect(existsSync(backup.path)).toBe(true);
    expect(readFileSync(`${backup.path}.sha256`, 'utf8')).toContain(backup.checksum);
    expect(backup.missingOriginals).toEqual([`deadbeef:${join(value.root, 'missing.mp4')}`]);
    expect(service.list().length).toBe(3);
    value.raw.close();
  });

  it('stages and atomically applies a validated restore on restart', () => {
    const value = fixture();
    const service = new BackupService(value.database, () => value.settings);
    const backup = service.create(new Date('2026-08-12T12:00:00.000Z'));
    value.raw.prepare('UPDATE marker SET value = ?').run('current-mutated');
    const report = service.stageRestore(backup.path);
    expect(report.restartRequired).toBe(true);
    value.raw.close();
    expect(BackupService.applyPendingRestore(value.databasePath)).toBe(true);
    const restored = new SqliteConnection(value.databasePath);
    expect(restored.prepare('SELECT value FROM marker').get()?.value).toBe('from-backup');
    restored.close();
    const marker = BackupService.consumeCompletedRestore(value.databasePath);
    expect(marker).toMatchObject({ sourceChecksum: report.checksum });
    expect(BackupService.consumeCompletedRestore(value.databasePath)).toEqual(marker);
    BackupService.acknowledgeCompletedRestore(value.databasePath);
    expect(BackupService.consumeCompletedRestore(value.databasePath)).toBeNull();
  });

  it('retains only the newest seven daily backups', () => {
    const value = fixture();
    const service = new BackupService(value.database, () => value.settings);
    const daily = join(value.backupFolder, 'daily');
    mkdirSync(daily, { recursive: true });
    for (let index = 0; index < 10; index += 1) {
      const path = join(daily, `backup-${index}.sqlite`);
      copyFileSync(value.databasePath, path);
      const date = new Date(Date.UTC(2026, 0, index + 1));
      utimesSync(path, date, date);
    }
    service.rotate();
    expect(service.list().filter(record => record.path.includes(`${join('backups', 'daily')}`))).toHaveLength(7);
    value.raw.close();
  });

  it('uses one weekly snapshot across a UTC year boundary', () => {
    const value = fixture();
    const service = new BackupService(value.database, () => value.settings);
    service.create(new Date('2021-01-01T12:00:00.000Z'));
    service.create(new Date('2021-01-03T12:00:00.000Z'));
    const weekly = service.list().filter(record => record.path.includes(`${join('backups', 'weekly')}`));
    expect(weekly).toHaveLength(1);
    expect(weekly[0]?.path).toContain('week-2020-12-28');
    value.raw.close();
  });

  it('[BAK-005] applies independent daily, weekly, and monthly retention without deleting newer snapshots', () => {
    const value = fixture();
    value.settings.backupDailyRetention = 2;
    value.settings.backupWeeklyRetention = 3;
    value.settings.backupMonthlyRetention = 4;
    const service = new BackupService(value.database, () => value.settings);
    for (const cadence of ['daily', 'weekly', 'monthly'] as const) {
      const directory = join(value.backupFolder, cadence);
      mkdirSync(directory, { recursive: true });
      for (let index = 0; index < 6; index += 1) {
        const path = join(directory, `${cadence}-${index}.sqlite`);
        copyFileSync(value.databasePath, path);
        const date = new Date(Date.UTC(2026, 0, index + 1));
        utimesSync(path, date, date);
      }
    }

    service.rotate();

    expect(readdirSync(join(value.backupFolder, 'daily')).sort())
      .toEqual(['daily-4.sqlite', 'daily-5.sqlite']);
    expect(readdirSync(join(value.backupFolder, 'weekly')).sort())
      .toEqual(['weekly-3.sqlite', 'weekly-4.sqlite', 'weekly-5.sqlite']);
    expect(readdirSync(join(value.backupFolder, 'monthly')).sort())
      .toEqual(['monthly-2.sqlite', 'monthly-3.sqlite', 'monthly-4.sqlite', 'monthly-5.sqlite']);
    value.raw.close();
  });

  it('creates an automatic backup only when the configured interval is due', () => {
    const value = fixture();
    const service = new BackupService(value.database, () => value.settings);
    expect(service.createIfDue(new Date('2026-08-12T00:00:00.000Z'))).not.toBeNull();
    expect(service.createIfDue(new Date('2026-08-12T23:59:00.000Z'))).toBeNull();
    expect(service.createIfDue(new Date('2026-08-13T00:01:00.000Z'))).not.toBeNull();
    expect(service.list().filter(record => record.path.includes(`${join('backups', 'daily')}`))).toHaveLength(2);
    expect(value.raw.prepare('SELECT count(*) AS count FROM backup_runs').get()).toEqual({ count: 2 });
    value.raw.close();
  });
});
