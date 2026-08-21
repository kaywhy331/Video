import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { AppDatabase } from '@main/database/database';
import { ProviderPolicyService } from '@main/services/provider-policy';
import { requireSuccess } from '@main/services/process-utils';
import { TtsService } from '@main/services/tts-service';
import type { AppSettings } from '@shared/types';

const fixtureRoot = mkdtempSync(join(tmpdir(), 'videofactory-tts-fixture-'));
const fixtureAudio = join(fixtureRoot, 'voice.wav');
const shortFixtureAudio = join(fixtureRoot, 'short-voice.wav');
const roots: string[] = [];

beforeAll(async () => {
  if (!ffmpegPath) throw new Error('ffmpeg-static binary is unavailable.');
  await requireSuccess(ffmpegPath, [
    '-y', '-hide_banner', '-f', 'lavfi',
    '-i', 'sine=frequency=330:sample_rate=48000:duration=2',
    '-ac', '2', '-c:a', 'pcm_s16le', fixtureAudio
  ]);
  await requireSuccess(ffmpegPath, [
    '-y', '-hide_banner', '-f', 'lavfi',
    '-i', 'sine=frequency=330:sample_rate=48000:duration=0.2',
    '-ac', '2', '-c:a', 'pcm_s16le', shortFixtureAudio
  ]);
}, 30_000);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

function fixture(key = 'secret') {
  const root = mkdtempSync(join(tmpdir(), 'videofactory-tts-'));
  roots.push(root);
  const db = new AppDatabase(join(root, 'db.sqlite'));
  const now = new Date().toISOString();
  db.raw.prepare(`
    INSERT INTO projects(
      id, sequence, slug, title, topic, state, progress, envato_project_name,
      target_duration_ms, provider_budget_usd, created_at, updated_at
    ) VALUES('p1', 1, 'p1', 'P1', 'P1', 'GENERATING_VOICE', 0.54,
      'YT-P1', 300000, 5, ?, ?)
  `).run(now, now);
  const settings = {
    narratorProvider: 'http_tts',
    narratorBaseUrl: 'https://tts.example/v1/synthesize',
    narratorModel: 'voice-test',
    narratorVoice: 'narrator-1',
    narratorRate: 0,
    ffprobePath: ffprobeStatic.path,
    monthlyBudgetUsd: 100
  } as AppSettings;
  const policy = new ProviderPolicyService(db, () => settings);
  const service = new TtsService(
    db,
    { getAll: () => key ? ({ httpTtsApiKey: key }) : ({}) } as never,
    () => settings,
    policy
  );
  const directory = join(root, 'voice');
  mkdirSync(directory, { recursive: true });
  return { db, service, outputPath: join(directory, 'section.wav') };
}

function response(wordTimings: unknown, audioPath = fixtureAudio, durationMs = 2_000): Response {
  return new Response(JSON.stringify({
    audioBase64: readFileSync(audioPath).toString('base64'),
    durationMs,
    wordTimings
  }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-request-id': 'tts-request-1' }
  });
}

describe('HTTP TTS section adapter', () => {
  it('sends pronunciation and timing requests, persists the receipt, and reuses immutable cache', async () => {
    const { db, service, outputPath } = fixture();
    const fetchMock = vi.fn().mockResolvedValue(response([
      { word: 'wah-HAH-kah', startMs: 0, endMs: 900, confidence: 0.98 },
      { word: 'shines.', startMs: 900, endMs: 1_900, confidence: 0.97 }
    ]));
    vi.stubGlobal('fetch', fetchMock);

    const first = await service.synthesize({
      projectId: 'p1', text: 'Oaxaca shines.', outputPath,
      pronunciation: { Oaxaca: 'wah-HAH-kah' }
    });
    const second = await service.synthesize({
      projectId: 'p1', text: 'Oaxaca shines.', outputPath,
      pronunciation: { Oaxaca: 'wah-HAH-kah' }
    });

    expect(first).toMatchObject({ cached: false, timingMethod: 'provider_word' });
    expect(first.wordTimings.map(word => word.word)).toEqual(['Oaxaca', 'shines.']);
    expect(second).toMatchObject({ cached: true, inputHash: first.inputHash });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(request.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      pronunciationDictionary: { Oaxaca: 'wah-HAH-kah' },
      requestTimings: true,
      outputFormat: 'wav'
    });
    expect(db.raw.prepare(`
      SELECT status, timing_method FROM voice_assets WHERE project_id = 'p1'
    `).get()).toEqual({ status: 'ready', timing_method: 'provider_word' });
    expect(db.raw.prepare(`
      SELECT error, estimated_cost_usd FROM provider_calls WHERE operation = 'synthesize_section'
    `).get()).toEqual({ error: null, estimated_cost_usd: 0.05 });
    db.close();
  });

  it('fails closed and records a billed provider failure when word timing is absent', async () => {
    const { db, service, outputPath } = fixture();
    const fetchMock = vi.fn().mockResolvedValue(response(undefined));
    vi.stubGlobal('fetch', fetchMock);

    await expect(service.synthesize({ projectId: 'p1', text: 'Oaxaca shines.', outputPath }))
      .rejects.toThrow('word-level timing');
    expect(db.raw.prepare(`SELECT status FROM voice_assets WHERE project_id = 'p1'`).get())
      .toEqual({ status: 'failed' });
    const receipt = db.raw.prepare(`
      SELECT error, estimated_cost_usd FROM provider_calls WHERE operation = 'synthesize_section'
    `).get() as { error: string; estimated_cost_usd: number };
    expect(receipt.error).toContain('word-level timing');
    expect(receipt.estimated_cost_usd).toBe(0.05);
    db.close();
  });

  it('[AUD-004] rejects an implausibly short provider section before timeline use', async () => {
    const { db, service, outputPath } = fixture();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response([
      { word: 'Too', startMs: 0, endMs: 80, confidence: 0.98 },
      { word: 'short.', startMs: 80, endMs: 180, confidence: 0.98 }
    ], shortFixtureAudio, 200)));

    await expect(service.synthesize({ projectId: 'p1', text: 'Too short.', outputPath }))
      .rejects.toThrow('unexpectedly short');
    expect(db.raw.prepare(`SELECT status, error FROM voice_assets WHERE project_id = 'p1'`).get())
      .toMatchObject({ status: 'failed', error: expect.stringContaining('unexpectedly short') });
    db.close();
  });

  it('does not send a request when the configured encrypted key is missing', async () => {
    const { db, service, outputPath } = fixture('');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(service.synthesize({ projectId: 'p1', text: 'Oaxaca shines.', outputPath }))
      .rejects.toThrow('not configured');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.raw.prepare(`SELECT status FROM voice_assets WHERE project_id = 'p1'`).get())
      .toEqual({ status: 'failed' });
    db.close();
  });
});
