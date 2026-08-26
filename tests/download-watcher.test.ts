import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase } from '@main/database/database';
import { DownloadWatcher, waitForStableFile } from '@main/services/download-watcher';
import type { AppSettings } from '@shared/types';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('download watcher shutdown', () => {
  it('[ACQ-004] does not accept a growing file until every configured stable poll passes', async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), 'videofactory-stable-file-'));
    roots.push(root);
    const path = join(root, 'clip.mp4');
    writeFileSync(path, 'first');
    let settled = false;
    setTimeout(() => appendFileSync(path, '-growth'), 5);
    const checking = waitForStableFile(path, { polls: 2, intervalMs: 10 }).then(result => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    await expect(checking).resolves.toBe(true);
    vi.useRealTimers();
  });

  it('stops intake and drains an in-flight stable-file check', async () => {
    const root = mkdtempSync(join(tmpdir(), 'videofactory-watcher-'));
    roots.push(root);
    const db = new AppDatabase(join(root, 'db.sqlite'));
    let release!: (stable: boolean) => void;
    const stable = new Promise<boolean>(resolve => { release = resolve; });
    const watcher = new DownloadWatcher(
      db,
      {} as never,
      () => ({ ingestFolder: root }) as AppSettings,
      vi.fn(),
      () => stable
    );

    watcher.processAddedFile(join(root, 'clip.mp4'));
    let stopped = false;
    const stopping = watcher.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);

    release(false);
    await stopping;
    expect(stopped).toBe(true);
    db.close();
  });

  it('[ACQ-005] maps one stable file to the sole active item with persisted evidence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'videofactory-single-active-'));
    roots.push(root);
    const filePath = join(root, 'download.mp4');
    writeFileSync(filePath, 'stable video fixture');
    const db = new AppDatabase(join(root, 'db.sqlite'));
    const now = new Date().toISOString();
    db.raw.prepare(`
      INSERT INTO projects(
        id, sequence, slug, title, topic, state, progress, envato_project_name,
        target_duration_ms, created_at, updated_at
      ) VALUES('project-1', 1, 'project-1', 'Project', 'Topic',
        'WAITING_FOR_DOWNLOADS', 0.3, 'YT-TEST-1', 300000, ?, ?)
    `).run(now, now);
    db.raw.prepare(`
      INSERT INTO assets(
        id, stable_key, title, orientation, location_granularity,
        location_confidence, verification_status, availability_status,
        raw_row_json, imported_at, updated_at
      ) VALUES('asset-1', 'asset-1', 'Expected clip', 'landscape', 'unknown',
        0.5, 'metadata', 'available', '{}', ?, ?)
    `).run(now, now);
    db.raw.prepare(`
      INSERT INTO acquisition_items(
        id, project_id, asset_id, ordinal, role, state, source_url,
        required_scene_ordinals_json, match_score, reasons_json, active_at,
        created_at, updated_at
      ) VALUES('acquisition-1', 'project-1', 'asset-1', 1, 'primary',
        'WAITING_FOR_FILE', 'https://elements.envato.com/expected', '[1]', 99,
        '["sole active item"]', ?, ?, ?)
    `).run(now, now, now);
    const ingestAcquisition = vi.fn(async () => undefined);
    const watcher = new DownloadWatcher(
      db,
      { ingestAcquisition } as never,
      () => ({ ingestFolder: root }) as AppSettings,
      vi.fn(),
      async () => true
    );

    watcher.processAddedFile(filePath);
    await watcher.stop();

    expect(ingestAcquisition).toHaveBeenCalledWith('acquisition-1', filePath);
    const mapped = db.raw.prepare(`
      SELECT state, detected_path, mapping_confidence, mapping_evidence_json
      FROM acquisition_items WHERE id = 'acquisition-1'
    `).get() as Record<string, unknown>;
    expect(mapped).toMatchObject({
      state: 'FILE_STABLE',
      detected_path: filePath,
      mapping_confidence: 1
    });
    expect(JSON.parse(String(mapped.mapping_evidence_json))).toEqual({
      method: 'single_active_item',
      fileName: 'download.mp4',
      activeIds: ['acquisition-1']
    });
    db.close();
  });

  it('recovers interrupted rows before scanning stable files that predate watcher startup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'videofactory-watcher-startup-'));
    roots.push(root);
    const ingestFolder = join(root, 'ingest');
    mkdirSync(ingestFolder, { recursive: true });
    const filePath = join(ingestFolder, 'download-before-restart.mp4');
    writeFileSync(filePath, 'stable startup fixture');
    const db = new AppDatabase(join(root, 'db.sqlite'));
    const now = new Date().toISOString();
    db.raw.prepare(`
      INSERT INTO projects(
        id, sequence, slug, title, topic, state, progress, envato_project_name,
        target_duration_ms, created_at, updated_at
      ) VALUES('project-1', 1, 'project-1', 'Project', 'Topic',
        'WAITING_FOR_DOWNLOADS', 0.3, 'YT-TEST-1', 300000, ?, ?)
    `).run(now, now);
    db.raw.prepare(`
      INSERT INTO assets(
        id, stable_key, title, orientation, location_granularity,
        location_confidence, verification_status, availability_status,
        raw_row_json, imported_at, updated_at
      ) VALUES('asset-1', 'asset-1', 'Expected clip', 'landscape', 'unknown',
        0.5, 'metadata', 'available', '{}', ?, ?)
    `).run(now, now);
    db.raw.prepare(`
      INSERT INTO acquisition_items(
        id, project_id, asset_id, ordinal, role, state, source_url,
        required_scene_ordinals_json, match_score, reasons_json, active_at,
        created_at, updated_at
      ) VALUES('acquisition-1', 'project-1', 'asset-1', 1, 'primary',
        'WAITING_FOR_FILE', 'https://elements.envato.com/expected', '[1]', 99,
        '[]', ?, ?, ?)
    `).run(now, now, now);
    const recoverInterruptedIngests = vi.fn(async () => ({ recovered: 0, failed: 0, reconciledProjects: 0 }));
    const ingestAcquisition = vi.fn(async () => undefined);
    const watcher = new DownloadWatcher(
      db,
      { recoverInterruptedIngests, ingestAcquisition } as never,
      () => ({ ingestFolder }) as AppSettings,
      vi.fn(),
      async () => true
    );

    await watcher.start();
    await watcher.stop();

    expect(recoverInterruptedIngests).toHaveBeenCalledOnce();
    expect(ingestAcquisition).toHaveBeenCalledOnce();
    expect(ingestAcquisition).toHaveBeenCalledWith('acquisition-1', filePath);
    expect(db.raw.prepare(`SELECT state, detected_path FROM acquisition_items WHERE id = 'acquisition-1'`).get())
      .toEqual({ state: 'FILE_STABLE', detected_path: filePath });
    db.close();
  });
});
