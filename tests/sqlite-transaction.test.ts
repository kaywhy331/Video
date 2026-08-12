import { describe, expect, it } from 'vitest';
import { SqliteConnection } from '@main/database/database';

describe('SQLite transaction wrapper', () => {
  it('uses savepoints for nested service transactions', () => {
    const db = new SqliteConnection(':memory:');
    db.exec('CREATE TABLE values_log(value TEXT NOT NULL)');
    const outer = db.transaction(() => {
      db.prepare('INSERT INTO values_log(value) VALUES(?)').run('outer-before');
      db.transaction(() => {
        db.prepare('INSERT INTO values_log(value) VALUES(?)').run('inner');
      })();
      db.prepare('INSERT INTO values_log(value) VALUES(?)').run('outer-after');
    });
    outer();
    expect(db.prepare('SELECT value FROM values_log ORDER BY rowid').all().map(row => row.value))
      .toEqual(['outer-before', 'inner', 'outer-after']);
    db.close();
  });

  it('rolls back only a failed nested savepoint when the caller handles it', () => {
    const db = new SqliteConnection(':memory:');
    db.exec('CREATE TABLE values_log(value TEXT NOT NULL)');
    db.transaction(() => {
      db.prepare('INSERT INTO values_log(value) VALUES(?)').run('kept');
      try {
        db.transaction(() => {
          db.prepare('INSERT INTO values_log(value) VALUES(?)').run('discarded');
          throw new Error('expected');
        })();
      } catch {
        db.prepare('INSERT INTO values_log(value) VALUES(?)').run('recovered');
      }
    })();
    expect(db.prepare('SELECT value FROM values_log ORDER BY rowid').all().map(row => row.value))
      .toEqual(['kept', 'recovered']);
    db.close();
  });
});
