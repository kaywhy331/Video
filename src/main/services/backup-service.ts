import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { AppSettings, BackupRecord, RestoreReport } from '@shared/types';
import type { AppDatabase } from '../database/database';
import { SqliteConnection } from '../database/database';

const DEFAULT_RETENTION = { daily: 7, weekly: 4, monthly: 6 } as const;
type BackupCadence = keyof typeof DEFAULT_RETENTION;

function safeTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

function utcWeekKey(date: Date): string {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const daysSinceMonday = (day.getUTCDay() + 6) % 7;
  day.setUTCDate(day.getUTCDate() - daysSinceMonday);
  return day.toISOString().slice(0, 10);
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function integrity(path: string): string {
  const db = new SqliteConnection(path);
  try {
    return String(db.pragma('integrity_check', { simple: true }) ?? 'unknown');
  } finally {
    db.close();
  }
}

function assertInside(root: string, candidate: string): void {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  if (!candidatePath.startsWith(`${rootPath}${sep}`)) {
    throw new Error('Backup path is outside the configured backup directory.');
  }
}

export class BackupService {
  static readonly PENDING_SUFFIX = '.restore-pending';
  static readonly MARKER_SUFFIX = '.restore-request.json';

  constructor(
    private readonly db: AppDatabase,
    private readonly settings: () => AppSettings
  ) {}

  createIfDue(now = new Date()): BackupRecord | null {
    const latest = this.list().find(record => record.path.includes(`${sep}daily${sep}`));
    const intervalMs = Math.max(1, this.settings().backupIntervalHours ?? 24) * 60 * 60 * 1000;
    if (latest && now.getTime() - new Date(latest.createdAt).getTime() < intervalMs) return null;
    return this.create(now);
  }

  create(now = new Date()): BackupRecord {
    const settings = this.settings();
    const directory = join(settings.backupFolder, 'daily');
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `videofactory-${safeTimestamp(now)}.sqlite`);
    this.db.backup(path);
    utimesSync(path, now, now);
    const integrityResult = integrity(path);
    if (integrityResult !== 'ok') {
      unlinkSync(path);
      throw new Error(`Backup integrity check failed: ${integrityResult}`);
    }
    const checksum = sha256(path);
    writeFileSync(`${path}.sha256`, `${checksum}  ${basename(path)}\n`, 'utf8');

    this.copyCadenceSnapshot(path, 'weekly', now);
    this.copyCadenceSnapshot(path, 'monthly', now);
    this.rotate();
    const record = {
      path,
      checksum,
      sizeBytes: statSync(path).size,
      integrity: integrityResult,
      createdAt: now.toISOString(),
      missingOriginals: this.scanMissingOriginals()
    };
    this.db.raw.prepare(`
      INSERT INTO backup_runs(
        id, path, checksum, size_bytes, integrity_result,
        missing_originals_json, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        checksum = excluded.checksum,
        size_bytes = excluded.size_bytes,
        integrity_result = excluded.integrity_result,
        missing_originals_json = excluded.missing_originals_json,
        created_at = excluded.created_at
    `).run(
      createHash('sha256').update(path).digest('hex'), path, checksum, record.sizeBytes,
      integrityResult, JSON.stringify(record.missingOriginals), record.createdAt
    );
    return record;
  }

  list(): BackupRecord[] {
    const root = this.settings().backupFolder;
    const records: BackupRecord[] = [];
    for (const cadence of Object.keys(DEFAULT_RETENTION) as BackupCadence[]) {
      const directory = join(root, cadence);
      if (!existsSync(directory)) continue;
      for (const name of readdirSync(directory).filter(value => value.endsWith('.sqlite'))) {
        const path = join(directory, name);
        const checksumPath = `${path}.sha256`;
        const checksum = existsSync(checksumPath)
          ? readFileSync(checksumPath, 'utf8').trim().split(/\s+/)[0] ?? ''
          : sha256(path);
        records.push({
          path,
          checksum,
          sizeBytes: statSync(path).size,
          integrity: 'not_checked',
          createdAt: statSync(path).mtime.toISOString(),
          missingOriginals: []
        });
      }
    }
    return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  stageRestore(backupPath: string): RestoreReport {
    const settings = this.settings();
    assertInside(settings.backupFolder, backupPath);
    if (!existsSync(backupPath) || !statSync(backupPath).isFile()) throw new Error('Backup file does not exist.');
    const integrityResult = integrity(backupPath);
    if (integrityResult !== 'ok') throw new Error(`Restore blocked: backup integrity is ${integrityResult}.`);
    const pendingPath = `${settings.databasePath}${BackupService.PENDING_SUFFIX}`;
    const markerPath = `${settings.databasePath}${BackupService.MARKER_SUFFIX}`;
    copyFileSync(backupPath, pendingPath);
    const expectedChecksum = sha256(backupPath);
    if (sha256(pendingPath) !== expectedChecksum) {
      unlinkSync(pendingPath);
      throw new Error('Restore staging checksum did not match the selected backup.');
    }
    writeFileSync(markerPath, JSON.stringify({ backupPath, pendingPath, expectedChecksum }, null, 2), 'utf8');
    return {
      backupPath,
      stagedPath: pendingPath,
      integrity: integrityResult,
      checksum: expectedChecksum,
      restartRequired: true,
      missingOriginals: this.scanMissingOriginals(backupPath)
    };
  }

  cancelStagedRestore(): void {
    const databasePath = this.settings().databasePath;
    const pendingPath = `${databasePath}${BackupService.PENDING_SUFFIX}`;
    const markerPath = `${databasePath}${BackupService.MARKER_SUFFIX}`;
    if (existsSync(pendingPath)) unlinkSync(pendingPath);
    if (existsSync(markerPath)) unlinkSync(markerPath);
  }

  rotate(): void {
    const root = this.settings().backupFolder;
    const retention = this.retention();
    for (const cadence of Object.keys(retention) as BackupCadence[]) {
      const directory = join(root, cadence);
      if (!existsSync(directory)) continue;
      const paths = readdirSync(directory)
        .filter(name => name.endsWith('.sqlite'))
        .map(name => join(directory, name))
        .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
      for (const expired of paths.slice(retention[cadence])) {
        assertInside(root, expired);
        unlinkSync(expired);
        if (existsSync(`${expired}.sha256`)) unlinkSync(`${expired}.sha256`);
      }
    }
  }

  scanMissingOriginals(databasePath = this.db.path): string[] {
    if (!existsSync(databasePath)) return [];
    const connection = databasePath === this.db.path ? this.db.raw : new SqliteConnection(databasePath);
    try {
      return (connection.prepare('SELECT original_path, sha256 FROM asset_files ORDER BY original_path').all() as Array<{ original_path: string; sha256: string }>)
        .filter(row => !existsSync(row.original_path))
        .map(row => `${row.sha256}:${row.original_path}`);
    } finally {
      if (connection !== this.db.raw) connection.close();
    }
  }

  static applyPendingRestore(databasePath: string): boolean {
    const markerPath = `${databasePath}${BackupService.MARKER_SUFFIX}`;
    if (!existsSync(markerPath)) return false;
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as { pendingPath: string; expectedChecksum: string };
    if (!existsSync(marker.pendingPath)) throw new Error('Pending restore database is missing.');
    if (sha256(marker.pendingPath) !== marker.expectedChecksum) throw new Error('Pending restore checksum is invalid.');
    if (integrity(marker.pendingPath) !== 'ok') throw new Error('Pending restore database failed integrity validation.');
    mkdirSync(dirname(databasePath), { recursive: true });
    const safetyPath = `${databasePath}.pre-restore-${safeTimestamp(new Date())}`;
    if (existsSync(databasePath)) renameSync(databasePath, safetyPath);
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${databasePath}${suffix}`;
      if (existsSync(sidecar)) rmSync(sidecar, { force: true });
    }
    renameSync(marker.pendingPath, databasePath);
    unlinkSync(markerPath);
    return true;
  }

  private copyCadenceSnapshot(source: string, cadence: Exclude<BackupCadence, 'daily'>, now: Date): void {
    const directory = join(this.settings().backupFolder, cadence);
    mkdirSync(directory, { recursive: true });
    const year = now.getUTCFullYear();
    const period = cadence === 'monthly'
      ? `${year}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
      : `week-${utcWeekKey(now)}`;
    const destination = join(directory, `videofactory-${period}.sqlite`);
    copyFileSync(source, destination);
    utimesSync(destination, now, now);
    const checksum = sha256(destination);
    writeFileSync(`${destination}.sha256`, `${checksum}  ${basename(destination)}\n`, 'utf8');
  }

  private retention(): Record<BackupCadence, number> {
    const settings = this.settings();
    return {
      daily: Math.max(1, settings.backupDailyRetention ?? DEFAULT_RETENTION.daily),
      weekly: Math.max(1, settings.backupWeeklyRetention ?? DEFAULT_RETENTION.weekly),
      monthly: Math.max(1, settings.backupMonthlyRetention ?? DEFAULT_RETENTION.monthly)
    };
  }
}
