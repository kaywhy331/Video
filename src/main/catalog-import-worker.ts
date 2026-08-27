import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { XLSX } from '@shared/xlsx-node';
import { AppDatabase } from './database/database';
import { CatalogImportCancelledError, CatalogService } from './services/catalog-service';
import { PlaceService } from './services/place-service';

interface CatalogWorkerInput {
  databasePath: string;
  operationId: string;
  operation: 'preview' | 'commit' | 'refresh' | 'stage';
  request: {
    filePath: string;
    sheetName?: string;
    mapping?: Record<string, string | null>;
    previewId?: string;
    templateId?: string;
    rowCount?: number;
  };
  cancelBuffer: SharedArrayBuffer;
}

interface RowMessage {
  type: 'rows' | 'rows-end';
  rows?: unknown[][];
}

const MAX_SHEET_ROWS = 50_001;
const MAX_SHEET_COLUMNS = 250;
const MAX_SHEET_CELLS = 2_000_000;
const MAX_SHEET_TEXT_BYTES = 64 * 1024 * 1024;
const MAX_CELL_CHARACTERS = 50_000;

const input = workerData as CatalogWorkerInput;
const cancelFlag = new Int32Array(input.cancelBuffer);
let stageOutputOwned = false;

if (!parentPort) throw new Error('Catalog import worker requires a parent port.');
const port = parentPort;

function cancelled(): boolean {
  return Atomics.load(cancelFlag, 0) === 1;
}

function assertActive(): void {
  if (cancelled()) throw new CatalogImportCancelledError();
}

function progress(progressValue: number, phase: string, message: string): void {
  port.postMessage({ type: 'progress', progress: progressValue, phase, message });
}

function receiveRows(): Promise<unknown[][]> {
  return new Promise((resolve, reject) => {
    const rows: unknown[][] = [];
    let lastReportedRowCount = 0;
    const listener = (message: RowMessage): void => {
      try {
        assertActive();
        if (message?.type === 'rows') {
          if (!Array.isArray(message.rows) || message.rows.some(row => !Array.isArray(row))) {
            throw new Error('Catalog stage worker received an invalid row batch.');
          }
          rows.push(...message.rows);
          if (rows.length > MAX_SHEET_ROWS) {
            throw new Error('Google Sheets sync is limited to 50,000 data rows per staged run.');
          }
          const expected = Math.max(1, input.request.rowCount ?? rows.length);
          const reportEvery = Math.max(25, Math.ceil(expected / 50));
          if (rows.length === expected || rows.length - lastReportedRowCount >= reportEvery) {
            lastReportedRowCount = rows.length;
            progress(Math.min(0.2, rows.length / expected * 0.2), 'stage_receiving', `Received ${rows.length.toLocaleString()} sheet row(s)`);
          }
          return;
        }
        if (message?.type === 'rows-end') {
          port.off('message', listener);
          resolve(rows);
        }
      } catch (error) {
        port.off('message', listener);
        reject(error);
      }
    };
    port.on('message', listener);
  });
}

function boundedRows(values: unknown[][]): string[][] {
  if (!values.length) throw new Error('Google Sheets returned no rows.');
  if (values.length > MAX_SHEET_ROWS) throw new Error('Google Sheets sync is limited to 50,000 data rows per staged run.');
  const headers = (values[0] ?? []).map(value => String(value ?? '').trim());
  if (!headers.some(Boolean)) throw new Error('Google Sheets returned no header row.');
  if (headers.length > MAX_SHEET_COLUMNS) throw new Error('Google Sheets sync is limited to 250 columns.');
  if (values.length * headers.length > MAX_SHEET_CELLS) {
    throw new Error(`Google Sheets sync is limited to ${MAX_SHEET_CELLS.toLocaleString()} materialized cells per staged run.`);
  }
  let textBytes = 0;
  const reportEvery = Math.max(128, Math.ceil(values.length / 50));
  return values.map((row, rowIndex) => {
    if (rowIndex % reportEvery === 0) {
      assertActive();
      progress(0.2 + rowIndex / values.length * 0.15, 'stage_bounding', `Validating sheet row ${rowIndex.toLocaleString()} of ${values.length.toLocaleString()}`);
    }
    return headers.map((_, columnIndex) => {
      const value = row[columnIndex];
      const text = (value === null || value === undefined ? '' : String(value)).slice(0, MAX_CELL_CHARACTERS);
      textBytes += Buffer.byteLength(text, 'utf8');
      if (textBytes > MAX_SHEET_TEXT_BYTES) {
        throw new Error('Google Sheets sync is limited to 64 MiB of materialized cell text per staged run.');
      }
      return text;
    });
  });
}

async function execute(): Promise<unknown> {
  if (input.operation !== 'stage') {
    return input.operation === 'preview'
      ? catalog.previewImport(input.request.filePath, input.request.sheetName, input.request.mapping)
      : input.operation === 'commit'
        ? catalog.commitImport(
            input.request.filePath,
            input.request.sheetName,
            input.request.mapping,
            input.request.previewId
          )
        : catalog.refresh(input.request.filePath, input.request.templateId ?? 'envato-default');
  }

  const rows = boundedRows(await receiveRows());
  assertActive();
  progress(0.36, 'stage_hashing', 'Hashing the bounded Google Sheets snapshot');
  const sourceSha256 = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  assertActive();
  progress(0.4, 'stage_materializing', 'Materializing the bounded workbook off the main process');
  if (existsSync(input.request.filePath)) {
    throw new Error('Catalog stage output already exists; refusing to overwrite it.');
  }
  stageOutputOwned = true;
  mkdirSync(dirname(input.request.filePath), { recursive: true });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), input.request.sheetName ?? 'Catalog');
  XLSX.writeFile(workbook, input.request.filePath);
  assertActive();
  const preview = catalog.previewImport(input.request.filePath, input.request.sheetName ?? 'Catalog');
  if (cancelled()) {
    catalog.cancelImportPreview(preview.previewId);
    throw new CatalogImportCancelledError();
  }
  return { sourceSha256, preview };
}

const database = new AppDatabase(input.databasePath);
const catalog = new CatalogService(database, new PlaceService(database), {
  isCancelled: cancelled,
  onProgress: (progressValue, phase, message) => {
    progress(input.operation === 'stage' ? 0.42 + progressValue * 0.58 : progressValue, phase, message);
  }
});

function errorMessage(error: unknown): { type: 'error'; error: { name: string; message: string; stack?: string } } {
  return {
    type: 'error',
    error: {
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    }
  };
}

void (async () => {
  let terminalMessage: { type: 'result'; result: unknown } | ReturnType<typeof errorMessage>;
  try {
    terminalMessage = { type: 'result', result: await execute() };
  } catch (error) {
    let terminalError = error;
    if (input.operation === 'stage' && stageOutputOwned && existsSync(input.request.filePath)) {
      try {
        unlinkSync(input.request.filePath);
      } catch (cleanupError) {
        terminalError = new AggregateError(
          [error, cleanupError],
          'Catalog staging failed and its temporary workbook could not be removed.'
        );
      }
    }
    terminalMessage = errorMessage(terminalError);
  }

  try {
    database.close();
  } catch (error) {
    terminalMessage = errorMessage(error);
  }
  port.postMessage(terminalMessage);
  port.close();
})();
