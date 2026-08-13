import { app } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { AppDatabase } from '../database/database';
import type { SecretStore } from '../secret-store';
import type { AppSettings, NarrationWord } from '@shared/types';
import {
  applyPronunciationOverrides,
  durationWeightedWordTimings,
  narrationTokens
} from '@shared/narration';
import { resolveFfmpeg, resolveFfprobe } from '../tool-paths';
import { requireSuccess } from './process-utils';
import type { ProviderPolicyService } from './provider-policy';

export interface SynthesisResult {
  audioPath: string;
  durationMs: number;
  wordTimings: NarrationWord[];
  timingMethod: NarrationWord['timingMethod'];
  provider: string;
  model: string;
  requestId: string | null;
  cached: boolean;
  inputHash: string;
  timingPath: string;
}

interface HttpTtsResponse {
  audioBase64?: string;
  audio?: string;
  audioContent?: string;
  requestId?: string;
  durationMs?: number;
  wordTimings?: Array<{ word: string; startMs: number; endMs: number; confidence?: number }>;
}

function resourcePath(name: string): string {
  const candidates = [
    join(process.cwd(), 'resources', name),
    join(app.getAppPath(), 'resources', name),
    join(process.resourcesPath, 'resources', name),
    join(process.resourcesPath, name)
  ];
  const found = candidates.find(existsSync);
  if (!found) throw new Error(`Resource not found: ${name}`);
  return found;
}

function normalizedDictionary(dictionary: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(dictionary)
      .map(([term, pronunciation]) => [term.trim(), pronunciation.trim()] as const)
      .filter(([term, pronunciation]) => term && pronunciation)
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

function parseWordTimings(
  transcriptText: string,
  spokenText: string,
  value: unknown,
  durationMs: number
): NarrationWord[] | null {
  if (!Array.isArray(value) || !value.length) return null;
  const transcriptTokens = narrationTokens(transcriptText);
  const spokenTokens = narrationTokens(spokenText);
  if (value.length !== transcriptTokens.length || spokenTokens.length !== transcriptTokens.length) return null;
  const timings = value.map((item, index) => {
    const row = item as Record<string, unknown>;
    return {
      word: String(row.word ?? ''),
      startMs: Number(row.startMs),
      endMs: Number(row.endMs),
      confidence: Math.max(0, Math.min(1, Number(row.confidence ?? 0.9))),
      timingMethod: 'provider_word' as const,
      transcriptWord: transcriptTokens[index] ?? '',
      spokenWord: spokenTokens[index] ?? ''
    };
  });
  const normalize = (word: string): string => word.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const valid = timings.every((word, index) =>
    [word.transcriptWord, word.spokenWord].some(expected => normalize(word.word) === normalize(expected))
    && Number.isFinite(word.startMs)
    && Number.isFinite(word.endMs)
    && word.startMs >= 0
    && word.endMs > word.startMs
    && word.endMs <= durationMs + 250
    && (index === 0 || word.startMs >= timings[index - 1]!.endMs)
  );
  return valid ? timings.map(({ transcriptWord, spokenWord: _spokenWord, ...word }) => ({
    ...word,
    word: transcriptWord
  })) : null;
}

export class TtsService {
  constructor(
    private readonly db: AppDatabase,
    private readonly secrets: SecretStore,
    private readonly settings: () => AppSettings,
    private readonly policy?: ProviderPolicyService
  ) {}

  configured(): boolean {
    const settings = this.settings();
    return settings.narratorProvider === 'windows_sapi'
      || (settings.narratorProvider === 'http_tts' && Boolean(this.secrets.getAll().httpTtsApiKey));
  }

  async synthesize(options: {
    projectId: string;
    text: string;
    outputPath: string;
    pronunciation?: Record<string, string>;
  }): Promise<SynthesisResult> {
    const settings = this.settings();
    const pronunciation = normalizedDictionary(options.pronunciation ?? {});
    const spokenText = applyPronunciationOverrides(options.text, pronunciation);
    const provider = settings.narratorProvider;
    const model = provider === 'windows_sapi' ? 'system-speech' : settings.narratorModel;
    const settingsSnapshot = {
      provider,
      model,
      voice: settings.narratorVoice,
      rate: settings.narratorRate,
      outputFormat: 'wav',
      timingRequested: true
    };
    const pronunciationHash = createHash('sha256').update(JSON.stringify(pronunciation)).digest('hex');
    const inputHash = createHash('sha256').update(JSON.stringify({
      projectId: options.projectId,
      text: options.text,
      spokenText,
      settings: settingsSnapshot,
      pronunciationHash
    })).digest('hex');
    const extensionMatch = options.outputPath.match(/(\.[^.]+)$/);
    const extension = extensionMatch?.[1] ?? '.wav';
    const outputPath = options.outputPath.replace(/(\.[^.]+)?$/, `-${inputHash.slice(0, 16)}${extension}`);
    const cached = this.db.raw.prepare(`
      SELECT * FROM voice_assets
      WHERE project_id = ? AND input_hash = ? AND status = 'ready'
    `).get(options.projectId, inputHash) as Record<string, unknown> | undefined;
    if (cached?.audio_path && existsSync(String(cached.audio_path)) && cached.timing_path && existsSync(String(cached.timing_path))) {
      const wordTimings = JSON.parse(readFileSync(String(cached.timing_path), 'utf8')) as NarrationWord[];
      return {
        audioPath: String(cached.audio_path),
        durationMs: Number(cached.duration_ms),
        wordTimings,
        timingMethod: cached.timing_method as NarrationWord['timingMethod'],
        provider: String(cached.provider),
        model: String(cached.model),
        requestId: null,
        cached: true,
        inputHash,
        timingPath: String(cached.timing_path)
      };
    }

    mkdirSync(dirname(outputPath), { recursive: true });
    const timingPath = outputPath.replace(/\.[^.]+$/, '.timing.json');
    const partialPath = `${outputPath}.partial`;
    const voiceAssetId = cached?.id ? String(cached.id) : randomUUID();
    const now = new Date().toISOString();
    this.db.raw.prepare(`
      INSERT INTO voice_assets(
        id, project_id, provider, model, voice_id, settings_json,
        pronunciation_hash, input_hash, text, audio_path, timing_path,
        status, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'generating', ?, ?)
      ON CONFLICT(project_id, input_hash) DO UPDATE SET
        status = 'generating', error = NULL, audio_path = excluded.audio_path,
        timing_path = excluded.timing_path, updated_at = excluded.updated_at
    `).run(
      voiceAssetId,
      options.projectId,
      provider,
      model,
      settings.narratorVoice,
      JSON.stringify(settingsSnapshot),
      pronunciationHash,
      inputHash,
      options.text,
      outputPath,
      timingPath,
      now,
      now
    );

    let result: { durationMs: number; wordTimings: NarrationWord[] | null; requestId: string | null };
    try {
      if (provider === 'http_tts') {
        result = await this.synthesizeHttp(options.projectId, options.text, spokenText, pronunciation, partialPath, inputHash);
      } else if (process.platform === 'win32') {
        result = await this.synthesizeSapi(options.text, spokenText, partialPath);
      } else {
        result = await this.synthesizeDevelopmentTone(spokenText, partialPath);
      }
      const durationMs = await this.probeDuration(partialPath);
      if (durationMs < 500) throw new Error('Narration audio is unexpectedly short.');
      renameSync(partialPath, outputPath);
      const provided = result.wordTimings?.every((word, index, values) =>
        Number.isFinite(word.startMs)
        && Number.isFinite(word.endMs)
        && word.startMs >= 0
        && word.endMs > word.startMs
        && word.endMs <= durationMs + 250
        && (index === 0 || word.startMs >= values[index - 1]!.endMs)
      ) && result.wordTimings.length === narrationTokens(options.text).length
        ? result.wordTimings
        : parseWordTimings(options.text, spokenText, result.wordTimings, durationMs);
      if (!provided && (provider === 'http_tts' || process.platform === 'win32')) {
        throw new Error(`${provider} did not return valid word-level timing for the final narration transcript.`);
      }
      const wordTimings = provided ?? durationWeightedWordTimings(options.text, durationMs);
      const timingMethod: NarrationWord['timingMethod'] = provided ? 'provider_word' : 'duration_weighted_fallback';
      writeFileSync(timingPath, JSON.stringify(wordTimings, null, 2), 'utf8');
      this.db.raw.prepare(`
        UPDATE voice_assets SET duration_ms = ?, timing_method = ?, status = 'ready',
          error = NULL, updated_at = ? WHERE project_id = ? AND input_hash = ?
      `).run(durationMs, timingMethod, new Date().toISOString(), options.projectId, inputHash);
      return {
        audioPath: outputPath,
        durationMs,
        wordTimings,
        timingMethod,
        provider,
        model,
        requestId: result.requestId,
        cached: false,
        inputHash,
        timingPath
      };
    } catch (error) {
      if (existsSync(partialPath)) rmSync(partialPath, { force: true });
      this.db.raw.prepare(`
        UPDATE voice_assets SET status = 'failed', error = ?, updated_at = ?
        WHERE project_id = ? AND input_hash = ?
      `).run(error instanceof Error ? error.message : String(error), new Date().toISOString(), options.projectId, inputHash);
      throw error;
    }
  }

  private async synthesizeSapi(transcriptText: string, spokenText: string, outputPath: string): Promise<{ durationMs: number; wordTimings: NarrationWord[] | null; requestId: null }> {
    const settings = this.settings();
    const textPath = outputPath.replace(/\.[^.]+$/, '.txt');
    writeFileSync(textPath, spokenText, 'utf8');
    const powershell = process.env.SystemRoot
      ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe';
    const nativeTimingPath = `${outputPath}.native-timing.json`;
    await requireSuccess(powershell, [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', resourcePath('sapi-tts.ps1'),
      '-TextPath', textPath,
      '-OutputPath', outputPath,
      '-TimingPath', nativeTimingPath,
      '-VoiceName', settings.narratorVoice,
      '-Rate', String(settings.narratorRate),
      '-Volume', '100'
    ]);
    let wordTimings: NarrationWord[] | null = null;
    if (existsSync(nativeTimingPath)) {
      const decoded = JSON.parse(readFileSync(nativeTimingPath, 'utf8')) as Record<string, unknown> | Array<Record<string, unknown>>;
      const values = Array.isArray(decoded) ? decoded : [decoded];
      const durationMs = await this.probeDuration(outputPath);
      const transcriptTokens = narrationTokens(transcriptText);
      wordTimings = values.map((value, index) => ({
        word: transcriptTokens[index] ?? String(value.word ?? ''),
        startMs: Number(value.startMs),
        endMs: Number(value.endMs ?? values[index + 1]?.startMs ?? durationMs),
        confidence: 0.9,
        timingMethod: 'provider_word' as const
      }));
      rmSync(nativeTimingPath, { force: true });
    }
    return { durationMs: 0, wordTimings, requestId: null };
  }

  private async synthesizeDevelopmentTone(text: string, outputPath: string): Promise<{ durationMs: number; wordTimings: null; requestId: null }> {
    const ffmpeg = resolveFfmpeg(this.settings().ffmpegPath);
    if (!ffmpeg) throw new Error('Windows SAPI is unavailable and FFmpeg was not found for development audio.');
    const words = Math.max(1, text.trim().split(/\s+/).length);
    const durationSeconds = Math.min(45, Math.max(1.8, words / 2.7));
    await requireSuccess(ffmpeg, [
      '-y', '-hide_banner',
      '-f', 'lavfi',
      '-i', 'sine=frequency=220:sample_rate=48000',
      '-af', 'volume=0.08',
      '-t', String(durationSeconds),
      '-ac', '2', '-c:a', 'pcm_s16le',
      '-f', 'wav',
      outputPath
    ]);
    return { durationMs: Math.round(durationSeconds * 1000), wordTimings: null, requestId: null };
  }

  private async synthesizeHttp(
    projectId: string,
    text: string,
    spokenText: string,
    pronunciation: Record<string, string>,
    outputPath: string,
    inputHash: string
  ): Promise<{ durationMs: number; wordTimings: NarrationWord[] | null; requestId: string | null }> {
    const settings = this.settings();
    const secret = this.secrets.getAll().httpTtsApiKey;
    this.policy?.assertCanCall({
      projectId,
      provider: 'http_tts',
      configured: Boolean(secret),
      estimatedCostUsd: 0.05
    });
    if (!secret) throw new Error('HTTP TTS is configured but its encrypted API key is missing; no request was sent.');
    const started = Date.now();
    let requestId: string | null = null;
    let error: unknown;
    try {
      const response = await fetch(settings.narratorBaseUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${secret}`,
          'idempotency-key': inputHash
        },
        body: JSON.stringify({
          model: settings.narratorModel,
          voiceId: settings.narratorVoice,
          text,
          spokenText,
          speed: settings.narratorRate,
          pronunciationDictionary: pronunciation,
          outputFormat: 'wav',
          requestTimings: true,
          idempotencyKey: inputHash
        })
      });
      requestId = response.headers.get('x-request-id');
      if (!response.ok) {
        const message = `HTTP TTS provider returned ${response.status}: ${await response.text()}`;
        this.policy?.classifyHttpFailure('http_tts', response.status, message);
        throw new Error(message);
      }
      const contentType = response.headers.get('content-type') ?? '';
      let data: Buffer;
      let body: HttpTtsResponse = {};
      if (contentType.includes('application/json')) {
        body = await response.json() as HttpTtsResponse;
        const encoded = body.audioBase64 ?? body.audio ?? body.audioContent;
        if (!encoded) throw new Error('HTTP TTS response did not include audio bytes.');
        data = Buffer.from(encoded.replace(/^data:[^;]+;base64,/, ''), 'base64');
      } else {
        data = Buffer.from(await response.arrayBuffer());
      }
      if (data.length < 128) throw new Error('HTTP TTS returned an empty or implausibly small audio file.');
      writeFileSync(outputPath, data);
      const preliminaryTimings = parseWordTimings(
        text,
        spokenText,
        body.wordTimings,
        Number.isFinite(Number(body.durationMs)) && Number(body.durationMs) > 0
          ? Number(body.durationMs)
          : Number.MAX_SAFE_INTEGER
      );
      if (!preliminaryTimings) {
        throw new Error('HTTP TTS response did not include valid word-level timing for the final transcript.');
      }
      this.policy?.recordHealth('http_tts', 'healthy', 200, null);
      this.recordProviderCall(projectId, inputHash, requestId, Date.now() - started, body, null);
      return {
        durationMs: Number(body.durationMs ?? 0),
        wordTimings: preliminaryTimings,
        requestId: requestId ?? body.requestId ?? null
      };
    } catch (caught) {
      error = caught;
      this.recordProviderCall(projectId, inputHash, requestId, Date.now() - started, null, error);
      throw caught;
    }
  }

  private recordProviderCall(
    projectId: string,
    inputHash: string,
    requestId: string | null,
    latencyMs: number,
    response: unknown,
    error: unknown
  ): void {
    this.db.raw.prepare(`
      INSERT INTO provider_calls(
        id, project_id, provider, model, operation, input_hash, output_hash,
        request_id, estimated_cost_usd, latency_ms, retry_count, response_json,
        error, created_at
      ) VALUES(?, ?, 'http_tts', ?, 'synthesize_section', ?, ?, ?, 0.05, ?, 0, ?, ?, ?)
      ON CONFLICT(provider, model, operation, input_hash) DO UPDATE SET
        output_hash = excluded.output_hash, request_id = excluded.request_id,
        estimated_cost_usd = provider_calls.estimated_cost_usd + excluded.estimated_cost_usd,
        latency_ms = excluded.latency_ms, response_json = excluded.response_json,
        error = excluded.error, created_at = excluded.created_at
    `).run(
      randomUUID(),
      projectId,
      this.settings().narratorModel,
      inputHash,
      response ? createHash('sha256').update(JSON.stringify(response)).digest('hex') : null,
      requestId,
      latencyMs,
      response ? JSON.stringify(response) : null,
      error ? (error instanceof Error ? error.message : String(error)) : null,
      new Date().toISOString()
    );
  }

  async probeDuration(path: string): Promise<number> {
    const ffprobe = resolveFfprobe(this.settings().ffprobePath);
    if (!ffprobe) throw new Error('FFprobe is unavailable.');
    const result = await requireSuccess(ffprobe, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      path
    ]);
    return Math.round(Number(result.stdout.trim()) * 1000);
  }
}
