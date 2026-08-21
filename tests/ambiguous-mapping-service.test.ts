import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase } from '@main/database/database';
import { AmbiguousMappingService } from '@main/services/ambiguous-mapping-service';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(activeIds: string[], exceptionProjectId: string | null = null) {
  const root = mkdtempSync(join(tmpdir(), 'videofactory-ambiguous-mapping-'));
  roots.push(root);
  const db = new AppDatabase(join(root, 'db.sqlite'));
  const now = new Date().toISOString();
  for (const index of [1, 2]) {
    db.raw.prepare(`
      INSERT INTO projects(
        id, sequence, slug, title, topic, state, progress, envato_project_name,
        target_duration_ms, created_at, updated_at
      ) VALUES(?, ?, ?, ?, 'Topic', 'WAITING_FOR_DOWNLOADS', 0.3, ?, 300000, ?, ?)
    `).run(`project-${index}`, index, `project-${index}`, `Project ${index}`, `YT-TEST-${index}`, now, now);
    db.raw.prepare(`
      INSERT INTO assets(
        id, stable_key, title, thumbnail_url, orientation, location_granularity,
        location_confidence, verification_status, availability_status,
        raw_row_json, imported_at, updated_at
      ) VALUES(?, ?, ?, ?, 'landscape', 'unknown', 0.5, 'metadata', 'available', '{}', ?, ?)
    `).run(`asset-${index}`, `asset-${index}`, `Asset ${index}`, `https://example.test/thumb-${index}.jpg`, now, now);
    db.raw.prepare(`
      INSERT INTO acquisition_items(
        id, project_id, asset_id, ordinal, role, state, source_url,
        required_scene_ordinals_json, match_score, reasons_json,
        active_at, created_at, updated_at
      ) VALUES(?, ?, ?, ?, 'primary', ?, 'https://elements.envato.com/item', ?, 90, '[]', ?, ?, ?)
    `).run(
      `acquisition-${index}`,
      `project-${index}`,
      `asset-${index}`,
      index,
      index === 1 ? 'WAITING_FOR_FILE' : 'READY_TO_OPEN',
      JSON.stringify([index, index + 1]),
      index === 1 ? now : null,
      now,
      now
    );
  }
  const filePath = join(root, 'download.mp4');
  writeFileSync(filePath, 'video');
  db.raw.prepare(`
    INSERT INTO exceptions(
      id, project_id, severity, stage, code, title, message, evidence_json,
      recommended_action, status, created_at
    ) VALUES('exception-1', ?, 'HIGH', 'acquisition', 'AMBIGUOUS_FILE_MAPPING',
      'Downloaded file needs mapping', 'Choose the owner', ?, 'Map it', 'OPEN', ?)
  `).run(
    exceptionProjectId,
    JSON.stringify({ filePath, fileName: 'download.mp4', activeIds }),
    now
  );
  return { db, filePath };
}

describe('ambiguous download mapping recovery', () => {
  it('uses persisted active IDs as the authoritative candidate set', () => {
    const { db } = fixture(['acquisition-2', 'missing-id']);
    const service = new AmbiguousMappingService(db, {} as never);

    expect(service.get('exception-1').candidates).toEqual([
      expect.objectContaining({
        acquisitionId: 'acquisition-2',
        projectTitle: 'Project 2',
        assetTitle: 'Asset 2',
        requiredForScenes: [2, 3]
      })
    ]);
    db.close();
  });

  it('falls back to pending acquisitions when the watcher had no active IDs', async () => {
    const { db, filePath } = fixture([]);
    const mapFile = vi.fn(async (acquisitionId: string, receivedPath: string) => {
      expect(receivedPath).toBe(filePath);
      db.raw.prepare(`
        UPDATE acquisition_items SET state = 'COMPLETE', mapped_file_id = 'file-1'
        WHERE id = ?
      `).run(acquisitionId);
    });
    const service = new AmbiguousMappingService(db, { mapFile } as never);
    const recovery = service.get('exception-1');
    expect(recovery.candidates.map(item => item.acquisitionId)).toEqual([
      'acquisition-1', 'acquisition-2'
    ]);

    await expect(service.resolve('exception-1', 'acquisition-1')).resolves.toEqual({
      exceptionId: 'exception-1',
      acquisitionId: 'acquisition-1',
      projectId: 'project-1',
      mappedFileId: 'file-1',
      acquisitionState: 'COMPLETE'
    });
    expect(db.raw.prepare(`SELECT project_id, status FROM exceptions WHERE id = 'exception-1'`).get())
      .toEqual({ project_id: 'project-1', status: 'RESOLVED' });
    expect(db.raw.prepare(`SELECT action FROM audit_log WHERE entity_id = 'exception-1'`).get())
      .toEqual({ action: 'exception.ambiguous_mapping_resolved' });
    db.close();
  });

  it('keeps the exception open unless ingestion reaches COMPLETE', async () => {
    const { db } = fixture(['acquisition-1'], 'project-1');
    const service = new AmbiguousMappingService(db, { mapFile: vi.fn(async () => undefined) } as never);

    await expect(service.resolve('exception-1', 'acquisition-1')).rejects.toThrow('not ingested successfully');
    expect(db.raw.prepare(`SELECT status FROM exceptions WHERE id = 'exception-1'`).get())
      .toEqual({ status: 'OPEN' });
    const stored = db.raw.prepare(`SELECT evidence_json FROM exceptions WHERE id = 'exception-1'`).get() as {
      evidence_json: string;
    };
    expect(JSON.parse(stored.evidence_json)).toMatchObject({ attemptedAcquisitionId: 'acquisition-1' });
    db.close();
  });
});
