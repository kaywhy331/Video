import { createRequire } from 'node:module';

type NodeModuleLoader = (specifier: string) => unknown;

export function lazyNodeModule<T>(
  specifier: string,
  load: NodeModuleLoader = createRequire(import.meta.url)
): () => T {
  let loaded = false;
  let value: T;

  return () => {
    if (!loaded) {
      value = load(specifier) as T;
      loaded = true;
    }
    return value;
  };
}
