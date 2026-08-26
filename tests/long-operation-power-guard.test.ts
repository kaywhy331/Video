import { describe, expect, it, vi } from 'vitest';
import { LongOperationPowerGuard } from '@main/services/long-operation-power-guard';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(next => { resolve = next; });
  return { promise, resolve };
}

describe('long-operation suspension protection', () => {
  it('[SYS-006] keeps protection active until every overlapping lease is released', () => {
    const changes: boolean[] = [];
    const guard = new LongOperationPowerGuard();
    guard.setHandler(active => changes.push(active));

    const releaseFirst = guard.begin();
    const releaseSecond = guard.begin();
    expect(guard.activeCount).toBe(2);
    expect(changes).toEqual([true]);

    releaseFirst();
    releaseFirst();
    expect(guard.activeCount).toBe(1);
    expect(changes).toEqual([true]);

    releaseSecond();
    expect(guard.activeCount).toBe(0);
    expect(changes).toEqual([true, false]);
  });

  it('releases failed and successful scoped work without leaking protection', async () => {
    const changes: boolean[] = [];
    const guard = new LongOperationPowerGuard();
    guard.setHandler(active => changes.push(active));
    const waiting = deferred();
    const first = guard.run(() => waiting.promise);
    const second = guard.run(async () => {
      throw new Error('expected failure');
    });

    await expect(second).rejects.toThrow('expected failure');
    expect(guard.activeCount).toBe(1);
    expect(changes).toEqual([true]);
    waiting.resolve();
    await first;
    expect(guard.activeCount).toBe(0);
    expect(changes).toEqual([true, false]);
  });

  it('synchronizes a handler installed after work has already started', () => {
    const guard = new LongOperationPowerGuard();
    const release = guard.begin();
    const handler = vi.fn();
    guard.setHandler(handler);
    expect(handler).toHaveBeenCalledWith(true);
    release();
    expect(handler).toHaveBeenLastCalledWith(false);
  });

  it('rolls back a partially failed start transition without leaking a lease', () => {
    const changes: boolean[] = [];
    const guard = new LongOperationPowerGuard();
    guard.setHandler(active => {
      changes.push(active);
      if (active) throw new Error('start failed');
    });
    expect(() => guard.begin()).toThrow('start failed');
    expect(guard.activeCount).toBe(0);
    expect(changes).toEqual([true, false]);
  });
});
