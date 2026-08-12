import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase } from '@main/database/database';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('application database migrations', () => {
  it('applies and records every forward migration through the real wrapper', () => {
    const root = mkdtempSync(join(tmpdir(), 'videofactory-migrations-'));
    roots.push(root);
    const database = new AppDatabase(join(root, 'videofactory.sqlite'));

    expect(database.raw.prepare(`
      SELECT version, name FROM schema_migrations ORDER BY version
    `).all()).toEqual([
      { version: 1, name: 'initial' },
      { version: 2, name: 'production_hardening' }
    ]);
    expect(database.raw.prepare(`
      SELECT name FROM pragma_table_info('projects') WHERE name = 'resume_state'
    `).get()).toEqual({ name: 'resume_state' });
    expect(database.raw.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'backup_runs'
    `).get()).toEqual({ name: 'backup_runs' });
    expect(database.integrityCheck()).toBe('ok');

    database.close();

    const reopened = new AppDatabase(join(root, 'videofactory.sqlite'));
    expect(reopened.raw.prepare('SELECT count(*) AS count FROM schema_migrations').get())
      .toEqual({ count: 2 });
    expect(reopened.integrityCheck()).toBe('ok');
    reopened.close();
  });
});
