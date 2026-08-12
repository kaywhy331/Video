import { createHash } from 'node:crypto';
import type { AppDatabase } from '../database/database';
import type { SecretStore } from '../secret-store';
import type { AppSettings, CatalogAsset, CoverageCluster } from '@shared/types';
import { StructuredScriptSchema, type StructuredScript } from '@shared/contracts';
import { ExtractedClaimPackSchema, type ExtractedClaim } from '@shared/research';
import type { ProviderPolicyService } from './provider-policy';

interface GenerateScriptInput {
  projectId: string;
  topicTitle: string;
  destination: string;
  targetMinutes: number;
  coverage: CoverageCluster;
  assets: CatalogAsset[];
  acceptedClaims?: Array<{ id: string; text: string; category: string; sourceIds: string[] }>;
}

interface ExtractClaimsInput {
  projectId: string;
  topicTitle: string;
  destination: string;
  sources: Array<{ id: string; url: string; title: string; publisher: string | null; publishedAt: string | null; excerpt: string; content: string }>;
}

function stripCodeFence(value: string): string {
  return value
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

function shortDescription(asset: CatalogAsset): string {
  return [
    asset.title,
    asset.locationName,
    asset.activity,
    asset.shotType,
    asset.sceneDescription,
    asset.objects,
    asset.timeOfDay,
    asset.style
  ].filter(Boolean).join(' | ');
}

export class AiService {
  constructor(
    private readonly db: AppDatabase,
    private readonly secretStore: SecretStore,
    private readonly settings: () => AppSettings,
    private readonly policy?: ProviderPolicyService
  ) {}

  configured(): boolean {
    const settings = this.settings();
    return settings.llmProvider === 'mock'
      || (settings.llmProvider === 'openai_compatible' && Boolean(this.secretStore.getAll().llmApiKey));
  }

  async extractClaims(input: ExtractClaimsInput): Promise<ExtractedClaim[]> {
    const settings = this.settings();
    const secret = this.secretStore.getAll().llmApiKey;
    if (settings.llmProvider !== 'openai_compatible' || !secret) return [];
    const allowedSourceIds = new Set(input.sources.map(source => source.id));
    const system = [
      'Extract atomic travel facts only from the supplied sources.',
      'Return JSON only. Cite only an exact source ID supplied by the application.',
      'Do not reconcile disagreement: emit each supported wording under the same normalizedKey so application policy can mark conflict.',
      'Set time-sensitive for prices, hours, schedules, closures, and events. validAsOf is an ISO date or null.'
    ].join(' ');
    const prompt = {
      task: 'Build a bounded factual claim pack.', topic: input.topicTitle, destination: input.destination,
      sources: input.sources.map(source => ({ ...source, content: source.content.slice(0, 20_000) })),
      requiredSchema: { claims: [{ text: 'string', normalizedKey: 'stable semantic key', category: 'historical|geographic|price|hours|transport|closure|event|other', confidence: '0..1', stability: 'stable|time_sensitive', validAsOf: 'YYYY-MM-DD|null', sourceIds: ['supplied source ID'], material: 'boolean' }] }
    };
    const inputHash = createHash('sha256').update(JSON.stringify({ system, prompt, model: settings.llmModel })).digest('hex');
    const cached = this.db.raw.prepare(`SELECT response_json FROM provider_calls WHERE provider = 'openai_compatible' AND model = ? AND operation = 'fact_extraction' AND input_hash = ? AND error IS NULL`).get(settings.llmModel, inputHash) as { response_json: string } | undefined;
    if (cached?.response_json) {
      const pack = ExtractedClaimPackSchema.parse(JSON.parse(cached.response_json));
      if (pack.claims.some(claim => claim.sourceIds.some(sourceId => !allowedSourceIds.has(sourceId)))) throw new Error('Cached claim pack contains an unknown source ID.');
      return pack.claims;
    }
    this.policy?.assertCanCall({ projectId: input.projectId, provider: 'openai_compatible', configured: true, estimatedCostUsd: 0.1 });
    const endpoint = `${settings.llmBaseUrl.replace(/\/$/, '')}/chat/completions`;
    const started = Date.now();
    let responseText = '';
    let requestId: string | null = null;
    let lastError: unknown;
    let attemptsSent = 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        attemptsSent += 1;
        const response = await fetch(endpoint, {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
          body: JSON.stringify({ model: settings.llmModel, temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify({ ...prompt, correction: attempt ? 'Prior output was invalid. Return exactly the required schema and supplied source IDs.' : undefined }) }] })
        });
        requestId = response.headers.get('x-request-id');
        if (!response.ok) {
          const message = `LLM provider returned ${response.status}: ${await response.text()}`;
          this.policy?.classifyHttpFailure('openai_compatible', response.status, message);
          throw new Error(message);
        }
        const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
        responseText = body.choices?.[0]?.message?.content ?? '';
        const pack = ExtractedClaimPackSchema.parse(JSON.parse(stripCodeFence(responseText)));
        const unknown = pack.claims.flatMap(claim => claim.sourceIds).filter(sourceId => !allowedSourceIds.has(sourceId));
        if (unknown.length) throw new Error(`Claim pack contains unknown source IDs: ${[...new Set(unknown)].join(', ')}`);
        this.policy?.recordHealth('openai_compatible', 'healthy', 200, null);
        this.recordProviderResult(input.projectId, settings.llmModel, 'fact_extraction', inputHash, requestId, Date.now() - started, attempt, pack, null, 0.05 * attemptsSent);
        return pack.claims;
      } catch (error) {
        lastError = error;
        if (attempt === 0 && this.correctableProviderOutput(error)) continue;
        break;
      }
    }
    this.recordProviderResult(input.projectId, settings.llmModel, 'fact_extraction', inputHash, requestId, Date.now() - started, Math.max(0, attemptsSent - 1), responseText ? { raw: responseText } : null, lastError, 0.05 * attemptsSent);
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async generateScript(input: GenerateScriptInput): Promise<StructuredScript> {
    const settings = this.settings();
    const secrets = this.secretStore.getAll();
    if (settings.llmProvider !== 'openai_compatible') {
      return this.generateLocalVisualScript(input);
    }
    if (!secrets.llmApiKey) {
      throw new Error('The configured language provider API key is missing; local fallback was not used.');
    }

    const eligible = input.assets.slice(0, 180).map(asset => ({
      id: asset.id,
      title: asset.title,
      country: asset.country,
      city: asset.city,
      location: asset.locationName,
      activity: asset.activity,
      shot: asset.shotType,
      scene: asset.sceneDescription,
      objects: asset.objects,
      time: asset.timeOfDay,
      style: asset.style,
      durationMs: asset.declaredDurationMs
    }));

    const system = [
      'You are the planning engine for an exact-location stock-footage YouTube production system.',
      'Return JSON only. Never invent footage, locations, facts, sources, prices, dates, or claims not supported by the supplied catalog.',
      'Each scene is one short narration unit designed for 2 to 7 seconds of voiceover.',
      'Every place-specific scene must require the exact supplied country/city/location.',
      'Use descriptive, visually observable narration rather than unsupported historical claims.',
      'Vary shot requirements and avoid repetitive wording.',
      'For factual narration, copy only accepted claim text and include its claim ID in claimIds. Never invent a claim or source ID.',
      'The total script should fit the target duration, but prioritize truth and footage coverage.'
    ].join(' ');

    const prompt = {
      task: 'Generate a visually grounded provisional script.',
      target: {
        title: input.topicTitle,
        destination: input.destination,
        targetMinutes: input.targetMinutes,
        desiredSceneCount: Math.max(18, Math.min(90, Math.round(input.targetMinutes * 9)))
      },
      coverage: input.coverage,
      availableAssets: eligible,
      acceptedClaims: (input.acceptedClaims ?? []).slice(0, 40),
      requiredSchema: {
        title: 'string',
        topic: 'string',
        destination: 'string',
        summary: 'string',
        scenes: [{
          chapter: 'string|null',
          narration: 'short string',
          targetDurationMs: 'integer 1500..7000',
          requiredCountry: 'string|null',
          requiredCity: 'string|null',
          requiredLocation: 'string|null',
          requiredGranularity: 'country|region|city|neighborhood|landmark|feature|unknown',
          requiredObjects: ['string'],
          requiredActivities: ['string'],
          preferredShots: ['string'],
          visualTreatment: 'EXACT_LOCATION_FOOTAGE|CONTEXTUAL_VERIFIED_FOOTAGE|MAP_OR_GRAPHIC|TEXT_OR_ARCHIVAL',
          claimIds: ['accepted application claim ID']
        }]
      }
    };

    const inputHash = createHash('sha256')
      .update(JSON.stringify({ system, prompt, model: settings.llmModel }))
      .digest('hex');

    const acceptedClaimIds = new Set((input.acceptedClaims ?? []).map(claim => claim.id));
    const acceptedClaimText = new Map((input.acceptedClaims ?? []).map(claim => [claim.id, claim.text]));
    const validateScriptClaims = (script: StructuredScript): StructuredScript => {
      const unknown = script.scenes.flatMap(scene => scene.claimIds).filter(claimId => !acceptedClaimIds.has(claimId));
      if (unknown.length) throw new Error(`Script contains unknown or unaccepted claim IDs: ${[...new Set(unknown)].join(', ')}`);
      for (const scene of script.scenes) {
        for (const claimId of scene.claimIds) {
          const supported = acceptedClaimText.get(claimId);
          if (supported && !scene.narration.toLowerCase().includes(supported.toLowerCase())) {
            throw new Error(`Script wording exceeds or changes accepted claim ${claimId}.`);
          }
        }
      }
      return script;
    };
    const cached = this.db.raw.prepare(`
      SELECT response_json FROM provider_calls
      WHERE provider = 'openai_compatible'
        AND model = ?
        AND operation = 'generate_script'
        AND input_hash = ?
        AND error IS NULL
    `).get(settings.llmModel, inputHash) as { response_json: string } | undefined;
    if (cached?.response_json) {
      return validateScriptClaims(StructuredScriptSchema.parse(JSON.parse(cached.response_json)));
    }

    const started = Date.now();
    const endpoint = `${settings.llmBaseUrl.replace(/\/$/, '')}/chat/completions`;
    let responseText = '';
    let requestId: string | null = null;
    let lastError: unknown;
    let attemptsSent = 0;
    if (this.policy) {
      this.policy.assertCanCall({ projectId: input.projectId, provider: 'openai_compatible', configured: true, estimatedCostUsd: 0.1 });
    } else {
        const monthStart = new Date();
        monthStart.setUTCDate(1);
        monthStart.setUTCHours(0, 0, 0, 0);
        const spend = this.db.raw.prepare(`SELECT coalesce(sum(estimated_cost_usd), 0) AS total FROM provider_calls WHERE created_at >= ?`).get(monthStart.toISOString()) as { total: number };
        if (Number(spend.total) >= settings.monthlyBudgetUsd) throw new Error('Monthly provider budget is exhausted; no LLM request was sent.');
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        attemptsSent += 1;
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${secrets.llmApiKey}` },
          body: JSON.stringify({
            model: settings.llmModel,
            temperature: 0.35,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: JSON.stringify({ ...prompt, correction: attempt ? 'The prior response was invalid. Return exactly the required schema, app-issued claim IDs, and verbatim accepted claim text.' : undefined }) }
            ]
          })
        });
        requestId = response.headers.get('x-request-id');
        if (!response.ok) {
          const message = `LLM provider returned ${response.status}: ${await response.text()}`;
          this.policy?.classifyHttpFailure('openai_compatible', response.status, message);
          throw new Error(message);
        }
        const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
        responseText = body.choices?.[0]?.message?.content ?? '';
        const parsed = validateScriptClaims(StructuredScriptSchema.parse(JSON.parse(stripCodeFence(responseText))));
        this.policy?.recordHealth('openai_compatible', 'healthy', 200, null);
        this.recordProviderResult(input.projectId, settings.llmModel, 'generate_script', inputHash, requestId, Date.now() - started, attempt, parsed, null, 0.05 * attemptsSent);
        return parsed;
      } catch (error) {
        lastError = error;
        if (attempt === 0 && this.correctableProviderOutput(error)) continue;
        break;
      }
    }
    this.recordProviderResult(input.projectId, settings.llmModel, 'generate_script', inputHash, requestId, Date.now() - started, Math.max(0, attemptsSent - 1), responseText ? { raw: responseText } : null, lastError, 0.05 * attemptsSent);
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private generateLocalVisualScript(input: GenerateScriptInput): StructuredScript {
    const targetScenes = Math.max(12, Math.min(48, Math.round(input.targetMinutes * 7)));
    const assets = input.assets.slice(0, targetScenes);
    const destination = input.destination;
    const scenes = assets.map((asset, index) => {
      const subject = asset.locationName
        ?? asset.activity
        ?? asset.objects
        ?? asset.sceneDescription
        ?? destination;
      const shot = asset.shotType ? ` through a ${asset.shotType.toLowerCase()} view` : '';
      const time = asset.timeOfDay ? ` in ${asset.timeOfDay.toLowerCase()} light` : '';
      const narrationTemplates = [
        `${destination} opens with ${subject}${shot}${time}.`,
        `Here, the scene focuses on ${subject}${shot}.`,
        `The view shifts to ${subject}${time}.`,
        `${subject} adds another layer to the landscape of ${destination}.`,
        `From this angle, ${subject} becomes the center of the scene.`
      ];
      const narration = narrationTemplates[index % narrationTemplates.length] ?? `${destination}.`;
      return {
        chapter: index < Math.ceil(targetScenes * 0.15)
          ? 'Opening'
          : index > Math.floor(targetScenes * 0.82)
            ? 'Final impressions'
            : 'Visual journey',
        narration,
        targetDurationMs: 4500,
        requiredCountry: asset.country,
        requiredCity: asset.city,
        requiredLocation: asset.locationName,
        requiredGranularity: asset.locationGranularity,
        requiredObjects: asset.objects ? asset.objects.split(/[,;|]/).map(value => value.trim()).filter(Boolean).slice(0, 4) : [],
        requiredActivities: asset.activity ? [asset.activity] : [],
        preferredShots: asset.shotType ? [asset.shotType] : [],
        visualTreatment: asset.locationName
          ? 'EXACT_LOCATION_FOOTAGE' as const
          : 'CONTEXTUAL_VERIFIED_FOOTAGE' as const,
        claimIds: []
      };
    });

    return StructuredScriptSchema.parse({
      title: input.topicTitle,
      topic: input.topicTitle,
      destination,
      summary: `A metadata-grounded visual journey through ${destination}. This local fallback avoids unsupported factual claims.`,
      scenes
    });
  }

  private recordProviderResult(projectId: string, model: string, operation: string, inputHash: string, requestId: string | null, latencyMs: number, retryCount: number, data: unknown, error: unknown, cost: number): void {
    this.db.raw.prepare(`INSERT OR REPLACE INTO provider_calls(id, project_id, provider, model, operation, input_hash, output_hash, request_id, estimated_cost_usd, latency_ms, retry_count, response_json, error, created_at) VALUES(lower(hex(randomblob(16))), ?, 'openai_compatible', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(projectId, model, operation, inputHash, data === null ? null : createHash('sha256').update(JSON.stringify(data)).digest('hex'), requestId, cost, latencyMs, retryCount, data === null ? null : JSON.stringify(data), error ? (error instanceof Error ? error.message : String(error)) : null, new Date().toISOString());
  }

  private correctableProviderOutput(error: unknown): boolean {
    if (error instanceof SyntaxError) return true;
    if (!(error instanceof Error)) return false;
    return error.name === 'ZodError'
      || error.message.includes('unknown source IDs')
      || error.message.includes('unknown or unaccepted claim IDs')
      || error.message.includes('wording exceeds or changes accepted claim');
  }
}
