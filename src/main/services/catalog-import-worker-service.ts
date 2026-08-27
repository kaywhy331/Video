import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type {
  CatalogImportOperationStatus,
  CatalogImportPreview,
  CatalogImportResult,
  CatalogRefreshRun,
  ProgressEvent
} from '@shared/types';

interface ImportRequest {
  filePath: string;
  sheetName?: string;
  mapping?: Record<string, string | null>;
  previewId?: string;
  templateId?: string;
  rowCount?: number;
}

export interface CatalogSheetStageRequest {
  filePath: string;
  rows: unknown[][];
  sheetName?: string;
}

export interface CatalogSheetStageResult {
  sourceSha256: string;
  preview: CatalogImportPreview;
}

interface WorkerMessage {
  type: 'progress' | 'result' | 'error';
  progress?: number;
  phase?: string;
  message?: string;
  result?: unknown;
  error?: { name?: string; message?: string; stack?: string };
}

type TerminalWorkerMessage =
  | { type: 'result'; result: unknown }
  | { type: 'error'; error: Error };

interface ActiveOperation {
  status: CatalogImportOperationStatus;
  worker: Worker;
  cancelFlag: Int32Array;
}

function defaultWorkerPath(): string {
  const adjacent = join(__dirname, 'catalog-import-worker.js');
  const built = join(process.cwd(), 'out', 'main', 'catalog-import-worker.js');
  return existsSync(adjacent) ? adjacent : built;
}

export class CatalogImportWorkerService {
  private active: ActiveOperation | null = null;

  constructor(
    private readonly databasePath: string,
    private readonly emitProgress: (event: ProgressEvent) => void,
    private readonly workerPath = defaultWorkerPath()
  ) {}

  preview(operationId: string, request: ImportRequest): Promise<CatalogImportPreview> {
    return this.run(operationId, 'preview', request) as Promise<CatalogImportPreview>;
  }

  commit(operationId: string, request: ImportRequest): Promise<CatalogImportResult> {
    return this.run(operationId, 'commit', request) as Promise<CatalogImportResult>;
  }

  refresh(operationId: string, request: ImportRequest): Promise<CatalogRefreshRun> {
    return this.run(operationId, 'refresh', request) as Promise<CatalogRefreshRun>;
  }

  stage(operationId: string, request: CatalogSheetStageRequest): Promise<CatalogSheetStageResult> {
    return this.run(operationId, 'stage', {
      filePath: request.filePath,
      sheetName: request.sheetName,
      rowCount: request.rows.length
    }, request.rows) as Promise<CatalogSheetStageResult>;
  }

  status(): CatalogImportOperationStatus | null {
    return this.active ? { ...this.active.status } : null;
  }

  ping(): { receivedAt: number; activeOperation: CatalogImportOperationStatus | null } {
    return { receivedAt: Date.now(), activeOperation: this.status() };
  }

  cancel(operationId: string): boolean {
    if (!this.active || this.active.status.operationId !== operationId) return false;
    if (this.active.status.state === 'cancelling') return true;
    Atomics.store(this.active.cancelFlag, 0, 1);
    this.active.status = {
      ...this.active.status,
      state: 'cancelling',
      message: 'Cancellation requested; rolling back catalog changes safely'
    };
    this.emit(this.active.status);
    return true;
  }

  async shutdown(): Promise<void> {
    const active = this.active;
    if (!active) return;
    Atomics.store(active.cancelFlag, 0, 1);
    await active.worker.terminate();
    if (this.active?.worker === active.worker) this.active = null;
  }

  private run(
    operationId: string,
    operation: CatalogImportOperationStatus['operation'],
    request: ImportRequest,
    rows?: unknown[][]
  ): Promise<unknown> {
    if (this.active) throw new Error('Another catalog import operation is already running.');
    if (!existsSync(this.workerPath)) {
      throw new Error(`Catalog import worker is unavailable at ${this.workerPath}. Rebuild the application.`);
    }
    const cancelBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const cancelFlag = new Int32Array(cancelBuffer);
    const worker = new Worker(this.workerPath, {
      workerData: {
        databasePath: this.databasePath,
        operationId,
        operation,
        request,
        cancelBuffer
      }
    });
    const status: CatalogImportOperationStatus = {
      operationId,
      operation,
      state: 'running',
      progress: 0,
      phase: `${operation}_starting`,
      message: `Starting catalog ${operation}`,
      startedAt: new Date().toISOString()
    };
    this.active = { status, worker, cancelFlag };
    this.emit(status);

    return new Promise((resolve, reject) => {
      let settled = false;
      let terminalMessage: TerminalWorkerMessage | null = null;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        if (this.active?.worker === worker) this.active = null;
        callback();
      };
      const fail = (error: Error): void => {
        if (settled) return;
        const cancelled = error.name === 'CatalogImportCancelledError';
        this.emitProgress({
          jobId: operationId,
          projectId: null,
          type: 'catalog_import',
          progress: 1,
          phase: cancelled ? `${operation}_cancelled` : `${operation}_failed`,
          message: cancelled ? 'Catalog import cancelled; staged changes were rolled back' : error.message
        });
        finish(() => reject(error));
      };
      worker.on('message', (message: WorkerMessage) => {
        if (message.type === 'progress' && this.active?.worker === worker) {
          this.active.status = {
            ...this.active.status,
            progress: Number(message.progress ?? this.active.status.progress),
            phase: message.phase ?? this.active.status.phase,
            message: message.message ?? this.active.status.message
          };
          this.emit(this.active.status);
          return;
        }
        if (message.type === 'result') {
          terminalMessage = { type: 'result', result: message.result };
        }
        if (message.type === 'error') {
          const error = new Error(message.error?.message ?? 'Catalog import worker failed.');
          error.name = message.error?.name ?? 'Error';
          if (message.error?.stack) error.stack = message.error.stack;
          terminalMessage = { type: 'error', error };
        }
      });
      worker.once('error', fail);
      worker.once('exit', code => {
        if (settled) return;
        if (code !== 0 || !terminalMessage) {
          fail(new Error(`Catalog import worker exited before returning a result (${code}).`));
          return;
        }
        if (terminalMessage.type === 'error') {
          fail(terminalMessage.error);
          return;
        }
        this.emitProgress({
          jobId: operationId,
          projectId: null,
          type: 'catalog_import',
          progress: 1,
          phase: `${operation}_complete`,
          message: `Catalog ${operation} completed`
        });
        const result = terminalMessage.result;
        finish(() => resolve(result));
      });
      if (rows) {
        void this.streamRows(worker, rows, cancelFlag).catch(error => {
          void worker.terminate();
          fail(error instanceof Error ? error : new Error(String(error)));
        });
      }
    });
  }

  private async streamRows(worker: Worker, rows: unknown[][], cancelFlag: Int32Array): Promise<void> {
    const batchSize = 25;
    for (let offset = 0; offset < rows.length; offset += batchSize) {
      if (Atomics.load(cancelFlag, 0) === 1) break;
      worker.postMessage({ type: 'rows', rows: rows.slice(offset, offset + batchSize) });
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    worker.postMessage({ type: 'rows-end' });
  }

  private emit(status: CatalogImportOperationStatus): void {
    this.emitProgress({
      jobId: status.operationId,
      projectId: null,
      type: 'catalog_import',
      progress: status.progress,
      phase: status.phase,
      message: status.message
    });
  }
}
