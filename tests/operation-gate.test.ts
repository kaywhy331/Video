import { describe, expect, it } from 'vitest';
import { OperationGate, OperationGateClosedError } from '@main/services/operation-gate';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe('operation gate', () => {
  it('closes admission but drains work that was already accepted', async () => {
    const gate = new OperationGate();
    const work = deferred<string>();
    const running = gate.run('final render', () => work.promise);
    gate.close();

    expect(gate.snapshot()).toHaveLength(1);
    await expect(gate.run('late upload', async () => undefined)).rejects.toBeInstanceOf(OperationGateClosedError);

    let drained = false;
    const drain = gate.waitForIdle().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);

    work.resolve('complete');
    await expect(running).resolves.toBe('complete');
    await drain;
    expect(drained).toBe(true);
    expect(gate.snapshot()).toEqual([]);
  });

  it('drains rejected operations without leaking their registry entry', async () => {
    const gate = new OperationGate();
    await expect(gate.run('failed task', async () => {
      throw new Error('expected failure');
    })).rejects.toThrow('expected failure');
    await gate.waitForIdle();
    expect(gate.snapshot()).toEqual([]);
  });
});
