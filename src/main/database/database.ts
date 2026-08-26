import { DatabaseSync, type StatementSync, type SQLInputValue } from 'node:sqlite';
import { existsSync, readFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { readdirSync } from 'node:fs';
import type { AppSettings } from '@shared/types';

type PragmaOptions = { simple?: boolean };

type SqlRow = Record<string, unknown>;
type SqlRunResult = { lastInsertRowid: number | bigint; changes: number | bigint };

export const APPLICATION_SCHEMA_VERSION = 24;
export const DATABASE_SCHEMA_CAPABILITY_FUNCTION = 'videofactory_schema_capability';

export type SqliteConnectionOptions = {
  schemaCapability?: number | null;
};

export type AppDatabaseOptions = {
  migrationDirectories?: string[];
  schemaCapability?: number;
};

type Migration = {
  path: string;
  version: number;
  migrationName: string;
};

export class DatabaseCompatibilityError extends Error {
  readonly code = 'DATABASE_SCHEMA_NEWER_THAN_APP';

  constructor(
    readonly databaseSchemaVersion: number,
    readonly supportedSchemaVersion: number
  ) {
    super(
      '[DATABASE_SCHEMA_NEWER_THAN_APP] '
      + `This database uses schema ${databaseSchemaVersion}, `
      + `but this VideoFactory build supports through schema ${supportedSchemaVersion}. `
      + 'Install the current application or restore a pre-upgrade backup; no migrations were run.'
    );
    this.name = 'DatabaseCompatibilityError';
  }
}

function normalizeParameter(value: unknown): SQLInputValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return value;
  if (typeof value === 'boolean') return Number(value);
  if (ArrayBuffer.isView(value)) return value as NodeJS.ArrayBufferView;
  if (value instanceof Date) return value.toISOString();
  const encoded = JSON.stringify(value);
  return encoded === undefined ? null : encoded;
}

export class SqlStatement {
  constructor(private readonly statement: StatementSync) {}

  run(...parameters: unknown[]): SqlRunResult {
    return this.statement.run(...parameters.map(normalizeParameter));
  }

  get(...parameters: unknown[]): SqlRow | undefined {
    return this.statement.get(...parameters.map(normalizeParameter)) as SqlRow | undefined;
  }

  all(...parameters: unknown[]): SqlRow[] {
    return this.statement.all(...parameters.map(normalizeParameter)) as SqlRow[];
  }
}

/**
 * Small compatibility layer used by the services. It intentionally mirrors the
 * synchronous prepare/get/all/run/transaction surface the application needs,
 * while relying on Electron's bundled node:sqlite instead of a native npm addon.
 */
export class SqliteConnection {
  private readonly database: DatabaseSync;
  private transactionDepth = 0;
  private savepointSequence = 0;

  constructor(path: string, options: SqliteConnectionOptions = {}) {
    this.database = new DatabaseSync(path);
    const schemaCapability = options.schemaCapability === undefined
      ? APPLICATION_SCHEMA_VERSION
      : options.schemaCapability;
    if (schemaCapability !== null) {
      if (!Number.isSafeInteger(schemaCapability) || schemaCapability < 1) {
        this.database.close();
        throw new Error('SQLite schema capability must be a positive integer.');
      }
      this.database.function(
        DATABASE_SCHEMA_CAPABILITY_FUNCTION,
        { deterministic: true },
        () => schemaCapability
      );
    }
  }

  get open(): boolean {
    return this.database.isOpen;
  }

  prepare(sql: string): SqlStatement {
    return new SqlStatement(this.database.prepare(sql));
  }

  exec(sql: string): void {
    this.database.exec(sql);
  }

  pragma(statement: string, options?: PragmaOptions): unknown {
    const sql = `PRAGMA ${statement}`;
    if (statement.includes('=')) {
      this.database.exec(sql);
      return undefined;
    }

    const rows = this.database.prepare(sql).all() as Array<Record<string, unknown>>;
    if (options?.simple) {
      const first = rows[0];
      return first ? Object.values(first)[0] : undefined;
    }
    return rows;
  }

  transaction<Args extends unknown[], Result>(operation: (...args: Args) => Result): (...args: Args) => Result {
    const wrapped = (...args: Args): Result => {
      const outermost = this.transactionDepth === 0;
      const savepoint = `vf_nested_${this.savepointSequence++}`;
      this.database.exec(outermost ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
      this.transactionDepth += 1;
      try {
        const result = operation(...args);
        this.transactionDepth -= 1;
        this.database.exec(outermost ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        this.transactionDepth -= 1;
        try {
          if (outermost) {
            this.database.exec('ROLLBACK');
          } else {
            this.database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
            this.database.exec(`RELEASE SAVEPOINT ${savepoint}`);
          }
        } catch {
          // Preserve the original operation error if rollback itself cannot run.
        }
        throw error;
      }
    };
    return wrapped;
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }
}

export class AppDatabase {
  readonly raw: SqliteConnection;
  private migrationBackupPathValue: string | null = null;

  constructor(readonly path: string, options: AppDatabaseOptions = {}) {
    mkdirSync(dirname(path), { recursive: true });
    const schemaCapability = options.schemaCapability ?? APPLICATION_SCHEMA_VERSION;
    this.raw = new SqliteConnection(path, { schemaCapability });
    try {
      const migrations = this.migrations(options.migrationDirectories);
      const targetVersion = Math.max(...migrations.map(migration => migration.version));
      const existingVersion = this.appliedSchemaVersion();
      if (existingVersion > schemaCapability) {
        throw new DatabaseCompatibilityError(existingVersion, schemaCapability);
      }
      if (targetVersion > schemaCapability) {
        throw new Error(
          `Migration inventory targets schema ${targetVersion}, above application capability ${schemaCapability}.`
        );
      }
      this.raw.pragma('busy_timeout = 5000');
      if (existingVersion > 0 && migrations.some(migration => migration.version > existingVersion)) {
        this.migrationBackupPathValue = this.createMigrationBackup(existingVersion, targetVersion, schemaCapability);
      }
      this.raw.pragma('foreign_keys = ON');
      this.raw.pragma('journal_mode = WAL');
      this.raw.pragma('synchronous = NORMAL');
      this.migrate(migrations);
    } catch (error) {
      this.raw.close();
      throw error;
    }
  }

  get migrationBackupPath(): string | null {
    return this.migrationBackupPathValue;
  }

  private migrationPaths(override?: string[]): string[] {
    const directories = override ?? [
      join(process.cwd(), 'src', 'main', 'database'),
      join(process.cwd(), 'resources'),
      ...(process.resourcesPath ? [join(process.resourcesPath, 'resources'), process.resourcesPath] : [])
    ];
    for (const directory of directories) {
      if (!existsSync(directory)) continue;
      const migrations = readdirSync(directory)
        .filter(name => /^\d{3}_.+\.sql$/.test(name))
        .sort()
        .map(name => join(directory, name));
      if (migrations.length) return migrations;
    }
    throw new Error(`Database migrations not found. Checked: ${directories.join(', ')}`);
  }

  private migrations(override?: string[]): Migration[] {
    return this.migrationPaths(override).map(path => {
      const name = path.split(/[\\/]/).pop() ?? path;
      const version = Number(name.slice(0, 3));
      return { path, version, migrationName: name.replace(/^\d{3}_|\.sql$/g, '') };
    });
  }

  private appliedSchemaVersion(): number {
    const exists = this.raw.prepare(`
      SELECT 1 AS present FROM sqlite_schema
      WHERE type = 'table' AND name = 'schema_migrations'
    `).get();
    if (!exists) return 0;
    const row = this.raw.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as
      | { version: number | null }
      | undefined;
    return Number(row?.version ?? 0);
  }

  private createMigrationBackup(
    existingVersion: number,
    targetVersion: number,
    schemaCapability: number
  ): string {
    const checkpointRows = this.raw.pragma('wal_checkpoint(TRUNCATE)') as Array<{
      busy?: number;
      log?: number;
      checkpointed?: number;
    }>;
    const checkpoint = checkpointRows[0];
    if (
      !checkpoint
      || Number(checkpoint.busy) !== 0
      || Number(checkpoint.log) !== Number(checkpoint.checkpointed)
    ) {
      throw new Error(
        '[DATABASE_MIGRATION_BACKUP_CHECKPOINT_FAILED] '
        + 'Could not checkpoint every database page before upgrade; close other app instances and retry.'
      );
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = join(
      dirname(this.path),
      `${basename(this.path)}.pre-migration-v${existingVersion}-to-v${targetVersion}-${timestamp}.sqlite`
    );
    copyFileSync(this.path, backupPath);
    const backup = new SqliteConnection(backupPath, { schemaCapability });
    try {
      const integrity = String(backup.pragma('integrity_check', { simple: true }) ?? 'unknown');
      if (integrity !== 'ok') throw new Error(`Pre-migration backup failed integrity validation: ${integrity}.`);
      const backedUpVersion = backup.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as
        | { version: number | null }
        | undefined;
      if (Number(backedUpVersion?.version ?? 0) !== existingVersion) {
        throw new Error('Pre-migration backup schema version does not match the source database.');
      }
    } finally {
      backup.close();
    }
    return backupPath;
  }

  private migrate(migrations = this.migrations()): void {
    const initial = migrations.find(migration => migration.version === 1);
    const existingVersion = this.appliedSchemaVersion();
    if (existingVersion === 0 && initial) {
      this.raw.exec(readFileSync(initial.path, 'utf8'));
      this.raw.prepare(`
        INSERT OR IGNORE INTO schema_migrations(version, name) VALUES(?, ?)
      `).run(initial.version, initial.migrationName);
    } else if (existingVersion === 0) {
      throw new Error('Migration inventory cannot initialize a database without schema 001.');
    }

    const pending = migrations.filter(migration => (
      migration.version > 1
      && !this.raw.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(migration.version)
    ));
    if (pending.length > 0) {
      this.raw.transaction(() => {
        for (const migration of pending) {
          this.raw.exec(readFileSync(migration.path, 'utf8'));
          this.raw.prepare(`
            INSERT INTO schema_migrations(version, name) VALUES(?, ?)
          `).run(migration.version, migration.migrationName);
        }
      })();
    }
  }

  static schemaVersion(path: string): number {
    const connection = new SqliteConnection(path);
    try {
      const exists = connection.prepare(`
        SELECT 1 AS present FROM sqlite_schema
        WHERE type = 'table' AND name = 'schema_migrations'
      `).get();
      if (!exists) return 0;
      const row = connection.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as
        | { version: number | null }
        | undefined;
      return Number(row?.version ?? 0);
    } finally {
      connection.close();
    }
  }

  getSetting<T>(key: string): T | undefined {
    const row = this.raw.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as
      | { value_json: string }
      | undefined;
    return row ? JSON.parse(row.value_json) as T : undefined;
  }

  setSetting<T>(key: string, value: T): void {
    this.raw.prepare(`
      INSERT INTO settings(key, value_json, updated_at)
      VALUES(?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value), new Date().toISOString());
  }

  getAppSettings(defaults: AppSettings): AppSettings {
    const stored = this.getSetting<Partial<AppSettings>>('app_settings');
    return { ...defaults, ...(stored ?? {}) };
  }

  saveAppSettings(settings: AppSettings): void {
    this.setSetting('app_settings', settings);
  }

  integrityCheck(): string {
    const row = this.raw.pragma('integrity_check', { simple: true });
    return String(row ?? 'unknown');
  }

  checkpoint(): void {
    this.raw.pragma('wal_checkpoint(TRUNCATE)');
  }

  backup(destination: string): void {
    mkdirSync(dirname(destination), { recursive: true });
    this.checkpoint();
    copyFileSync(this.path, destination);
  }

  close(): void {
    this.raw.close();
  }
}
