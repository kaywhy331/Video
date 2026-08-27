import type { AppBootstrap, ProviderCapabilityRecord } from './types';

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

/**
 * Derives setup state from authoritative runtime facts rather than a dismissible
 * preference. A truly fresh workspace opens setup; the checklist remains useful
 * until every prerequisite for autonomous production is present.
 */
export function initialSetupState(bootstrap: AppBootstrap): InitialSetupState {
  const diagnostics = bootstrap.diagnostics;
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
    bootstrap.expansion.providers.some(provider => productionProviderReady(provider, capability))
  ));
  const youtubeProviderReady = bootstrap.expansion.providers.some(provider => (
    provider.capability === 'uploader'
    && provider.providerKey === 'youtube'
    && provider.configured
    && provider.available
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
        : 'Configure available non-fixture language, vision, research, and narration adapters.',
      complete: providersReady
    },
    {
      id: 'youtube',
      label: 'Confirmed YouTube channel',
      detail: youtubeReady
        ? 'The private-first uploader is authorized and bound to a confirmed channel.'
        : 'Connect Google OAuth and confirm the intended YouTube channel before enabling Autopilot.',
      complete: youtubeReady
    }
  ];
  const completedSteps = steps.filter(step => step.complete).length;

  return {
    required: bootstrap.projects.length === 0 && bootstrap.catalog.totalAssets === 0,
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
