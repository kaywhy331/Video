import { createHash, randomUUID } from 'node:crypto';
import type { AppDatabase } from '../database/database';
import type { SecretStore } from '../secret-store';
import type { AppSettings } from '@shared/types';
import {
  RESEARCH_QUERY_LIMIT,
  RESEARCH_RESULTS_PER_QUERY_LIMIT,
  RESEARCH_SOURCE_LIMIT,
  ResearchExtractResponseSchema,
  ResearchSearchResponseSchema,
  type ResearchExtractResult,
  type ResearchSearchResult
} from '@shared/research';
import { ProviderPolicyService } from './provider-policy';

export interface ResearchSearchRequest {
  projectId: string;
  queries: string[];
  languageCode: string;
  countryCode?: string;
  freshnessDays?: number;
  maxResultsPerQuery?: number;
}

export interface ResearchProviderResult<T> {
  data: T;
  provider: 'tavily';
  requestId: string | null;
  latencyMs: number;
  cached: boolean;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function realHttpUrl(value: string): string {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
    throw new Error(`Research provider returned an invalid source URL: ${value}`);
  }
  return parsed.toString();
}

export class ResearchService {
  readonly policy: ProviderPolicyService;

  constructor(
    private readonly db: AppDatabase,
    private readonly secrets: SecretStore,
    private readonly settings: () => AppSettings
  ) {
    this.policy = new ProviderPolicyService(db, settings);
  }

  configured(): boolean {
    return this.settings().researchProvider === 'tavily' && Boolean(this.secrets.getAll().researchApiKey);
  }

  async search(request: ResearchSearchRequest): Promise<ResearchProviderResult<ResearchSearchResult[]>> {
    const settings = this.settings();
    const apiKey = this.secrets.getAll().researchApiKey;
    const queries = [...new Set(request.queries.map(query => query.trim()).filter(Boolean))].slice(0, RESEARCH_QUERY_LIMIT);
    if (!queries.length) throw new Error('At least one bounded research query is required.');
    const maxResults = Math.min(
      RESEARCH_RESULTS_PER_QUERY_LIMIT,
      Math.max(1, request.maxResultsPerQuery ?? settings.researchMaxResultsPerQuery)
    );
    const input = {
      queries,
      languageCode: request.languageCode,
      countryCode: request.countryCode ?? null,
      freshnessDays: request.freshnessDays ?? null,
      maxResults,
      depth: settings.researchSearchDepth
    };
    const inputHash = hash(input);
    const cached = this.cached<ResearchSearchResult[]>(settings, 'research_search', inputHash);
    if (cached) return { ...cached, provider: 'tavily', cached: true };
    this.policy.assertCanCall({ projectId: request.projectId, provider: 'tavily', configured: this.configured(), estimatedCostUsd: 0.01 * queries.length });

    const started = Date.now();
    const results: ResearchSearchResult[] = [];
    let requestId: string | null = null;
    try {
      for (const query of queries) {
        const response = await fetch(`${settings.researchBaseUrl.replace(/\/$/, '')}/search`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            query: `${query} language:${request.languageCode}`,
            search_depth: settings.researchSearchDepth,
            max_results: maxResults,
            include_answer: false,
            include_raw_content: false,
            ...(request.countryCode ? { country: request.countryCode } : {}),
            ...(request.freshnessDays ? { days: request.freshnessDays } : {})
          })
        });
        requestId = response.headers.get('x-request-id') ?? requestId;
        if (!response.ok) {
          const message = `Research provider returned ${response.status}: ${await response.text()}`;
          this.policy.classifyHttpFailure('tavily', response.status, message);
          throw new Error(message);
        }
        const raw = await response.json() as Record<string, unknown>;
        const parsed = ResearchSearchResponseSchema.parse({
          results: Array.isArray(raw.results) ? raw.results.map((item: any) => ({
            url: realHttpUrl(String(item.url ?? '')),
            title: item.title,
            content: item.content,
            score: typeof item.score === 'number' ? item.score : null,
            publishedAt: item.published_date ?? null
          })) : [],
          responseTime: typeof raw.response_time === 'number' ? raw.response_time : null,
          requestId: typeof raw.request_id === 'string' ? raw.request_id : requestId
        });
        results.push(...parsed.results);
        requestId = parsed.requestId ?? requestId;
      }
      const deduped = [...new Map(results.map(result => [result.url, result])).values()].slice(0, RESEARCH_SOURCE_LIMIT);
      this.record(request.projectId, settings, 'research_search', inputHash, requestId, Date.now() - started, deduped, null, 0.01 * queries.length);
      this.policy.recordHealth('tavily', 'healthy', 200, null);
      return { data: deduped, provider: 'tavily', requestId, latencyMs: Date.now() - started, cached: false };
    } catch (error) {
      this.record(request.projectId, settings, 'research_search', inputHash, requestId, Date.now() - started, null, error, 0.01 * queries.length);
      throw error;
    }
  }

  async extract(projectId: string, urls: string[]): Promise<ResearchProviderResult<ResearchExtractResult[]>> {
    const settings = this.settings();
    const apiKey = this.secrets.getAll().researchApiKey;
    const bounded = [...new Set(urls.map(realHttpUrl))].slice(0, RESEARCH_SOURCE_LIMIT);
    if (!bounded.length) throw new Error('At least one real research source URL is required.');
    const inputHash = hash({ urls: bounded, extractionMode: 'article' });
    const cached = this.cached<ResearchExtractResult[]>(settings, 'research_extract', inputHash);
    if (cached) return { ...cached, provider: 'tavily', cached: true };
    this.policy.assertCanCall({ projectId, provider: 'tavily', configured: this.configured(), estimatedCostUsd: 0.02 * bounded.length });
    const started = Date.now();
    let requestId: string | null = null;
    try {
      const response = await fetch(`${settings.researchBaseUrl.replace(/\/$/, '')}/extract`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ urls: bounded, extract_depth: 'basic', include_images: false, format: 'markdown' })
      });
      requestId = response.headers.get('x-request-id');
      if (!response.ok) {
        const message = `Research provider returned ${response.status}: ${await response.text()}`;
        this.policy.classifyHttpFailure('tavily', response.status, message);
        throw new Error(message);
      }
      const raw = await response.json() as Record<string, unknown>;
      const parsed = ResearchExtractResponseSchema.parse({
        results: Array.isArray(raw.results) ? raw.results.map((item: any) => ({
          url: realHttpUrl(String(item.url ?? '')),
          rawContent: item.raw_content,
          images: Array.isArray(item.images) ? item.images : []
        })) : [],
        failedResults: Array.isArray(raw.failed_results) ? raw.failed_results.map((item: any) => ({ url: realHttpUrl(String(item.url ?? '')), error: String(item.error ?? 'Unknown extraction failure') })) : [],
        responseTime: typeof raw.response_time === 'number' ? raw.response_time : null,
        requestId: typeof raw.request_id === 'string' ? raw.request_id : requestId
      });
      requestId = parsed.requestId ?? requestId;
      this.record(projectId, settings, 'research_extract', inputHash, requestId, Date.now() - started, parsed.results, null, 0.02 * bounded.length);
      this.policy.recordHealth('tavily', 'healthy', 200, null);
      return { data: parsed.results, provider: 'tavily', requestId, latencyMs: Date.now() - started, cached: false };
    } catch (error) {
      this.record(projectId, settings, 'research_extract', inputHash, requestId, Date.now() - started, null, error, 0.02 * bounded.length);
      throw error;
    }
  }

  private cached<T>(settings: AppSettings, operation: string, inputHash: string): Omit<ResearchProviderResult<T>, 'provider' | 'cached'> | null {
    const row = this.db.raw.prepare(`SELECT response_json, request_id, latency_ms FROM provider_calls WHERE provider = 'tavily' AND model = ? AND operation = ? AND input_hash = ? AND error IS NULL`).get(settings.researchSearchDepth, operation, inputHash) as { response_json: string; request_id: string | null; latency_ms: number } | undefined;
    return row ? { data: JSON.parse(row.response_json) as T, requestId: row.request_id, latencyMs: Number(row.latency_ms ?? 0) } : null;
  }

  private record(projectId: string, settings: AppSettings, operation: string, inputHash: string, requestId: string | null, latencyMs: number, data: unknown, error: unknown, cost: number): void {
    this.db.raw.prepare(`
      INSERT OR REPLACE INTO provider_calls(id, project_id, provider, model, operation, input_hash, output_hash, request_id, estimated_cost_usd, latency_ms, retry_count, response_json, error, created_at)
      VALUES(?, ?, 'tavily', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    `).run(randomUUID(), projectId, settings.researchSearchDepth, operation, inputHash, data === null ? null : hash(data), requestId, cost, latencyMs, data === null ? null : JSON.stringify(data), error ? (error instanceof Error ? error.message : String(error)) : null, new Date().toISOString());
  }
}
