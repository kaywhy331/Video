import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase } from '@main/database/database';
import {
  ActiveFinalError,
  ActiveFinalService,
  PublicationIdentityService,
  StalePublicationSnapshotError,
  type PublicationBoundary,
  invalidatePublicationSnapshots
} from '@main/services/active-final-service';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'videofactory-active-final-'));
  roots.push(root);
  const db = new AppDatabase(join(root, 'db.sqlite'));
  const now = new Date().toISOString();
  for (const [id, sequence] of [['project-1', 1], ['project-2', 2]] as const) {
    db.raw.prepare(`
      INSERT INTO projects(
        id, sequence, slug, title, topic, state, progress, envato_project_name,
        target_duration_ms, created_at, updated_at
      ) VALUES(?, ?, ?, ?, 'Topic', 'QC_FINAL', 0.9, ?, 60000, ?, ?)
    `).run(id, sequence, id, id, `YT-${sequence}`, now, now);
  }
  db.raw.prepare(`
    INSERT INTO youtube_connection_binding(
      singleton_id, channel_id, channel_title, credential_fingerprint, confirmed_at
    ) VALUES(1, 'UC-current', 'Current channel', ?, ?)
  `).run('a'.repeat(64), now);
  const service = new ActiveFinalService(db, () => root);
  return { root, db, now, service };
}

function addRender(
  value: ReturnType<typeof fixture>,
  input: {
    id: string;
    projectId?: string;
    state?: 'SUCCEEDED' | 'FAILED';
    content?: string;
    persistedSha?: string;
    createFile?: boolean;
    createdAt?: string;
  }
) {
  const content = input.content ?? input.id;
  const outputPath = join(value.root, `${input.id}.mp4`);
  if (input.createFile !== false) writeFileSync(outputPath, content);
  value.db.raw.prepare(`
    INSERT INTO renders(
      id, project_id, kind, profile, state, output_path, sha256,
      created_at, completed_at
    ) VALUES(?, ?, 'final', 'final_1080p', ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.projectId ?? 'project-1',
    input.state ?? 'SUCCEEDED',
    outputPath,
    input.persistedSha ?? sha256(content),
    input.createdAt ?? value.now,
    value.now
  );
  return { outputPath, sha256: sha256(content) };
}

function selectPackage(value: ReturnType<typeof fixture>) {
  const thumbnailPath = join(value.root, 'thumbnail.jpg');
  writeFileSync(thumbnailPath, 'thumbnail');
  value.db.raw.prepare(`
    INSERT INTO packaging_candidates(
      id, project_id, ordinal, title, angle, viewer_promise, thumbnail_path,
      description, chapters, tags_json, risk_status, selected, created_at
    ) VALUES('package-1', 'project-1', 1, 'Current title', 'Angle', 'Promise', ?,
      'Description', '00:00 Opening', '["travel"]', 'pass', 1, ?)
  `).run(thumbnailPath, value.now);
}

describe('authoritative active-final publication identity', () => {
  it('[REN-015] rejects missing, cross-project, failed, missing-file, unmanaged, and hash-mismatched active finals', () => {
    const value = fixture();
    const expectCode = (code: ActiveFinalError['code']) => {
      try {
        value.service.requireActiveFinal('project-1');
        throw new Error('Expected the active-final resolver to reject.');
      } catch (error) {
        expect(error).toBeInstanceOf(ActiveFinalError);
        expect((error as ActiveFinalError).code).toBe(code);
      }
    };

    expectCode('ACTIVE_FINAL_MISSING');

    addRender(value, { id: 'other-project-final', projectId: 'project-2' });
    value.db.raw.prepare(`UPDATE projects SET final_render_id = 'other-project-final' WHERE id = 'project-1'`).run();
    expectCode('CROSS_PROJECT_RENDER');

    addRender(value, { id: 'failed-final', state: 'FAILED' });
    value.db.raw.prepare(`UPDATE projects SET final_render_id = 'failed-final' WHERE id = 'project-1'`).run();
    expectCode('FINAL_RENDER_FAILED');

    addRender(value, { id: 'missing-file-final', createFile: false });
    value.db.raw.prepare(`UPDATE projects SET final_render_id = 'missing-file-final' WHERE id = 'project-1'`).run();
    expectCode('OUTPUT_FILE_MISSING');

    const outsideRoot = mkdtempSync(join(tmpdir(), 'videofactory-unmanaged-final-'));
    roots.push(outsideRoot);
    const outsidePath = join(outsideRoot, 'outside.mp4');
    writeFileSync(outsidePath, 'outside bytes');
    value.db.raw.prepare(`
      INSERT INTO renders(
        id, project_id, kind, profile, state, output_path, sha256, created_at, completed_at
      ) VALUES('unmanaged-final', 'project-1', 'final', 'final_1080p', 'SUCCEEDED', ?, ?, ?, ?)
    `).run(outsidePath, sha256('outside bytes'), value.now, value.now);
    value.db.raw.prepare(`UPDATE projects SET final_render_id = 'unmanaged-final' WHERE id = 'project-1'`).run();
    expectCode('OUTPUT_NOT_MANAGED');

    addRender(value, { id: 'mismatched-final', persistedSha: sha256('different bytes') });
    value.db.raw.prepare(`UPDATE projects SET final_render_id = 'mismatched-final' WHERE id = 'project-1'`).run();
    expectCode('FINAL_HASH_MISMATCH');
    value.db.close();
  });

  it('[YT-011] snapshots the explicitly active older final instead of the newest succeeded render', () => {
    const value = fixture();
    const older = addRender(value, {
      id: 'older-active-final',
      content: 'approved older final',
      createdAt: '2026-08-24T00:00:00.000Z'
    });
    addRender(value, {
      id: 'newer-stale-final',
      content: 'newer but not active',
      createdAt: '2026-08-25T00:00:00.000Z'
    });
    value.db.raw.prepare(`UPDATE projects SET final_render_id = 'older-active-final' WHERE id = 'project-1'`).run();
    selectPackage(value);

    const identities = new PublicationIdentityService(value.db, value.service);
    expect(identities.capture('project-1', 'UC-current')).toMatchObject({
      projectId: 'project-1',
      finalRenderId: 'older-active-final',
      finalSha256: older.sha256,
      selectedPackageId: 'package-1',
      confirmedChannelId: 'UC-current'
    });
    value.db.close();
  });

  it('[YT-012] invalidates one stale private remote snapshot and deduplicates its actionable exception', () => {
    const value = fixture();
    const final = addRender(value, { id: 'active-final', content: 'active final' });
    value.db.raw.prepare(`UPDATE projects SET final_render_id = 'active-final' WHERE id = 'project-1'`).run();
    selectPackage(value);
    const identities = new PublicationIdentityService(value.db, value.service);
    const snapshot = identities.capture('project-1', 'UC-current');
    value.db.raw.prepare(`
      INSERT INTO publication_records(
        id, project_id, channel_id, video_id, privacy_status, final_render_id,
        final_sha256, snapshot_version, snapshot_status, selected_package_id,
        approval_hash, approved_at, created_at, updated_at
      ) VALUES('publication-1', 'project-1', 'UC-current', 'video-1', 'private',
        'active-final', ?, 1, 'current', 'package-1', ?, ?, ?, ?)
    `).run(final.sha256, snapshot.approvalHash, value.now, value.now, value.now);

    value.db.raw.transaction(() => {
      invalidatePublicationSnapshots(value.db, 'project-1', 'The active final changed.', 'test', value.now);
      value.db.raw.prepare(`UPDATE projects SET final_render_id = NULL WHERE id = 'project-1'`).run();
    })();
    invalidatePublicationSnapshots(value.db, 'project-1', 'Repeated invalidation.', 'test', value.now);

    expect(value.db.raw.prepare(`
      SELECT privacy_status, snapshot_status, approval_hash, approved_at
      FROM publication_records WHERE id = 'publication-1'
    `).get()).toEqual({
      privacy_status: 'private',
      snapshot_status: 'stale',
      approval_hash: null,
      approved_at: null
    });
    expect(value.db.raw.prepare(`
      SELECT count(*) AS count FROM exceptions
      WHERE project_id = 'project-1' AND code = 'STALE_PUBLICATION_SNAPSHOT' AND status = 'OPEN'
    `).get()).toEqual({ count: 1 });
    value.db.close();
  });

  it('[YT-012] revalidates pointer, missing-file, and hash changes at every publication side-effect boundary', () => {
    const value = fixture();
    const final = addRender(value, { id: 'active-final', content: 'boundary final' });
    value.db.raw.prepare(`UPDATE projects SET final_render_id = 'active-final' WHERE id = 'project-1'`).run();
    selectPackage(value);
    const identities = new PublicationIdentityService(value.db, value.service);
    const snapshot = identities.capture('project-1', 'UC-current');
    addRender(value, { id: 'replacement-final', content: 'replacement final' });
    value.db.raw.prepare(`
      INSERT INTO publication_records(
        id, project_id, channel_id, video_id, privacy_status, final_render_id,
        final_sha256, snapshot_version, snapshot_status, selected_package_id,
        approval_hash, created_at, updated_at
      ) VALUES('publication-1', 'project-1', 'UC-current', 'video-1', 'private',
        'active-final', ?, 1, 'current', 'package-1', ?, ?, ?)
    `).run(final.sha256, snapshot.approvalHash, value.now, value.now);
    const boundaries: PublicationBoundary[] = [
      'upload_create', 'upload_resume', 'upload_chunk', 'metadata', 'thumbnail',
      'caption', 'playlist', 'processing', 'approval', 'publish'
    ];
    const resetReceipt = () => value.db.raw.prepare(`
      UPDATE publication_records SET snapshot_status = 'current', approval_hash = ?, error = NULL
      WHERE id = 'publication-1'
    `).run(snapshot.approvalHash);

    for (const boundary of boundaries) {
      rmSync(final.outputPath);
      expect(() => identities.assertCurrent(snapshot, 'publication-1', boundary))
        .toThrow(StalePublicationSnapshotError);
      writeFileSync(final.outputPath, 'boundary final');
      resetReceipt();

      writeFileSync(final.outputPath, 'tampered boundary final');
      expect(() => identities.assertCurrent(snapshot, 'publication-1', boundary))
        .toThrow(StalePublicationSnapshotError);
      writeFileSync(final.outputPath, 'boundary final');
      resetReceipt();
    }
    for (const boundary of ['upload_create', 'upload_resume', 'upload_chunk', 'processing', 'approval'] as const) {
      value.db.raw.prepare(`
        UPDATE projects SET final_render_id = 'replacement-final' WHERE id = 'project-1'
      `).run();
      expect(() => identities.assertCurrent(snapshot, 'publication-1', boundary))
        .toThrow(StalePublicationSnapshotError);
      value.db.raw.prepare(`
        UPDATE projects SET final_render_id = 'active-final' WHERE id = 'project-1'
      `).run();
      resetReceipt();
    }
    value.db.raw.prepare(`
      UPDATE packaging_candidates SET title = 'Changed title' WHERE id = 'package-1'
    `).run();
    expect(() => identities.assertCurrent(snapshot, 'publication-1', 'metadata'))
      .toThrow(StalePublicationSnapshotError);
    value.db.raw.prepare(`
      UPDATE packaging_candidates SET title = 'Current title' WHERE id = 'package-1'
    `).run();
    resetReceipt();
    value.db.raw.prepare(`
      UPDATE youtube_connection_binding SET channel_id = 'UC-replaced' WHERE singleton_id = 1
    `).run();
    expect(() => identities.assertCurrent(snapshot, 'publication-1', 'processing'))
      .toThrow(StalePublicationSnapshotError);
    expect(value.db.raw.prepare(`
      SELECT count(*) AS count FROM exceptions
      WHERE code = 'STALE_PUBLICATION_SNAPSHOT' AND status = 'OPEN'
    `).get()).toEqual({ count: 1 });
    value.db.close();
  });
});
