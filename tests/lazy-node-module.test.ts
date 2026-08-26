import { describe, expect, it, vi } from 'vitest';
import { lazyNodeModule } from '@shared/lazy-node-module';

describe('lazyNodeModule', () => {
  it('does not load a dependency until first use and caches its value', () => {
    const dependency = { ready: true };
    const load = vi.fn(() => dependency);
    const module = lazyNodeModule<typeof dependency>('expensive-module', load);

    expect(load).not.toHaveBeenCalled();
    expect(module()).toBe(dependency);
    expect(module()).toBe(dependency);
    expect(load).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledWith('expensive-module');
  });

  it('caches an undefined export without reloading it', () => {
    const load = vi.fn(() => undefined);
    const module = lazyNodeModule<undefined>('undefined-module', load);

    expect(module()).toBeUndefined();
    expect(module()).toBeUndefined();
    expect(load).toHaveBeenCalledOnce();
  });
});
