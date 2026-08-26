import type { AppDatabase } from '@main/database/database';
import type { SecretStore } from '@main/secret-store';
import { ProviderEndpointPolicy } from '@main/services/provider-endpoint-policy';
import type { AppSettings } from '@shared/types';

export function providerEndpointTestPolicy(
  db: AppDatabase,
  secrets: SecretStore,
  settings: () => AppSettings
): ProviderEndpointPolicy {
  return new ProviderEndpointPolicy(db, secrets, settings, {
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    transport: async (url, init) => fetch(url, init)
  });
}
