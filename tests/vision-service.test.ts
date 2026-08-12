import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase } from '@main/database/database';
import { VisionService, type VisionSceneContract } from '@main/services/vision-service';
import type { AppSettings } from '@shared/types';

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'videofactory-vision-adapter-'));
  roots.push(root);
  const db = new AppDatabase(join(root, 'videofactory.sqlite'));
  const now = new Date().toISOString();
  db.raw.prepare(`
    INSERT INTO projects(
      id, sequence, slug, title, topic, state, progress, envato_project_name,
      target_duration_ms, created_at, updated_at
    ) VALUES('project-1', 1, 'project-1', 'Project', 'Topic', 'VERIFYING_FOOTAGE',
      0.5, 'YT-TEST-0001', 300000, ?, ?)
  `).run(now, now);
  const image = join(root, 'sheet.jpg');
  writeFileSync(image, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const settings = {
    visionProvider: 'openai_compatible',
    visionBaseUrl: 'https://vision.example/v1',
    visionModel: 'vision-test',
    monthlyBudgetUsd: 10
  } as AppSettings;
  const service = new VisionService(
    db,
    { getAll: () => ({ visionApiKey: 'secret' }) } as never,
    () => settings
  );
  const input: VisionSceneContract = {
    projectId: 'project-1',
    sceneId: 'scene-1',
    assetId: 'asset-1',
    assetFileId: 'file-1',
    assetSha256: 'sha-file-1',
    contactSheetPath: image,
    narration: 'Visitors walk under the tower.',
    requiredCountry: 'France',
    requiredCity: 'Paris',
    requiredLocation: 'Eiffel Tower',
    requiredGranularity: 'landmark',
    requiredObjects: ['tower'],
    requiredActivities: ['walking'],
    preferredShots: ['wide'],
    visualTreatment: 'EXACT_LOCATION_FOOTAGE'
  };
  return { db, service, input };
}

const valid = {
  geography: {
    verdict: 'match', confidence: 0.95, country: 'France', city: 'Paris',
    location: 'Eiffel Tower', granularity: 'landmark', evidence: ['Tower visible']
  },
  objects: [{ requirement: 'tower', present: true, confidence: 0.95, evidence: 'Visible' }],
  activities: [{ requirement: 'walking', present: true, confidence: 0.9, evidence: 'Visible' }],
  disallowedContent: [],
  technicalConcerns: [],
  summary: 'Supported'
};

function response(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-request-id': 'request-1' }
  });
}

describe('OpenAI-compatible vision adapter', () => {
  it('sends a bounded image input, validates the response, and reuses the cache', async () => {
    const { db, service, input } = fixture();
    const fetchMock = vi.fn().mockResolvedValue(response(JSON.stringify(valid)));
    vi.stubGlobal('fetch', fetchMock);

    const first = await service.assess(input);
    const second = await service.assess(input);

    expect(first).toMatchObject({ cached: false, assessment: valid });
    expect(second).toMatchObject({ cached: true, assessment: valid });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(request.body)) as Record<string, any>;
    expect(body.messages[1].content[1]).toMatchObject({
      type: 'image_url',
      image_url: { detail: 'high' }
    });
    expect(body.messages[1].content[1].image_url.url).toMatch(/^data:image\/jpeg;base64,/);
    expect(db.raw.prepare(`
      SELECT error, retry_count FROM provider_calls WHERE operation = 'verify_footage'
    `).get()).toEqual({ error: null, retry_count: 0 });
    db.close();
  });

  it('allows one corrective response attempt and records terminal malformed output', async () => {
    const first = fixture();
    const retryFetch = vi.fn()
      .mockResolvedValueOnce(response('{"geography":'))
      .mockResolvedValueOnce(response(JSON.stringify(valid)));
    vi.stubGlobal('fetch', retryFetch);
    expect(await first.service.assess(first.input)).toMatchObject({ cached: false });
    expect(retryFetch).toHaveBeenCalledTimes(2);
    expect(first.db.raw.prepare(`
      SELECT retry_count, error FROM provider_calls WHERE operation = 'verify_footage'
    `).get()).toEqual({ retry_count: 1, error: null });
    first.db.close();

    const second = fixture();
    const invalidFetch = vi.fn().mockResolvedValue(response('{}'));
    vi.stubGlobal('fetch', invalidFetch);
    await expect(second.service.assess(second.input)).rejects.toThrow();
    expect(invalidFetch).toHaveBeenCalledTimes(2);
    const errorRow = second.db.raw.prepare(`
      SELECT error, retry_count FROM provider_calls WHERE operation = 'verify_footage'
    `).get() as { error: string; retry_count: number };
    expect(errorRow.error).toBeTruthy();
    expect(errorRow.retry_count).toBe(1);
    second.db.close();
  });
});
