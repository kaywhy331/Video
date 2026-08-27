import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { CatalogImportWorkerService } from '@main/services/catalog-import-worker-service';
import type { ProgressEvent } from '@shared/types';

const workerPath = fileURLToPath(new URL('./fixtures/catalog-import-worker-stub.mjs', import.meta.url));
const runners: CatalogImportWorkerService[] = [];

function fixture() {
  const events: ProgressEvent[] = [];
  const runner = new CatalogImportWorkerService('unused.sqlite', event => events.push(event), workerPath);
  runners.push(runner);
  return { runner, events };
}

afterEach(async () => {
  await Promise.all(runners.splice(0).map(runner => runner.shutdown()));
});

describe('CatalogImportWorkerService lifecycle', () => {
  it('reports progress, rejects concurrent work, streams stage rows, and clears completed status', async () => {
    const value = fixture();
    const pending = value.runner.preview('preview-operation', { filePath: 'success' });
    expect(value.runner.status()).toMatchObject({
      operationId: 'preview-operation', operation: 'preview', state: 'running'
    });
    expect(() => value.runner.preview('concurrent-operation', { filePath: 'success' }))
      .toThrow('Another catalog import operation is already running');
    await expect(pending).resolves.toMatchObject({ previewId: 'preview-stub', rowCount: 1 });
    expect(value.runner.status()).toBeNull();
    expect(value.events.map(event => event.phase)).toEqual(expect.arrayContaining(['working', 'preview_complete']));

    await expect(value.runner.stage('stage-operation', {
      filePath: 'stage', rows: [['ID'], ['1'], ['2']], sheetName: 'Catalog'
    })).resolves.toMatchObject({ sourceSha256: 'stub-hash', preview: { rowCount: 2 } });
    expect(value.runner.status()).toBeNull();
    expect(value.events.at(-1)).toMatchObject({ jobId: 'stage-operation', phase: 'stage_complete', progress: 1 });
  });

  it('propagates cooperative cancellation and emits a terminal cancellation event', async () => {
    const value = fixture();
    const pending = value.runner.commit('cancel-operation', { filePath: 'cancel', previewId: 'preview-stub' });
    expect(value.runner.cancel('cancel-operation')).toBe(true);
    expect(value.runner.status()).toMatchObject({ state: 'cancelling' });
    await expect(pending).rejects.toMatchObject({ name: 'CatalogImportCancelledError' });
    expect(value.runner.status()).toBeNull();
    expect(value.events.at(-1)).toMatchObject({ phase: 'commit_cancelled', progress: 1 });
  });

  it('turns an early worker exit into a terminal failure event and clears active state', async () => {
    const value = fixture();
    await expect(value.runner.preview('crash-operation', { filePath: 'crash' }))
      .rejects.toThrow('exited before returning a result (7)');
    expect(value.runner.status()).toBeNull();
    expect(value.events.at(-1)).toMatchObject({ jobId: 'crash-operation', phase: 'preview_failed', progress: 1 });
  });

  it('does not report completion or clear active state until the worker exits', async () => {
    const value = fixture();
    const pending = value.runner.preview('delayed-exit-operation', { filePath: 'delayed-exit' });
    await vi.waitFor(() => expect(value.events.some(event => event.phase === 'terminal_sent')).toBe(true));

    expect(value.runner.status()).toMatchObject({ operationId: 'delayed-exit-operation', state: 'running' });
    expect(value.events.some(event => event.phase === 'preview_complete')).toBe(false);

    await expect(pending).resolves.toMatchObject({ previewId: 'preview-stub' });
    expect(value.runner.status()).toBeNull();
    expect(value.events.at(-1)).toMatchObject({ phase: 'preview_complete', progress: 1 });
  });
});
