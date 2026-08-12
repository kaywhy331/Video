import { DatabaseSync, type StatementSync, type SQLInputValue } from 'node:sqlite';
import { existsSync, readFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readdirSync } from 'node:fs';
import { app } from 'electron';
import type { AppSettings } from '@shared/types';

type PragmaOptions = { simple?: boolean };

type SqlRow = Record<string, unknown>;
type SqlRunResult = { lastInsertRowid: number | bigint; changes: number | bigint };

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

  constructor(path: string) {
    this.database = new DatabaseSync(path);
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

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.raw = new SqliteConnection(path);
    this.raw.pragma('foreign_keys = ON');
    this.raw.pragma('journal_mode = WAL');
    this.raw.pragma('synchronous = NORMAL');
    this.raw.pragma('busy_timeout = 5000');
    this.migrate();
  }

  private migrationPaths(): string[] {
    const directories = [
      join(process.cwd(), 'src', 'main', 'database'),
      join(process.cwd(), 'resources')
    ];
    if (app && typeof app.getAppPath === 'function') directories.push(join(app.getAppPath(), 'resources'));
    if (process.resourcesPath) directories.push(join(process.resourcesPath, 'resources'), process.resourcesPath);
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

  migrate(): void {
    for (const path of this.migrationPaths()) {
      const name = path.split(/[\\/]/).pop() ?? path;
      const version = Number(name.slice(0, 3));
      const migrationName = name.replace(/^\d{3}_|\.sql$/g, '');
      if (version === 1) {
        this.raw.exec(readFileSync(path, 'utf8'));
        this.raw.prepare(`
          INSERT OR IGNORE INTO schema_migrations(version, name) VALUES(?, ?)
        `).run(version, migrationName);
      } else {
        const applied = this.raw.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(version);
        if (!applied) {
          this.raw.transaction(() => {
            this.raw.exec(readFileSync(path, 'utf8'));
            this.raw.prepare(`
              INSERT INTO schema_migrations(version, name) VALUES(?, ?)
            `).run(version, migrationName);
          })();
        }
      }
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
