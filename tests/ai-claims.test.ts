import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase } from '@main/database/database';
import { AiService } from '@main/services/ai-service';
import type { AppSettings } from '@shared/types';
import { providerEndpointTestPolicy } from './provider-endpoint-test-utils';
import type { CatalogAsset, CoverageCluster } from '@shared/types';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'videofactory-ai-claims-'));
  roots.push(root);
  const db = new AppDatabase(join(root, 'db.sqlite'));
  const now = new Date().toISOString();
  db.raw.prepare(`INSERT INTO projects(id, sequence, slug, title, topic, state, progress, envato_project_name, target_duration_ms, provider_budget_usd, created_at, updated_at) VALUES('p1', 1, 'p1', 'P1', 'P1', 'RESEARCHING', 0, 'YT-P1', 1000, 20, ?, ?)`).run(now, now);
  const settings = { llmProvider: 'openai_compatible', llmBaseUrl: 'https://api.openai.com/v1', llmEndpointTrust: 'managed', llmModel: 'test', monthlyBudgetUsd: 100 } as AppSettings;
  const secrets = { getAll: () => ({ llmApiKey: 'secret' }) } as never;
  const endpoints = providerEndpointTestPolicy(db, secrets, () => settings);
  return { db, service: new AiService(db, secrets, () => settings, undefined, endpoints) };
}

function response(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'x-request-id': 'req-1' } });
}

describe('LLM claim extraction', () => {
  it('does not silently downgrade an explicitly configured provider with a missing key', async () => {
    const { db } = fixture();
    const settings = { llmProvider: 'openai_compatible', llmBaseUrl: 'https://api.openai.com/v1', llmEndpointTrust: 'managed', llmModel: 'test', monthlyBudgetUsd: 100 } as AppSettings;
    const secrets = { getAll: () => ({}) } as never;
    const service = new AiService(db, secrets, () => settings, undefined, providerEndpointTestPolicy(db, secrets, () => settings));
    await expect(service.generateScript({
      projectId: 'p1', topicTitle: 'Museum', destination: 'Paris', targetMinutes: 1,
      coverage: { key: 'Paris' } as CoverageCluster,
      assets: []
    })).rejects.toThrow('local fallback was not used');
    await expect(service.extractClaims({
      projectId: 'p1',
      topicTitle: 'Museum',
      destination: 'Paris',
      sources: []
    })).rejects.toThrow('claim extraction was not skipped silently');
    db.close();
  });

  it('accepts only app-issued source IDs and records a cacheable receipt', async () => {
    const { db, service } = fixture();
    const valid = { claims: [{ text: 'Open daily.', normalizedKey: 'museum-hours', category: 'hours', confidence: 0.9, stability: 'time_sensitive', validAsOf: '2026-08-12', sourceIds: ['source-1'], material: true }] };
    const fetchMock = vi.fn().mockResolvedValue(response(JSON.stringify(valid)));
    vi.stubGlobal('fetch', fetchMock);
    const input = { projectId: 'p1', topicTitle: 'Museum', destination: 'Paris', sources: [{ id: 'source-1', url: 'https://example.test', title: 'Official', publisher: 'example.test', publishedAt: null, excerpt: 'Open daily.', content: 'Open daily.' }] };
    expect(await service.extractClaims(input)).toHaveLength(1);
    expect(await service.extractClaims(input)).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(db.raw.prepare(`SELECT error, retry_count FROM provider_calls WHERE operation = 'fact_extraction'`).get()).toEqual({ error: null, retry_count: 0 });
    db.close();
  });

  it('uses one corrective retry then rejects invented source IDs', async () => {
    const { db, service } = fixture();
    const invented = { claims: [{ text: 'Open daily.', normalizedKey: 'museum-hours', category: 'hours', confidence: 0.9, stability: 'time_sensitive', validAsOf: '2026-08-12', sourceIds: ['invented'], material: true }] };
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(response(JSON.stringify(invented))));
    vi.stubGlobal('fetch', fetchMock);
    await expect(service.extractClaims({ projectId: 'p1', topicTitle: 'Museum', destination: 'Paris', sources: [{ id: 'source-1', url: 'https://example.test', title: 'Official', publisher: null, publishedAt: null, excerpt: 'Open daily.', content: 'Open daily.' }] })).rejects.toThrow('unknown source IDs');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(db.raw.prepare(`SELECT retry_count FROM provider_calls WHERE operation = 'fact_extraction'`).get()).toEqual({ retry_count: 1 });
    db.close();
  });

  it('corrects an invented script claim once and records both billed attempts', async () => {
    const { db, service } = fixture();
    const scene = {
      chapter: 'Visit', narration: 'Open daily.', targetDurationMs: 3000,
      requiredCountry: 'France', requiredCity: 'Paris', requiredLocation: 'Museum',
      requiredGranularity: 'landmark', requiredObjects: ['museum'], requiredActivities: [],
      preferredShots: ['wide'], visualTreatment: 'EXACT_LOCATION_FOOTAGE'
    };
    const invalid = { title: 'Museum', topic: 'Museum', destination: 'Paris', summary: 'Visit', scenes: Array.from({ length: 3 }, () => ({ ...scene, claimIds: ['invented'] })) };
    const valid = { ...invalid, scenes: Array.from({ length: 3 }, () => ({ ...scene, claimIds: ['claim-1'] })) };
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(response(JSON.stringify(invalid))))
      .mockImplementationOnce(() => Promise.resolve(response(JSON.stringify(valid))));
    vi.stubGlobal('fetch', fetchMock);
    const script = await service.generateScript({
      projectId: 'p1', topicTitle: 'Museum', destination: 'Paris', targetMinutes: 1,
      coverage: { key: 'Paris', country: 'France', city: 'Paris', locationName: 'Museum', assetCount: 12, uniqueShotTypes: 4, uniqueActivities: 1, uniqueTimes: 1, landscapeCount: 12, fourKCount: 0, downloadedCount: 0, verifiedCount: 12, coverageScore: 80 } as CoverageCluster,
      assets: [{ id: 'asset-1', title: 'Museum', country: 'France', city: 'Paris', locationName: 'Museum', locationGranularity: 'landmark' } as CatalogAsset],
      acceptedClaims: [{ id: 'claim-1', text: 'Open daily.', category: 'hours', sourceIds: ['source-1'] }]
    });
    expect(script.scenes[0]?.claimIds).toEqual(['claim-1']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(db.raw.prepare(`SELECT retry_count, estimated_cost_usd FROM provider_calls WHERE operation = 'generate_script'`).get()).toEqual({ retry_count: 1, estimated_cost_usd: 0.1 });
    db.close();
  });

  it('never sends raw editorial seed text to the provider or accepts its unsupported facts', async () => {
    const { db, service } = fixture();
    const unsupported = 'The museum was built in 1450.';
    const scene = {
      chapter: 'Visit', narration: unsupported, targetDurationMs: 3000,
      requiredCountry: 'France', requiredCity: 'Paris', requiredLocation: 'Museum',
      requiredGranularity: 'landmark', requiredObjects: ['museum'], requiredActivities: [],
      preferredShots: ['wide'], visualTreatment: 'EXACT_LOCATION_FOOTAGE', claimIds: []
    };
    const responseBody = {
      title: 'Museum', topic: 'Museum', destination: 'Paris', summary: 'Visit',
      scenes: Array.from({ length: 3 }, () => scene)
    };
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(response(JSON.stringify(responseBody))));
    vi.stubGlobal('fetch', fetchMock);

    await expect(service.generateScript({
      projectId: 'p1', topicTitle: 'Museum', destination: 'Paris', targetMinutes: 1,
      coverage: { key: 'Paris' } as CoverageCluster,
      assets: [{
        id: 'asset-1', title: 'Museum exterior', country: 'France', city: 'Paris',
        locationName: 'Museum', locationGranularity: 'landmark',
        sceneDescription: 'Visitors cross the plaza.'
      } as CatalogAsset],
      startingScript: `Use a calm documentary tone. ${unsupported}`
    })).rejects.toThrow('operator guidance');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      const request = JSON.parse(String((call[1] as RequestInit).body));
      expect(JSON.stringify(request.messages)).not.toContain(unsupported);
      expect(JSON.stringify(request.messages)).toContain('rawTextSharedWithProvider');
    }
    expect(db.raw.prepare(`SELECT count(*) AS count FROM research_sources`).get()).toEqual({ count: 0 });
    expect(db.raw.prepare(`SELECT count(*) AS count FROM fact_claims`).get()).toEqual({ count: 0 });
    db.close();
  });

  it('also blocks unsupported editorial facts from a final-script rewrite', async () => {
    const { db, service } = fixture();
    const unsupported = 'The museum was built in 1450.';
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(response(JSON.stringify({
      scenes: [{ sceneId: 'scene-1', narration: unsupported, pronunciation: {} }]
    }))));
    vi.stubGlobal('fetch', fetchMock);

    await expect(service.finalizeScript({
      projectId: 'p1', title: 'Museum', topic: 'Museum', destination: 'Paris',
      scenes: [{
        id: 'scene-1', ordinal: 1, chapter: 'Visit', narration: 'Visitors cross the museum plaza.',
        targetDurationMs: 3000, visualTreatment: 'EXACT_LOCATION_FOOTAGE',
        requiredCountry: 'France', requiredCity: 'Paris', requiredLocation: 'Museum',
        selectedAssetId: 'asset-1', selectedFileId: 'file-1', selectedSegmentId: 'segment-1',
        sourceDurationMs: 3000, verificationState: 'verified', claimIds: []
      }],
      acceptedClaims: [], pronunciationDictionary: {},
      startingScript: `Keep the pacing brisk. ${unsupported}`
    })).rejects.toThrow('operator guidance');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(String((call[1] as RequestInit).body)).not.toContain(unsupported);
    }
    db.close();
  });
});
