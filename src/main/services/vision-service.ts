import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import type { AppDatabase } from '../database/database';
import type { SecretStore } from '../secret-store';
import type { AppSettings } from '@shared/types';
import {
  VisionFootageAssessmentSchema
} from '@shared/contracts';
import type { VisionFootageAssessment } from '@shared/footage-verification';

export interface VisionSceneContract {
  projectId: string;
  sceneId: string;
  assetId: string;
  assetFileId: string;
  assetSha256: string;
  contactSheetPath: string;
  narration: string;
  requiredCountry: string | null;
  requiredCity: string | null;
  requiredLocation: string | null;
  requiredGranularity: string;
  requiredObjects: string[];
  requiredActivities: string[];
  preferredShots: string[];
  visualTreatment: string;
}

export interface VisionAssessmentResult {
  provider: string;
  model: string;
  inputHash: string;
  assessment: VisionFootageAssessment;
  cached: boolean;
}

function stripCodeFence(value: string): string {
  return value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

function imageMime(path: string): string {
  return extname(path).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
}

export class VisionService {
  constructor(
    private readonly db: AppDatabase,
    private readonly secrets: SecretStore,
    private readonly settings: () => AppSettings
  ) {}

  configured(): boolean {
    const settings = this.settings();
    return settings.visionProvider === 'openai_compatible'
      && Boolean(this.secrets.getAll().visionApiKey);
  }

  async assess(input: VisionSceneContract): Promise<VisionAssessmentResult> {
    const settings = this.settings();
    const secret = this.secrets.getAll().visionApiKey;
    if (settings.visionProvider !== 'openai_compatible' || !secret) {
      throw new Error('Semantic vision provider is not configured.');
    }
    const prompt = this.prompt(input);
    const inputHash = createHash('sha256').update(JSON.stringify({
      provider: settings.visionProvider,
      model: settings.visionModel,
      assetSha256: input.assetSha256,
      prompt
    })).digest('hex');
    const cached = this.db.raw.prepare(`
      SELECT response_json FROM provider_calls
      WHERE provider = 'openai_compatible_vision' AND model = ?
        AND operation = 'verify_footage' AND input_hash = ? AND error IS NULL
    `).get(settings.visionModel, inputHash) as { response_json: string } | undefined;
    if (cached?.response_json) {
      return {
        provider: settings.visionProvider,
        model: settings.visionModel,
        inputHash,
        assessment: VisionFootageAssessmentSchema.parse(JSON.parse(cached.response_json)),
        cached: true
      };
    }
    this.assertMonthlyBudget(settings.monthlyBudgetUsd);
    const imageUrl = `data:${imageMime(input.contactSheetPath)};base64,${readFileSync(input.contactSheetPath).toString('base64')}`;
    const endpoint = `${settings.visionBaseUrl.replace(/\/$/, '')}/chat/completions`;
    const system = [
      'You verify stock-video contact sheets against a strict scene contract.',
      'Return JSON only. Treat uncertain evidence as unknown. Never infer an exact location from visual similarity alone.',
      'Evaluate every required object and activity separately using the exact requirement string.',
      'A geography mismatch means the frames positively show an incompatible place; unknown means they do not prove either result.'
    ].join(' ');
    const started = Date.now();
    let responseText = '';
    let requestId: string | null = null;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
          body: JSON.stringify({
            model: settings.visionModel,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: system },
              {
                role: 'user',
                content: [
                  { type: 'text', text: JSON.stringify({
                    ...prompt,
                    correction: attempt
                      ? 'The prior response was invalid. Return one object matching requiredSchema exactly.'
                      : undefined
                  }) },
                  { type: 'image_url', image_url: { url: imageUrl, detail: 'high' } }
                ]
              }
            ]
          })
        });
        requestId = response.headers.get('x-request-id');
        if (!response.ok) throw new Error(`Vision provider returned ${response.status}: ${await response.text()}`);
        const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
        responseText = body.choices?.[0]?.message?.content ?? '';
        const assessment = VisionFootageAssessmentSchema.parse(JSON.parse(stripCodeFence(responseText)));
        this.recordSuccess(input, settings.visionModel, inputHash, requestId, Date.now() - started, attempt, assessment);
        return {
          provider: settings.visionProvider,
          model: settings.visionModel,
          inputHash,
          assessment,
          cached: false
        };
      } catch (error) {
        lastError = error;
        if (attempt === 0 && this.correctable(error)) continue;
        break;
      }
    }
    this.recordError(
      input,
      settings.visionModel,
      inputHash,
      requestId,
      Date.now() - started,
      responseText,
      lastError
    );
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private prompt(input: VisionSceneContract): Record<string, unknown> {
    return {
      task: 'Assess whether this contact sheet visually supports the scene contract.',
      sceneContract: {
        narration: input.narration,
        geography: {
          country: input.requiredCountry,
          city: input.requiredCity,
          location: input.requiredLocation,
          granularity: input.requiredGranularity
        },
        requiredObjects: input.requiredObjects,
        requiredActivities: input.requiredActivities,
        preferredShots: input.preferredShots,
        visualTreatment: input.visualTreatment
      },
      requiredSchema: {
        geography: {
          verdict: 'match|mismatch|unknown',
          confidence: 'number 0..1',
          country: 'string|null',
          city: 'string|null',
          location: 'string|null',
          granularity: 'country|region|city|neighborhood|landmark|feature|unknown',
          evidence: ['visible evidence only']
        },
        objects: [{ requirement: 'exact supplied requirement', present: 'boolean|null', confidence: 'number 0..1', evidence: 'string' }],
        activities: [{ requirement: 'exact supplied requirement', present: 'boolean|null', confidence: 'number 0..1', evidence: 'string' }],
        disallowedContent: ['string'],
        technicalConcerns: ['string'],
        summary: 'string'
      }
    };
  }

  private assertMonthlyBudget(maximum: number): void {
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const row = this.db.raw.prepare(`
      SELECT coalesce(sum(estimated_cost_usd), 0) AS total
      FROM provider_calls WHERE created_at >= ?
    `).get(monthStart.toISOString()) as { total: number };
    if (Number(row.total) >= maximum) throw new Error('Monthly provider budget is exhausted; no vision request was sent.');
  }

  private correctable(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    return error.name === 'ZodError' || error instanceof SyntaxError;
  }

  private recordSuccess(
    input: VisionSceneContract,
    model: string,
    inputHash: string,
    requestId: string | null,
    latencyMs: number,
    retryCount: number,
    assessment: VisionFootageAssessment
  ): void {
    this.db.raw.prepare(`
      INSERT OR REPLACE INTO provider_calls(
        id, project_id, provider, model, operation, input_hash, output_hash,
        request_id, estimated_cost_usd, latency_ms, retry_count, response_json, created_at
      ) VALUES(?, ?, 'openai_compatible_vision', ?, 'verify_footage', ?, ?, ?, 0, ?, ?, ?, ?)
    `).run(
      randomUUID(), input.projectId, model, inputHash,
      createHash('sha256').update(JSON.stringify(assessment)).digest('hex'),
      requestId, latencyMs, retryCount, JSON.stringify(assessment), new Date().toISOString()
    );
  }

  private recordError(
    input: VisionSceneContract,
    model: string,
    inputHash: string,
    requestId: string | null,
    latencyMs: number,
    responseText: string,
    error: unknown
  ): void {
    this.db.raw.prepare(`
      INSERT OR REPLACE INTO provider_calls(
        id, project_id, provider, model, operation, input_hash, request_id,
        estimated_cost_usd, latency_ms, retry_count, response_json, error, created_at
      ) VALUES(?, ?, 'openai_compatible_vision', ?, 'verify_footage', ?, ?, 0, ?, 1, ?, ?, ?)
    `).run(
      randomUUID(), input.projectId, model, inputHash, requestId, latencyMs,
      responseText ? JSON.stringify({ raw: responseText }) : null,
      error instanceof Error ? error.message : String(error), new Date().toISOString()
    );
  }
}
