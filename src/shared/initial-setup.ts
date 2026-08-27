import type { AppBootstrap, OperationsHealth, ProviderCapabilityRecord } from './types';

export const PRODUCTION_CATALOG_MINIMUM_ROWS = 26_000;

export type InitialSetupStepId =
  | 'storage'
  | 'media_tools'
  | 'catalog'
  | 'providers'
  | 'youtube';

export interface InitialSetupStep {
  id: InitialSetupStepId;
  label: string;
  detail: string;
  complete: boolean;
}

export interface InitialSetupState {
  required: boolean;
  ready: boolean;
  completedSteps: number;
  steps: InitialSetupStep[];
}

const productionProviderCapabilities = Object.freeze(['llm', 'vision', 'research', 'tts'] as const);
const blockingProviderHealthStatuses = new Set<OperationsHealth['providers'][number]['status']>([
  'auth_invalid',
  'quota_exhausted',
  'invalid_endpoint',
  'endpoint_untrusted',
  'credential_origin_mismatch'
]);

/**
 * Derives setup state from authoritative runtime facts rather than a dismissible
 * preference. A truly fresh workspace opens setup; the checklist remains useful
 * until every prerequisite for autonomous production is present.
 */
export function initialSetupState(bootstrap: AppBootstrap): InitialSetupState {
  const diagnostics = bootstrap.diagnostics;
  const providerHealth = Array.isArray(bootstrap.operationsHealth?.providers)
    ? bootstrap.operationsHealth.providers
    : [];
  const minimumFreeBytes = bootstrap.settings.minFreeDiskGb * 1024 ** 3;
  const storageReady = Boolean(
    diagnostics
    && diagnostics.database.open
    && diagnostics.database.integrity === 'ok'
    && diagnostics.database.walMode
    && diagnostics.paths.length >= 7
    && diagnostics.paths.every(path => (
      path.exists
      && path.writable === true
      && typeof path.freeBytes === 'number'
      && path.freeBytes >= minimumFreeBytes
    ))
  );
  const mediaToolsReady = Boolean(
    diagnostics?.ffmpeg.found
    && diagnostics.ffprobe.found
    && diagnostics.ffmpeg.encoderTests.some(test => test.id === 'libx264' && test.usable)
    && diagnostics.mediaSmokeTest.encoded
    && diagnostics.mediaSmokeTest.probed
  );
  const catalogReady = bootstrap.catalog.totalAssets >= PRODUCTION_CATALOG_MINIMUM_ROWS;
  const providersReady = productionProviderCapabilities.every(capability => (
    bootstrap.expansion.providers.some(provider => (
      productionProviderReady(provider, capability)
      && !blockingProviderHealth(provider.providerKey, providerHealth)
    ))
  ));
  const productionProviderFailure = providerHealth.find(health => (
    blockingProviderHealthStatuses.has(health.status)
    && bootstrap.expansion.providers.some(provider => (
      productionProviderCapabilities.includes(
        provider.capability as typeof productionProviderCapabilities[number]
      )
      && productionProviderReady(
        provider,
        provider.capability as typeof productionProviderCapabilities[number]
      )
      && providerHealthMatches(provider.providerKey, health.provider)
    ))
  ));
  const youtubeProviderReady = bootstrap.expansion.providers.some(provider => (
    provider.capability === 'uploader'
    && provider.providerKey === 'youtube'
    && provider.configured
    && provider.available
    && !blockingProviderHealth(provider.providerKey, providerHealth)
  ));
  const youtubeProviderFailure = providerHealth.find(health => (
    blockingProviderHealthStatuses.has(health.status)
    && providerHealthMatches('youtube', health.provider)
  ));
  const youtubeReady = bootstrap.secrets.youtubeAuthorized && youtubeProviderReady;

  const steps: InitialSetupStep[] = [
    {
      id: 'storage',
      label: 'Storage and database',
      detail: storageReady
        ? 'Every configured path is writable with the required free space; SQLite integrity and WAL checks pass.'
        : 'Choose reachable writable paths, then run diagnostics until free-space and database checks pass.',
      complete: storageReady
    },
    {
      id: 'media_tools',
      label: 'FFmpeg and FFprobe',
      detail: mediaToolsReady
        ? 'The active media tools completed a real H.264 encode and probe.'
        : 'Use the bundled tools or inspect trusted overrides, then run the media diagnostic.',
      complete: mediaToolsReady
    },
    {
      id: 'catalog',
      label: 'Production footage catalog',
      detail: catalogReady
        ? `${bootstrap.catalog.totalAssets.toLocaleString()} assets are available for grounded planning.`
        : `Import at least ${PRODUCTION_CATALOG_MINIMUM_ROWS.toLocaleString()} validated rows (${bootstrap.catalog.totalAssets.toLocaleString()} currently available).`,
      complete: catalogReady
    },
    {
      id: 'providers',
      label: 'Production AI and narration providers',
      detail: providersReady
        ? 'Language, vision, research, and narration adapters are configured and available.'
        : productionProviderFailure
          ? providerFailureDetail(productionProviderFailure, 'Resolve the provider health blocker')
          : 'Configure available non-fixture language, vision, research, and narration adapters.',
      complete: providersReady
    },
    {
      id: 'youtube',
      label: 'Confirmed YouTube channel',
      detail: youtubeReady
        ? 'The private-first uploader is authorized and bound to a confirmed channel.'
        : youtubeProviderFailure
          ? providerFailureDetail(youtubeProviderFailure, 'Reconnect or recover the confirmed YouTube channel')
          : 'Connect Google OAuth and confirm the intended YouTube channel before enabling Autopilot.',
      complete: youtubeReady
    }
  ];
  const completedSteps = steps.filter(step => step.complete).length;

  return {
    required: bootstrap.projects.length === 0 && completedSteps !== steps.length,
    ready: completedSteps === steps.length,
    completedSteps,
    steps
  };
}

function productionProviderReady(
  provider: ProviderCapabilityRecord,
  capability: typeof productionProviderCapabilities[number]
): boolean {
  return provider.capability === capability
    && provider.configured
    && provider.available
    && provider.externalQualification !== 'not_required';
}

function blockingProviderHealth(
  providerKey: string,
  health: OperationsHealth['providers']
): boolean {
  return health.some(record => (
    blockingProviderHealthStatuses.has(record.status)
    && providerHealthMatches(providerKey, record.provider)
  ));
}

function providerHealthMatches(providerKey: string, recordedProvider: string): boolean {
  return providerKey === recordedProvider
    || (providerKey === 'youtube' && recordedProvider === 'google');
}

function providerFailureDetail(
  failure: OperationsHealth['providers'][number],
  recovery: string
): string {
  const status = failure.status.replaceAll('_', ' ');
  const cause = failure.message ?? failure.provider + ' reports ' + status;
  return recovery + ' before starting new Autopilot work: ' + cause.replace(/[.]+$/, '') + '.';
}
