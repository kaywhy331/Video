import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase } from '@main/database/database';
import {
  assertPublicationUploadOwner,
  privateVideoStatus
} from '@main/services/youtube-service';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function database(): AppDatabase {
  const root = mkdtempSync(join(tmpdir(), 'videofactory-youtube-policy-'));
  roots.push(root);
  const db = new AppDatabase(join(root, 'db.sqlite'));
  const now = new Date().toISOString();
  for (const index of [1, 2]) {
    db.raw.prepare(`
      INSERT INTO projects(
        id, sequence, slug, title, topic, state, progress, envato_project_name,
        target_duration_ms, created_at, updated_at
      ) VALUES(?, ?, ?, ?, 'Topic', 'QC_FINAL', 0.9, ?, 300000, ?, ?)
    `).run(`project-${index}`, index, `project-${index}`, `Project ${index}`, `YT-${index}`, now, now);
  }
  return db;
}

describe('YouTube private-upload policy', () => {
  it('[YT-004] reuses only the owning project receipt and rejects a duplicate final upload identity', () => {
    expect(() => assertPublicationUploadOwner({ project_id: 'project-1' }, 'project-1')).not.toThrow();
    expect(() => assertPublicationUploadOwner({ project_id: 'project-1' }, 'project-2'))
      .toThrow('already assigned to a different project upload');

    const db = database();
    const now = new Date().toISOString();
    db.raw.prepare(`
      INSERT INTO publication_records(
        id, project_id, channel_id, privacy_status, final_sha256, created_at, updated_at
      ) VALUES('publication-1', 'project-1', 'channel-1', 'private', 'same-final-sha', ?, ?)
    `).run(now, now);
    expect(() => db.raw.prepare(`
      INSERT INTO publication_records(
        id, project_id, channel_id, privacy_status, final_sha256, created_at, updated_at
      ) VALUES('publication-2', 'project-2', 'channel-1', 'private', 'same-final-sha', ?, ?)
    `).run(now, now)).toThrow(/duplicate publication final hash|UNIQUE constraint/i);
    expect(db.raw.prepare(`SELECT count(*) AS count FROM publication_records`).get())
      .toEqual({ count: 1 });
    db.close();
  });

  it('[YT-002][YT-007] builds a private request and durably records the configured synthetic disclosure', () => {
    expect(privateVideoStatus(true)).toEqual({
      privacyStatus: 'private',
      selfDeclaredMadeForKids: false,
      containsSyntheticMedia: true
    });
    expect(privateVideoStatus(false)).toEqual({
      privacyStatus: 'private',
      selfDeclaredMadeForKids: false,
      containsSyntheticMedia: false
    });

    const db = database();
    const now = new Date().toISOString();
    db.raw.prepare(`
      INSERT INTO publication_records(
        id, project_id, channel_id, privacy_status, final_sha256,
        synthetic_media, created_at, updated_at
      ) VALUES('publication-1', 'project-1', 'channel-1', 'private',
        'synthetic-final-sha', ?, ?, ?)
    `).run(Number(privateVideoStatus(true).containsSyntheticMedia), now, now);
    expect(db.raw.prepare(`
      SELECT privacy_status, synthetic_media FROM publication_records WHERE id = 'publication-1'
    `).get()).toEqual({ privacy_status: 'private', synthetic_media: 1 });
    db.close();
  });
});
