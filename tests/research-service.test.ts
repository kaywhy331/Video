import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase } from '@main/database/database';
import { ResearchService } from '@main/services/research-service';
import type { AppSettings } from '@shared/types';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'videofactory-research-'));
  roots.push(root);
  const db = new AppDatabase(join(root, 'db.sqlite'));
  const now = new Date().toISOString();
  db.raw.prepare(`INSERT INTO projects(id, sequence, slug, title, topic, state, progress, envato_project_name, target_duration_ms, provider_budget_usd, created_at, updated_at) VALUES('p1', 1, 'p1', 'P1', 'P1', 'RESEARCHING', 0, 'YT-P1', 1000, 20, ?, ?)`).run(now, now);
  const settings = {
    researchProvider: 'tavily', researchBaseUrl: 'https://api.tavily.test', researchSearchDepth: 'basic',
    researchMaxResultsPerQuery: 5, monthlyBudgetUsd: 100
  } as AppSettings;
  const service = new ResearchService(db, { getAll: () => ({ researchApiKey: 'secret' }) } as never, () => settings);
  return { db, service };
}

describe('Tavily research adapter', () => {
  it('bounds queries, validates real URLs, records receipts, and reuses cached results', async () => {
    const { db, service } = fixture();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      results: [{ url: 'https://museum.example/hours', title: 'Visitor hours', content: 'Open daily.', score: 0.9 }],
      response_time: 0.1, request_id: 'req-1'
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const request = { projectId: 'p1', queries: ['museum hours', 'museum hours'], languageCode: 'en' };
    const first = await service.search(request);
    const second = await service.search(request);
    expect(first).toMatchObject({ cached: false, requestId: 'req-1' });
    expect(second).toMatchObject({ cached: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.data[0]?.url).toBe('https://museum.example/hours');
    expect(db.raw.prepare(`SELECT error, estimated_cost_usd FROM provider_calls WHERE operation = 'research_search'`).get()).toEqual({ error: null, estimated_cost_usd: 0.01 });
    db.close();
  });

  it('persists auth failure so the next attempt is blocked before fetch', async () => {
    const { db, service } = fixture();
    const fetchMock = vi.fn().mockResolvedValue(new Response('bad key', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(service.search({ projectId: 'p1', queries: ['hours'], languageCode: 'en' })).rejects.toThrow('401');
    await expect(service.search({ projectId: 'p1', queries: ['different'], languageCode: 'en' })).rejects.toThrow('401');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(db.raw.prepare(`SELECT estimated_cost_usd FROM provider_calls WHERE operation = 'research_search'`).get()).toEqual({ estimated_cost_usd: 0.01 });
    db.close();
  });

  it('rejects non-web source identifiers from provider output', async () => {
    const { db, service } = fixture();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      results: [{ url: 'urn:invented:source', title: 'Fake', content: 'Fake', score: 1 }]
    }), { status: 200 })));
    await expect(service.search({ projectId: 'p1', queries: ['hours'], languageCode: 'en' })).rejects.toThrow('invalid source URL');
    db.close();
  });
});
