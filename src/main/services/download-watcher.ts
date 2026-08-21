import chokidar, { type FSWatcher } from 'chokidar';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { basename } from 'node:path';
import type { AppDatabase } from '../database/database';
import type { AppSettings } from '@shared/types';
import { fileLooksTemporary } from '@shared/media-policy';
import type { MediaService } from './media-service';

export async function waitForStableFile(
  filePath: string,
  options: { polls?: number; intervalMs?: number } = {}
): Promise<boolean> {
  const polls = options.polls ?? 3;
  const intervalMs = options.intervalMs ?? 2000;
  if (fileLooksTemporary(filePath)) return false;

  let stable = 0;
  let previous = -1;
  for (let attempt = 0; attempt < polls + 5; attempt += 1) {
    let size = 0;
    try {
      size = statSync(filePath).size;
    } catch {
      return false;
    }
    if (size > 0 && size === previous) stable += 1;
    else stable = 0;
    if (stable >= polls) return true;
    previous = size;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return false;
}

export class DownloadWatcher {
  private watcher: FSWatcher | null = null;
  private processing = new Set<string>();
  private readonly tasks = new Set<Promise<void>>();
  private acceptingEvents = false;

  constructor(
    private readonly db: AppDatabase,
    private readonly media: MediaService,
    private readonly settings: () => AppSettings,
    private readonly notify: (message: string) => void,
    private readonly stableFile: (filePath: string) => Promise<boolean> = waitForStableFile
  ) {}

  async start(): Promise<void> {
    await this.stop();
    const folder = this.settings().ingestFolder;
    this.acceptingEvents = true;
    this.watcher = chokidar.watch(folder, {
      ignoreInitial: true,
      awaitWriteFinish: false,
      depth: 0,
      ignored: path => fileLooksTemporary(String(path))
    });
    this.watcher.on('add', path => {
      if (this.acceptingEvents) this.processAddedFile(path);
    });
  }

  async stop(): Promise<void> {
    this.acceptingEvents = false;
    if (this.watcher) await this.watcher.close();
    this.watcher = null;
    while (this.tasks.size > 0) {
      await Promise.allSettled([...this.tasks]);
    }
  }

  processAddedFile(filePath: string): void {
    const task = this.handle(filePath);
    this.tasks.add(task);
    task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task)
    );
  }

  private async handle(filePath: string): Promise<void> {
    if (this.processing.has(filePath) || fileLooksTemporary(filePath)) return;
    this.processing.add(filePath);
    try {
      const stable = await this.stableFile(filePath);
      if (!stable) return;

      const active = this.db.raw.prepare(`
        SELECT * FROM acquisition_items
        WHERE state IN ('ACTIVE_IN_BROWSER','WAITING_FOR_FILE')
        ORDER BY active_at DESC
        LIMIT 3
      `).all() as Array<Record<string, unknown>>;

      if (active.length !== 1) {
        this.db.raw.prepare(`
          INSERT INTO exceptions(
            id, project_id, severity, stage, code, title, message, evidence_json,
            recommended_action, status, created_at
          ) VALUES(?, ?, 'HIGH', 'acquisition', 'AMBIGUOUS_FILE_MAPPING',
            'Downloaded file needs mapping',
            'The file watcher could not safely determine which acquisition item owns this file.',
            ?, 'Open Downloads and map the file to the correct active asset.', 'OPEN', ?)
        `).run(
          randomUUID(),
          active[0]?.project_id ?? null,
          JSON.stringify({ filePath, fileName: basename(filePath), activeIds: active.map(row => row.id) }),
          new Date().toISOString()
        );
        this.notify(`VideoFactory needs help mapping ${basename(filePath)}.`);
        return;
      }

      const item = active[0];
      if (!item) return;
      this.db.raw.prepare(`
        UPDATE acquisition_items SET state = 'FILE_STABLE', detected_path = ?,
          mapping_confidence = 1, mapping_evidence_json = ?, updated_at = ?
        WHERE id = ?
      `).run(
        filePath,
        JSON.stringify({
          method: 'single_active_item',
          fileName: basename(filePath),
          activeIds: [String(item.id)]
        }),
        new Date().toISOString(),
        item.id
      );
      await this.media.ingestAcquisition(String(item.id), filePath);
      this.notify(`${basename(filePath)} was ingested successfully.`);
    } catch (error) {
      const active = this.db.raw.prepare(`
        SELECT * FROM acquisition_items
        WHERE state IN ('ACTIVE_IN_BROWSER','WAITING_FOR_FILE','FILE_STABLE')
        ORDER BY active_at DESC LIMIT 1
      `).get() as Record<string, unknown> | undefined;
      this.db.raw.prepare(`
        INSERT INTO exceptions(
          id, project_id, severity, stage, code, title, message, evidence_json,
          recommended_action, status, created_at
        ) VALUES(?, ?, 'BLOCKER', 'media', 'INGEST_FAILED',
          'Downloaded media could not be processed', ?, ?,
          'Retry the file or select a replacement asset.', 'OPEN', ?)
      `).run(
        randomUUID(),
        active?.project_id ?? null,
        error instanceof Error ? error.message : String(error),
        JSON.stringify({ filePath, acquisitionId: active?.id ?? null }),
        new Date().toISOString()
      );
      if (active?.id) {
        this.db.raw.prepare(`
          UPDATE acquisition_items SET state = 'FAILED', error = ?, updated_at = ? WHERE id = ?
        `).run(error instanceof Error ? error.message : String(error), new Date().toISOString(), active.id);
      }
      this.notify(`VideoFactory could not ingest ${basename(filePath)}.`);
    } finally {
      this.processing.delete(filePath);
    }
  }
}
