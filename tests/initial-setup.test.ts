import { describe, expect, it } from 'vitest';
import type { AppBootstrap, ProviderCapabilityRecord } from '@shared/types';
import { initialSetupState, PRODUCTION_CATALOG_MINIMUM_ROWS } from '@shared/initial-setup';

function provider(
  providerKey: string,
  capability: ProviderCapabilityRecord['capability'],
  overrides: Partial<ProviderCapabilityRecord> = {}
): ProviderCapabilityRecord {
  return {
    id: `provider-${providerKey}`,
    providerKey,
    displayName: providerKey,
    capability,
    implementation: 'qualification-fixture',
    configured: true,
    available: true,
    externalQualification: 'unverified',
    capabilities: {},
    lastCheckedAt: null,
    statusMessage: null,
    ...overrides
  };
}

function bootstrap(overrides: Partial<AppBootstrap> = {}): AppBootstrap {
  const freeBytes = 100 * 1024 ** 3;
  return {
    settings: { minFreeDiskGb: 10 } as AppBootstrap['settings'],
    secrets: {
      llmApiKeyConfigured: true,
      visionApiKeyConfigured: true,
      researchApiKeyConfigured: true,
      httpTtsApiKeyConfigured: false,
      youtubeClientConfigured: true,
      youtubeAuthorized: true,
      youtubeApiKeyConfigured: false
    },
    diagnostics: {
      checkedAt: new Date(0).toISOString(),
      platform: 'win32-x64',
      appVersion: '0.1.0-alpha.7',
      paths: ['Data root', 'Database', 'Ingest folder', 'Media library', 'Projects', 'Output', 'Backups']
        .map(key => ({ key, path: `C:\\VideoFactory\\${key}`, exists: true, writable: true, freeBytes })),
      ffmpeg: {
        found: true,
        encoders: ['Software H.264'],
        encoderTests: [{ id: 'libx264', label: 'Software H.264', advertised: true, usable: true }]
      },
      ffprobe: { found: true },
      database: { path: 'C:\\VideoFactory\\videofactory.sqlite', open: true, integrity: 'ok', walMode: true },
      mediaSmokeTest: { encoded: true, probed: true },
      issues: [],
      status: 'warning',
      savedRunId: 'diagnostic-1'
    },
    queue: {} as AppBootstrap['queue'],
    catalog: { totalAssets: PRODUCTION_CATALOG_MINIMUM_ROWS } as AppBootstrap['catalog'],
    projects: [],
    exceptions: [],
    latestCatalogRefresh: null,
    latestUpdateCheck: null,
    scheduler: {} as AppBootstrap['scheduler'],
    operationsHealth: {} as AppBootstrap['operationsHealth'],
    providerEndpoints: [],
    learningRecommendations: [],
    musicTracks: [],
    latestStorageCleanup: null,
    expansion: {
      channels: [],
      languages: [],
      outputProfiles: [],
      providers: [
        provider('openai_compatible', 'llm'),
        provider('openai_compatible_vision', 'vision'),
        provider('tavily', 'research'),
        provider('windows_sapi', 'tts'),
        provider('youtube', 'uploader')
      ]
    },
    ...overrides
  };
}

describe('first-run autonomous-production setup', () => {
  it('opens setup for a pristine workspace and reports every missing live prerequisite', () => {
    const value = bootstrap({
      catalog: { totalAssets: 0 } as AppBootstrap['catalog'],
      diagnostics: null,
      secrets: { ...bootstrap().secrets, youtubeAuthorized: false },
      expansion: { ...bootstrap().expansion, providers: [] }
    });

    const state = initialSetupState(value);
    expect(state.required).toBe(true);
    expect(state.ready).toBe(false);
    expect(state.completedSteps).toBe(0);
    expect(state.steps.map(step => [step.id, step.complete])).toEqual([
      ['storage', false],
      ['media_tools', false],
      ['catalog', false],
      ['providers', false],
      ['youtube', false]
    ]);
  });

  it('admits only a full catalog, healthy local runtime, real providers, and confirmed uploader', () => {
    const state = initialSetupState(bootstrap());
    expect(state.required).toBe(false);
    expect(state.ready).toBe(true);
    expect(state.completedSteps).toBe(state.steps.length);

    const fixtureOnly = bootstrap({
      expansion: {
        ...bootstrap().expansion,
        providers: bootstrap().expansion.providers.map(item => item.capability === 'llm'
          ? { ...item, externalQualification: 'not_required' }
          : item)
      }
    });
    expect(initialSetupState(fixtureOnly).steps.find(step => step.id === 'providers')?.complete).toBe(false);
  });

  it('fails closed on low storage, incomplete catalogs, and unconfirmed YouTube state', () => {
    const value = bootstrap();
    value.diagnostics!.paths[0]!.freeBytes = 1;
    value.catalog.totalAssets = PRODUCTION_CATALOG_MINIMUM_ROWS - 1;
    value.secrets.youtubeAuthorized = false;

    const state = initialSetupState(value);
    expect(state.required).toBe(true);
    expect(state.ready).toBe(false);
    expect(state.steps.filter(step => !step.complete).map(step => step.id)).toEqual([
      'storage',
      'catalog',
      'youtube'
    ]);
  });
});
