import { createHash } from 'node:crypto';
import type { AppDatabase } from '../database/database';
import type { SecretStore } from '../secret-store';
import type { AppSettings, CatalogAsset, CoverageCluster } from '@shared/types';
import { StructuredScriptSchema, type StructuredScript } from '@shared/contracts';

interface GenerateScriptInput {
  projectId: string;
  topicTitle: string;
  destination: string;
  targetMinutes: number;
  coverage: CoverageCluster;
  assets: CatalogAsset[];
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
    private readonly settings: () => AppSettings
  ) {}

  async generateScript(input: GenerateScriptInput): Promise<StructuredScript> {
    const settings = this.settings();
    const secrets = this.secretStore.getAll();
    if (settings.llmProvider !== 'openai_compatible' || !secrets.llmApiKey) {
      return this.generateLocalVisualScript(input);
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
          visualTreatment: 'EXACT_LOCATION_FOOTAGE|CONTEXTUAL_VERIFIED_FOOTAGE|MAP_OR_GRAPHIC|TEXT_OR_ARCHIVAL'
        }]
      }
    };

    const inputHash = createHash('sha256')
      .update(JSON.stringify({ system, prompt, model: settings.llmModel }))
      .digest('hex');

    const cached = this.db.raw.prepare(`
      SELECT response_json FROM provider_calls
      WHERE provider = 'openai_compatible'
        AND model = ?
        AND operation = 'generate_script'
        AND input_hash = ?
        AND error IS NULL
    `).get(settings.llmModel, inputHash) as { response_json: string } | undefined;
    if (cached?.response_json) {
      return StructuredScriptSchema.parse(JSON.parse(cached.response_json));
    }

    const started = Date.now();
    const endpoint = `${settings.llmBaseUrl.replace(/\/$/, '')}/chat/completions`;
    let responseText = '';
    let requestId: string | null = null;
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${secrets.llmApiKey}`
        },
        body: JSON.stringify({
          model: settings.llmModel,
          temperature: 0.35,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: JSON.stringify(prompt) }
          ]
        })
      });
      requestId = response.headers.get('x-request-id');
      if (!response.ok) {
        throw new Error(`LLM provider returned ${response.status}: ${await response.text()}`);
      }
      const body = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      responseText = body.choices?.[0]?.message?.content ?? '';
      const parsed = StructuredScriptSchema.parse(JSON.parse(stripCodeFence(responseText)));
      this.db.raw.prepare(`
        INSERT OR REPLACE INTO provider_calls(
          id, project_id, provider, model, operation, input_hash, output_hash,
          request_id, estimated_cost_usd, latency_ms, retry_count, response_json, created_at
        ) VALUES(lower(hex(randomblob(16))), ?, 'openai_compatible', ?, 'generate_script', ?, ?,
          ?, 0, ?, 0, ?, ?)
      `).run(
        input.projectId,
        settings.llmModel,
        inputHash,
        createHash('sha256').update(JSON.stringify(parsed)).digest('hex'),
        requestId,
        Date.now() - started,
        JSON.stringify(parsed),
        new Date().toISOString()
      );
      return parsed;
    } catch (error) {
      this.db.raw.prepare(`
        INSERT OR REPLACE INTO provider_calls(
          id, project_id, provider, model, operation, input_hash, request_id,
          estimated_cost_usd, latency_ms, retry_count, response_json, error, created_at
        ) VALUES(lower(hex(randomblob(16))), ?, 'openai_compatible', ?, 'generate_script', ?,
          ?, 0, ?, 0, ?, ?, ?)
      `).run(
        input.projectId,
        settings.llmModel,
        inputHash,
        requestId,
        Date.now() - started,
        responseText ? JSON.stringify({ raw: responseText }) : null,
        error instanceof Error ? error.message : String(error),
        new Date().toISOString()
      );
      throw error;
    }
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
          : 'CONTEXTUAL_VERIFIED_FOOTAGE' as const
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
}
