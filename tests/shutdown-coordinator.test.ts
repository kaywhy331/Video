import { describe, expect, it, vi } from 'vitest';
import { ShutdownCoordinator } from '@main/shutdown-coordinator';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(nextResolve => { resolve = nextResolve; });
  return { promise, resolve };
}

describe('shutdown coordinator', () => {
  it('prevents duplicate quit requests and re-enters quit only after stop resolves', async () => {
    const stopping = deferred();
    const stop = vi.fn(() => stopping.promise);
    const completeQuit = vi.fn();
    const coordinator = new ShutdownCoordinator({ stop, completeQuit });
    const first = { preventDefault: vi.fn() };
    const second = { preventDefault: vi.fn() };

    coordinator.handleBeforeQuit(first);
    coordinator.handleBeforeQuit(second);
    await Promise.resolve();
    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(second.preventDefault).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(completeQuit).not.toHaveBeenCalled();

    stopping.resolve();
    await stopping.promise;
    await vi.waitFor(() => expect(completeQuit).toHaveBeenCalledOnce());

    const final = { preventDefault: vi.fn() };
    coordinator.handleBeforeQuit(final);
    expect(final.preventDefault).not.toHaveBeenCalled();
  });

  it('reports a pending safe drain after the grace period without forcing quit', async () => {
    vi.useFakeTimers();
    try {
      const stopping = deferred();
      const onPending = vi.fn();
      const completeQuit = vi.fn();
      const coordinator = new ShutdownCoordinator({
        stop: () => stopping.promise,
        completeQuit,
        onPending,
        graceMs: 100
      });

      coordinator.handleBeforeQuit({ preventDefault: vi.fn() });
      await vi.advanceTimersByTimeAsync(100);
      expect(onPending).toHaveBeenCalledOnce();
      expect(completeQuit).not.toHaveBeenCalled();

      stopping.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(completeQuit).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
