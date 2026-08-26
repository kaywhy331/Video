import { lazyNodeModule } from '@shared/lazy-node-module';

const loadGoogleApis = lazyNodeModule<typeof import('googleapis')>('googleapis');

export function googleApis(): typeof import('googleapis') {
  return loadGoogleApis();
}
