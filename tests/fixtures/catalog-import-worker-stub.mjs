import { parentPort, workerData } from 'node:worker_threads';

const cancelFlag = new Int32Array(workerData.cancelBuffer);

function preview(rowCount = 1) {
  return {
    previewId: 'preview-stub',
    filePath: workerData.request.filePath,
    sheetNames: ['Catalog'],
    selectedSheet: 'Catalog',
    rowCount,
    columns: ['ID'],
    mapping: { envatoId: 'ID' },
    sampleRows: [],
    diff: { inserted: rowCount, changed: 0, conflicts: 0, missing: 0, invalid: 0 },
    warnings: []
  };
}

function finish(message, delayMs = 0) {
  parentPort.postMessage(message);
  setTimeout(() => parentPort.close(), delayMs);
}

if (workerData.request.filePath === 'crash') {
  process.exit(7);
} else if (workerData.request.filePath === 'cancel') {
  parentPort.postMessage({ type: 'progress', progress: 0.25, phase: 'working', message: 'Waiting for cancellation' });
  const timer = setInterval(() => {
    if (Atomics.load(cancelFlag, 0) !== 1) return;
    clearInterval(timer);
    finish({
      type: 'error',
      error: { name: 'CatalogImportCancelledError', message: 'Catalog import cancelled.' }
    });
  }, 2);
} else if (workerData.operation === 'stage') {
  const rows = [];
  parentPort.on('message', message => {
    if (message.type === 'rows') rows.push(...message.rows);
    if (message.type === 'rows-end') {
      finish({ type: 'result', result: { sourceSha256: 'stub-hash', preview: preview(Math.max(0, rows.length - 1)) } });
    }
  });
} else {
  parentPort.postMessage({ type: 'progress', progress: 0.5, phase: 'working', message: 'Worker is responsive' });
  setTimeout(() => {
    if (workerData.request.filePath === 'delayed-exit') {
      parentPort.postMessage({ type: 'progress', progress: 0.9, phase: 'terminal_sent', message: 'Sending result before exit' });
    }
    finish({ type: 'result', result: preview() }, workerData.request.filePath === 'delayed-exit' ? 100 : 0);
  }, 10);
}
