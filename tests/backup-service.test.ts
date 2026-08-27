import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AppSettings } from '@shared/types';
import {
  APPLICATION_SCHEMA_VERSION,
  AppDatabase,
  SqliteConnection
} from '@main/database/database';
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

  it('[BAK-006] preserves current safety bindings and audit evidence through restore', () => {
    const root = mkdtempSync(join(tmpdir(), 'videofactory-backup-safety-'));
    roots.push(root);
    const databasePath = join(root, 'data', 'videofactory.sqlite');
    const backupFolder = join(root, 'backups');
    const database = new AppDatabase(databasePath);
    const settings = {
      databasePath,
      backupFolder,
      backupIntervalHours: 24,
      backupDailyRetention: 7,
      backupWeeklyRetention: 4,
      backupMonthlyRetention: 6
    } as AppSettings;
    const now = '2026-08-12T12:00:00.000Z';
    const credentialFingerprint = 'a'.repeat(64);
    const toolSha256 = 'b'.repeat(64);
    const finalSha256 = 'c'.repeat(64);

    database.raw.prepare(`
      INSERT INTO projects(
        id, sequence, slug, title, topic, state, progress, envato_project_name,
        target_duration_ms, created_at, updated_at
      ) VALUES('restore-project', 1, 'restore-project', 'Restore', 'Restore',
        'CREATED', 0, 'YT-RESTORE', 60000, ?, ?)
    `).run(now, now);
    database.raw.prepare(`
      INSERT INTO renders(
        id, project_id, kind, profile, state, output_path, sha256, created_at, completed_at
      ) VALUES('restore-render', 'restore-project', 'final', 'final_1080p', 'SUCCEEDED', ?, ?, ?, ?)
    `).run(join(root, 'final.mp4'), finalSha256, now, now);
    database.raw.prepare(`
      UPDATE projects SET final_render_id = 'restore-render' WHERE id = 'restore-project'
    `).run();
    database.raw.prepare(`
      INSERT INTO jobs(
        id, project_id, type, state, input_json, input_hash, available_at,
        transition_version, created_at, updated_at
      ) VALUES('restore-job', 'restore-project', 'UPLOAD_PRIVATE', 'FAILED', '{}',
        'restore-input', ?, 7, ?, ?)
    `).run(now, now, now);
    database.raw.prepare(`
      INSERT INTO youtube_connection_binding(
        singleton_id, channel_id, channel_title, credential_fingerprint, confirmed_at
      ) VALUES(1, 'restore-channel', 'Restore Channel', ?, ?)
    `).run(credentialFingerprint, now);
    database.raw.prepare(`
      INSERT INTO provider_endpoint_bindings(
        provider, configured_url, canonical_origin, trust_mode, status,
        credential_fingerprint, trusted_at, updated_at
      ) VALUES('tavily', 'https://api.example.com/search', 'https://api.example.com',
        'managed', 'confirmed', ?, ?, ?)
    `).run(credentialFingerprint, now, now);
    database.raw.prepare(`
      INSERT INTO job_retry_reconciliations(
        id, job_id, job_transition_version, job_type, outcome, publication_id,
        video_id, input_hash, metadata_json, created_at
      ) VALUES('restore-reconciliation', 'restore-job', 7, 'UPLOAD_PRIVATE',
        'remote_effect_reused', 'restore-publication', 'restore-video',
        'restore-input', '{"receipt":"verified"}', ?)
    `).run(now);
    database.raw.prepare(`
      INSERT INTO media_tool_trust(
        role, configured_path, canonical_path, sha256, size_bytes,
        signature_status, signature_subject, status, trusted_at,
        trusted_app_version, version_output, probed_at, updated_at
      ) VALUES('ffmpeg', ?, ?, ?, 123456, 'valid', 'VideoFactory Tools', 'trusted',
        ?, '0.1.0-alpha.7', 'ffmpeg 7.1', ?, ?)
    `).run(join(root, 'ffmpeg.exe'), join(root, 'ffmpeg.exe'), toolSha256, now, now, now);
    database.raw.prepare(`
      INSERT INTO publication_records(
        id, project_id, channel_id, video_id, privacy_status, final_render_id,
        final_sha256, snapshot_version, snapshot_status, approval_hash,
        approved_at, created_at, updated_at
      ) VALUES('restore-publication', 'restore-project', 'restore-channel', 'restore-video',
        'private', 'restore-render', ?, 3, 'current', 'restore-approval', ?, ?, ?)
    `).run(finalSha256, now, now, now);
    database.raw.prepare(`
      INSERT INTO audit_log(
        project_id, action, actor, entity_type, entity_id,
        before_json, after_json, metadata_json, created_at
      ) VALUES('restore-project', 'publication.approved', 'operator', 'publication',
        'restore-publication', '{}', '{"approved":true}', '{"reason":"reviewed"}', ?)
    `).run(now);

    const service = new BackupService(database, () => settings);
    const backup = service.create(new Date(now));
    database.raw.prepare(`DELETE FROM job_retry_reconciliations WHERE id = 'restore-reconciliation'`).run();
    database.raw.prepare(`DELETE FROM publication_records WHERE id = 'restore-publication'`).run();
    database.raw.prepare(`DELETE FROM audit_log WHERE entity_id = 'restore-publication'`).run();
    database.raw.prepare(`UPDATE youtube_connection_binding SET channel_title = 'Mutated'`).run();
    database.raw.prepare(`UPDATE provider_endpoint_bindings SET status = 'blocked'`).run();
    database.raw.prepare(`UPDATE media_tool_trust SET status = 'revoked'`).run();
    const report = service.stageRestore(backup.path);
    database.close();

    expect(BackupService.applyPendingRestore(databasePath)).toBe(true);
    const restored = new AppDatabase(databasePath);
    expect(restored.raw.prepare(`
      SELECT channel_id, channel_title, credential_fingerprint
      FROM youtube_connection_binding WHERE singleton_id = 1
    `).get()).toEqual({
      channel_id: 'restore-channel',
      channel_title: 'Restore Channel',
      credential_fingerprint: credentialFingerprint
    });
    expect(restored.raw.prepare(`
      SELECT canonical_origin, status, credential_fingerprint
      FROM provider_endpoint_bindings WHERE provider = 'tavily'
    `).get()).toEqual({
      canonical_origin: 'https://api.example.com',
      status: 'confirmed',
      credential_fingerprint: credentialFingerprint
    });
    expect(restored.raw.prepare(`
      SELECT job_transition_version, outcome, video_id, input_hash
      FROM job_retry_reconciliations WHERE id = 'restore-reconciliation'
    `).get()).toEqual({
      job_transition_version: 7,
      outcome: 'remote_effect_reused',
      video_id: 'restore-video',
      input_hash: 'restore-input'
    });
    expect(restored.raw.prepare(`
      SELECT sha256, signature_status, status, trusted_app_version, version_output
      FROM media_tool_trust WHERE role = 'ffmpeg'
    `).get()).toEqual({
      sha256: toolSha256,
      signature_status: 'valid',
      status: 'trusted',
      trusted_app_version: '0.1.0-alpha.7',
      version_output: 'ffmpeg 7.1'
    });
    expect(restored.raw.prepare(`
      SELECT final_render_id, final_sha256, snapshot_version, snapshot_status,
        approval_hash, privacy_status
      FROM publication_records WHERE id = 'restore-publication'
    `).get()).toEqual({
      final_render_id: 'restore-render',
      final_sha256: finalSha256,
      snapshot_version: 3,
      snapshot_status: 'current',
      approval_hash: 'restore-approval',
      privacy_status: 'private'
    });
    expect(restored.raw.prepare(`
      SELECT action, actor, entity_type, entity_id, metadata_json
      FROM audit_log WHERE entity_id = 'restore-publication'
    `).get()).toEqual({
      action: 'publication.approved',
      actor: 'operator',
      entity_type: 'publication',
      entity_id: 'restore-publication',
      metadata_json: '{"reason":"reviewed"}'
    });
    expect(report.checksum).toBe(backup.checksum);
    expect(AppDatabase.schemaVersion(databasePath)).toBe(APPLICATION_SCHEMA_VERSION);
    const completedRestore = BackupService.consumeCompletedRestore(databasePath);
    expect(completedRestore).not.toBeNull();
    const recoveryService = new BackupService(restored, () => settings);
    const rebuildReport = {
      id: 'restore-rebuild',
      projectId: 'restore-project',
      checkedOriginals: 0,
      rebuiltProxies: 0,
      rebuiltContactSheets: 0,
      rebuiltVoiceTimings: 0,
      rebuiltEditingLayers: 0,
      rebuiltCaptionFiles: 0,
      staleRenderFragments: 0,
      missingOriginals: [],
      missingVoice: [],
      failures: [],
      status: 'complete' as const,
      error: null,
      createdAt: now,
      completedAt: now
    };
    recoveryService.recordCompletedRestoreRecovery(completedRestore!, [rebuildReport], new Date(now));
    recoveryService.recordCompletedRestoreRecovery(completedRestore!, [rebuildReport], new Date(now));
    const recoveryAudit = restored.raw.prepare(`
      SELECT actor, entity_type, entity_id, after_json, metadata_json
      FROM audit_log WHERE action = 'backup.restore_recovered'
    `).all() as Array<Record<string, unknown>>;
    expect(recoveryAudit).toHaveLength(1);
    expect(recoveryAudit[0]).toMatchObject({
      actor: 'system',
      entity_type: 'database',
      entity_id: completedRestore!.requestId,
      after_json: expect.stringContaining('"rebuildPassed":true'),
      metadata_json: '{"trigger":"startup_restore_recovery"}'
    });
    BackupService.acknowledgeCompletedRestore(databasePath);
    expect(restored.integrityCheck()).toBe('ok');
    restored.close();
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
