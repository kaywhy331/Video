import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { z } from 'zod';
import type {
  AppSettings,
  CatalogImportOperationStatus,
  CatalogImportPreview,
  ChannelProfile,
  ExpansionRegistrySnapshot,
  GoogleSheetsSyncRun,
  KeywordMetricObservation,
  LanguageVoiceProfile,
  OpportunityAssessment,
  OutputProfile,
  ProviderCapabilityRecord,
  ProviderEndpointId,
  ProviderEndpointState,
  SecretStatus
} from '@shared/types';
import type {
  GoogleSheetsSyncSchema,
  KeywordMetricObservationSchema
} from '@shared/contracts';
import type { AppDatabase } from '../database/database';
import { CatalogImportCancelledError, type CatalogService } from './catalog-service';
import type { CatalogSheetStageRequest, CatalogSheetStageResult } from './catalog-import-worker-service';

type KeywordMetricInput = z.infer<typeof KeywordMetricObservationSchema>;
type GoogleSheetsSyncInput = z.infer<typeof GoogleSheetsSyncSchema>;

export interface SheetValuesReader {
  getValues(spreadsheetId: string, sheetRange: string): Promise<unknown[][]>;
}

export interface CatalogImportRunner {
  stage(operationId: string, request: CatalogSheetStageRequest): Promise<CatalogSheetStageResult>;
  preview(operationId: string, request: { filePath: string; sheetName?: string }): Promise<CatalogImportPreview>;
  cancel(operationId: string): boolean;
}

function jsonObject(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value ?? '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function truthfulMetricLabel(row: Pick<KeywordMetricObservation, 'provider' | 'metricType' | 'youtubeNative'>): string {
  if (row.youtubeNative) return `YouTube-native ${row.metricType}`;
  const source = `${row.provider} ${row.metricType}`.toLowerCase();
  if (source.includes('google ads') || source.includes('google search')) {
    return `Google Search proxy (${row.metricType}) — not YouTube search volume`;
  }
  return `${row.provider} ${row.metricType} — non-YouTube-native estimate`;
}

function normalizedMetric(row: KeywordMetricObservation): number | null {
  if (row.value === null || !Number.isFinite(row.value)) return null;
  const explicit = row.rawMetadata.normalizedScore;
  if (typeof explicit === 'number' && Number.isFinite(explicit)) return clampScore(explicit);
  const type = row.metricType.toLowerCase();
  if (type.includes('ratio') || type.includes('rate')) {
    return clampScore(row.value <= 1 ? row.value * 100 : row.value);
  }
  if (type.includes('monthly') || type.includes('search volume') || type.includes('view velocity')) {
    return clampScore(Math.log10(Math.max(0, row.value) + 1) / 5 * 100);
  }
  if (type.includes('count')) return clampScore(row.value / 20 * 100);
  return clampScore(row.value);
}

function weightedScore(rows: KeywordMetricObservation[]): number | null {
  const scored = rows.flatMap(row => {
    const score = normalizedMetric(row);
    return score === null ? [] : [{ score, weight: Math.max(0.01, row.confidence) }];
  });
  if (!scored.length) return null;
  return scored.reduce((sum, row) => sum + row.score * row.weight, 0)
    / scored.reduce((sum, row) => sum + row.weight, 0);
}

export class ExpansionService {
  private activeSheetOperation: {
    operationId: string;
    cancelled: boolean;
    rejectPendingFetch: () => void;
    startedAt: string;
    progress: number;
    phase: string;
    message: string;
  } | null = null;

  constructor(
    private readonly db: AppDatabase,
    private readonly catalog: CatalogService,
    private readonly settings: () => AppSettings,
    private readonly secretStatus: () => SecretStatus,
    private readonly catalogImports: CatalogImportRunner,
    private readonly sheetValues?: SheetValuesReader,
    private readonly endpointState?: (provider: ProviderEndpointId) => ProviderEndpointState
  ) {}

  registry(): ExpansionRegistrySnapshot {
    const settings = this.settings();
    const secrets = this.secretStatus();
    const channels = (this.db.raw.prepare(`SELECT * FROM channels ORDER BY is_default DESC, name, id`).all() as Array<Record<string, unknown>>)
      .map(row => this.channel(row));
    const languages = (this.db.raw.prepare(`SELECT * FROM language_voice_profiles ORDER BY is_default DESC, language_name, display_name`).all() as Array<Record<string, unknown>>)
      .map(row => this.language(row));
    const providers = (this.db.raw.prepare(`SELECT * FROM provider_registry ORDER BY capability, display_name`).all() as Array<Record<string, unknown>>)
      .map(row => {
        const record = this.provider(row);
        const dynamic = this.providerRuntime(record.providerKey, settings, secrets);
        return dynamic ? { ...record, ...dynamic } : record;
      });
    const outputProfiles = (this.db.raw.prepare(`SELECT * FROM output_profiles ORDER BY is_default DESC, width * height, profile_key`).all() as Array<Record<string, unknown>>)
      .map(row => this.outputProfile(row));
    return { channels, languages, providers, outputProfiles };
  }

  saveChannel(input: {
    id?: string;
    name: string;
    shortCode: string;
    defaultLanguageCode: string;
    defaultVoiceId?: string | null;
    youtubeChannelId?: string | null;
    youtubeChannelTitle?: string | null;
    active?: boolean;
    isDefault?: boolean;
    policy?: Record<string, unknown>;
  }): ChannelProfile {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.db.raw.transaction(() => {
      if (input.isDefault) this.db.raw.prepare(`UPDATE channels SET is_default = 0, updated_at = ?`).run(now);
      this.db.raw.prepare(`
        INSERT INTO channels(
          id, name, short_code, default_language_code, default_voice_id,
          youtube_channel_id, youtube_channel_title, active, is_default,
          policy_json, external_qualification, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unverified', ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name, short_code = excluded.short_code,
          default_language_code = excluded.default_language_code,
          default_voice_id = excluded.default_voice_id,
          youtube_channel_id = excluded.youtube_channel_id,
          youtube_channel_title = excluded.youtube_channel_title,
          active = excluded.active, is_default = excluded.is_default,
          policy_json = excluded.policy_json, updated_at = excluded.updated_at
      `).run(
        id, input.name, input.shortCode.toUpperCase(), input.defaultLanguageCode,
        input.defaultVoiceId ?? null, input.youtubeChannelId ?? null,
        input.youtubeChannelTitle ?? null, Number(input.active ?? true),
        Number(input.isDefault ?? false), JSON.stringify(input.policy ?? {}), now, now
      );
    })();
    return this.channel(this.db.raw.prepare(`SELECT * FROM channels WHERE id = ?`).get(id)!);
  }

  saveLanguage(input: {
    id?: string;
    languageCode: string;
    languageName: string;
    voiceProvider: string;
    voiceId: string;
    displayName: string;
    active?: boolean;
    isDefault?: boolean;
    settings?: Record<string, unknown>;
  }): LanguageVoiceProfile {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.db.raw.transaction(() => {
      if (input.isDefault) this.db.raw.prepare(`UPDATE language_voice_profiles SET is_default = 0, updated_at = ?`).run(now);
      this.db.raw.prepare(`
        INSERT INTO language_voice_profiles(
          id, language_code, language_name, voice_provider, voice_id, display_name,
          active, is_default, settings_json, external_qualification, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'unverified', ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          language_code = excluded.language_code, language_name = excluded.language_name,
          voice_provider = excluded.voice_provider, voice_id = excluded.voice_id,
          display_name = excluded.display_name, active = excluded.active,
          is_default = excluded.is_default, settings_json = excluded.settings_json,
          updated_at = excluded.updated_at
      `).run(
        id, input.languageCode, input.languageName, input.voiceProvider, input.voiceId,
        input.displayName, Number(input.active ?? true), Number(input.isDefault ?? false),
        JSON.stringify(input.settings ?? {}), now, now
      );
    })();
    return this.language(this.db.raw.prepare(`SELECT * FROM language_voice_profiles WHERE id = ?`).get(id)!);
  }

  importKeywordMetric(input: KeywordMetricInput): KeywordMetricObservation {
    if (input.topicCandidateId) {
      const topic = this.db.raw.prepare(`SELECT id FROM topic_candidates WHERE id = ?`).get(input.topicCandidateId);
      if (!topic) throw new Error('Topic candidate not found for keyword evidence.');
    }
    const sourceHash = createHash('sha256').update(JSON.stringify({
      ...input,
      keyword: input.keyword.toLowerCase(),
      provider: input.provider.toLowerCase(),
      metricType: input.metricType.toLowerCase()
    })).digest('hex');
    const existing = this.db.raw.prepare(`SELECT * FROM keyword_metric_observations WHERE source_hash = ?`).get(sourceHash) as Record<string, unknown> | undefined;
    if (existing) return this.observation(existing);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.raw.prepare(`
      INSERT INTO keyword_metric_observations(
        id, topic_candidate_id, keyword, provider, metric_type, value,
        geography_code, language_code, collected_at, confidence,
        youtube_native, raw_metadata_json, source_hash, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.topicCandidateId ?? null, input.keyword, input.provider,
      input.metricType, input.value, input.geographyCode ?? null, input.languageCode,
      input.collectedAt, input.confidence, Number(input.youtubeNative),
      JSON.stringify(input.rawMetadata), sourceHash, now
    );
    if (input.topicCandidateId) this.assessOpportunity(input.topicCandidateId, true);
    return this.observation(this.db.raw.prepare(`SELECT * FROM keyword_metric_observations WHERE id = ?`).get(id)!);
  }

  keywordMetrics(topicCandidateId?: string): KeywordMetricObservation[] {
    const rows = this.db.raw.prepare(`
      SELECT * FROM keyword_metric_observations
      ${topicCandidateId ? 'WHERE topic_candidate_id = ?' : ''}
      ORDER BY collected_at DESC, created_at DESC LIMIT 1000
    `).all(...(topicCandidateId ? [topicCandidateId] : [])) as Array<Record<string, unknown>>;
    return rows.map(row => this.observation(row));
  }

  opportunities(limit = 100): OpportunityAssessment[] {
    const rows = this.db.raw.prepare(`SELECT id FROM topic_candidates ORDER BY created_at DESC LIMIT ?`).all(limit) as Array<{ id: string }>;
    return rows.map(row => this.assessOpportunity(row.id, false));
  }

  assessOpportunity(topicCandidateId: string, persist = false): OpportunityAssessment {
    const topic = this.db.raw.prepare(`SELECT * FROM topic_candidates WHERE id = ?`).get(topicCandidateId) as Record<string, unknown> | undefined;
    if (!topic) throw new Error('Topic candidate not found.');
    const observations = this.keywordMetrics(topicCandidateId);
    const demandRows = observations.filter(row => {
      const type = row.metricType.toLowerCase();
      return type.includes('demand') || type.includes('search') || type.includes('velocity') || type.includes('channel term');
    });
    const competitionRows = observations.filter(row => {
      const type = row.metricType.toLowerCase();
      return type.includes('competition') || type.includes('incumbent') || type.includes('title match');
    });
    const demandScore = weightedScore(demandRows);
    const competitionPressure = weightedScore(competitionRows);
    const coverage = jsonObject(topic.coverage_json);
    const distribution = jsonObject(coverage.exactConfidenceDistribution);
    const assetCount = Number(coverage.assetCount ?? 0);
    const exactLocationConfidence = assetCount
      ? clampScore((Number(distribution.verified ?? 0) + Number(distribution.strong ?? 0) * 0.85 + Number(distribution.contextual ?? 0) * 0.5) / assetCount * 100)
      : 0;
    const visualCoverage = clampScore(Number(coverage.coverageScore ?? 0));
    const productionEfficiency = assetCount
      ? clampScore((Number(coverage.downloadedCount ?? 0) / assetCount * 40) + (Math.min(assetCount, 40) / 40 * 60))
      : 0;
    const channelFitRows = observations.filter(row => row.metricType.toLowerCase().includes('channel fit'));
    const freshnessRows = observations.filter(row => row.metricType.toLowerCase().includes('season') || row.metricType.toLowerCase().includes('freshness'));
    const strategicRows = observations.filter(row => row.metricType.toLowerCase().includes('strategic'));
    const channelFit = weightedScore(channelFitRows) ?? 0;
    const freshness = weightedScore(freshnessRows) ?? 0;
    const strategic = weightedScore(strategicRows) ?? 0;
    const evergreen = String(topic.angle).toLowerCase().includes('visual guide') ? 50 : 0;
    const lowCompetition = competitionPressure === null ? 0 : 100 - competitionPressure;
    const components = {
      visualCoverage,
      demand: demandScore ?? 0,
      lowCompetition,
      exactLocationConfidence,
      channelFit,
      evergreen,
      freshness,
      productionEfficiency,
      strategic
    };
    const opportunityScore =
      components.visualCoverage * 0.22
      + components.demand * 0.18
      + components.lowCompetition * 0.16
      + components.exactLocationConfidence * 0.12
      + components.channelFit * 0.10
      + components.evergreen * 0.08
      + components.freshness * 0.06
      + components.productionEfficiency * 0.05
      + components.strategic * 0.03;
    const labels = [...new Set(observations.map(truthfulMetricLabel))];
    if (demandScore === null) labels.push('Demand evidence missing — scored as unknown, not estimated search volume.');
    if (competitionPressure === null) labels.push('Competition evidence missing — no low-competition credit applied.');
    if (!channelFitRows.length) labels.push('Channel-fit evidence missing — no channel-fit credit applied.');
    const feasible = topic.feasibility === 'qualified';
    const assessment: OpportunityAssessment = {
      topicCandidateId,
      destinationKey: String(topic.destination_key),
      title: String(topic.title),
      destination: String(topic.destination),
      feasibility: topic.feasibility as OpportunityAssessment['feasibility'],
      demandScore,
      competitionScore: competitionPressure,
      opportunityScore: feasible ? Math.round(opportunityScore * 10) / 10 : 0,
      components: Object.fromEntries(Object.entries(components).map(([key, value]) => [key, Math.round(value * 10) / 10])),
      observations,
      labels
    };
    if (persist) {
      const prior = jsonObject(topic.raw_metrics_json);
      this.db.raw.prepare(`
        UPDATE topic_candidates SET demand_score = ?, competition_score = ?,
          opportunity_score = ?, raw_metrics_json = ? WHERE id = ?
      `).run(
        demandScore, competitionPressure, assessment.opportunityScore,
        JSON.stringify({ ...prior, opportunityComponents: assessment.components, metricLabels: labels }),
        topicCandidateId
      );
      if (topic.project_id) {
        this.db.raw.prepare(`UPDATE projects SET opportunity_score = ?, updated_at = ? WHERE id = ?`).run(
          assessment.opportunityScore, new Date().toISOString(), topic.project_id
        );
      }
    }
    return assessment;
  }

  async stageGoogleSheet(input: GoogleSheetsSyncInput): Promise<GoogleSheetsSyncRun> {
    if (!this.sheetValues) throw new Error('The Google Sheets read-only provider is unavailable.');
    const createdAt = new Date().toISOString();
    const runId = randomUUID();
    const operationId = input.operationId ?? runId;
    if (this.activeSheetOperation) throw new Error('Another Google Sheets staging operation is already running.');
    let rejectPendingFetch = (): void => undefined;
    const cancelledFetch = new Promise<never>((_resolve, reject) => {
      rejectPendingFetch = () => reject(new CatalogImportCancelledError());
    });
    const activeOperation = {
      operationId,
      cancelled: false,
      rejectPendingFetch,
      startedAt: createdAt,
      progress: 0.02,
      phase: 'fetching_sheet',
      message: 'Fetching Google Sheets rows with read-only access'
    };
    this.activeSheetOperation = activeOperation;
    let configId: string | null = null;
    try {
      const existing = this.db.raw.prepare(`
        SELECT id FROM google_sheets_sync_configs WHERE spreadsheet_id = ? AND sheet_range = ?
      `).get(input.spreadsheetId, input.sheetRange) as { id: string } | undefined;
      configId = existing?.id ?? input.configId ?? randomUUID();
      this.db.raw.prepare(`
        INSERT INTO google_sheets_sync_configs(
          id, name, spreadsheet_id, sheet_range, validation_template_id, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(spreadsheet_id, sheet_range) DO UPDATE SET
          name = excluded.name, validation_template_id = excluded.validation_template_id,
          active = 1, updated_at = excluded.updated_at
      `).run(
        configId, input.name ?? `${input.spreadsheetId} · ${input.sheetRange}`,
        input.spreadsheetId, input.sheetRange,
        input.validationTemplateId ?? 'envato-default', createdAt, createdAt
      );
      const values = await Promise.race([
        this.sheetValues.getValues(input.spreadsheetId, input.sheetRange),
        cancelledFetch
      ]);
      if (activeOperation.cancelled) throw new CatalogImportCancelledError();
      activeOperation.progress = 0.08;
      activeOperation.phase = 'staging_rows';
      activeOperation.message = 'Google Sheets rows fetched; staging the catalog diff in the worker';
      const directory = join(this.settings().dataRoot, 'sync', 'google-sheets');
      const path = join(directory, `${runId}.xlsx`);
      const staged = await this.catalogImports.stage(operationId, {
        filePath: path,
        rows: values,
        sheetName: 'Catalog'
      });
      if (activeOperation.cancelled) throw new CatalogImportCancelledError();
      const { sourceSha256, preview } = staged;
      const template = this.catalog.validationTemplates().find(item => item.id === (input.validationTemplateId ?? 'envato-default'));
      const issues: string[] = [];
      if (!template) issues.push('Catalog validation template was not found.');
      if (template) {
        if (preview.rowCount < template.minimumRows) issues.push(`Expected at least ${template.minimumRows} data row(s).`);
        for (const field of template.requiredFields) {
          if (!preview.mapping[field]) issues.push(`Required mapped field is missing: ${field}.`);
        }
        if (!template.identityFields.some(field => Boolean(preview.mapping[field]))) {
          issues.push(`At least one durable identity field is required: ${template.identityFields.join(' or ')}.`);
        }
        if ((preview.rowCount ? preview.diff.invalid / preview.rowCount : 1) > template.maximumInvalidRatio) {
          issues.push('Invalid-row ratio exceeds the selected validation template.');
        }
      }
      const changed = preview.diff.inserted + preview.diff.changed + preview.diff.conflicts + preview.diff.missing;
      const status: GoogleSheetsSyncRun['status'] = issues.length ? 'blocked' : changed ? 'staged' : 'up_to_date';
      if (status !== 'staged') this.catalog.cancelImportPreview(preview.previewId);
      const completedAt = new Date().toISOString();
      this.db.raw.prepare(`
        INSERT INTO google_sheets_sync_runs(
          id, config_id, spreadsheet_id, sheet_range, source_sha256,
          materialized_path, preview_id, row_count, status, diff_json,
          error, created_at, completed_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        runId, configId, input.spreadsheetId, input.sheetRange, sourceSha256,
        path, status === 'staged' ? preview.previewId : null,
        preview.rowCount, status, JSON.stringify(preview.diff),
        issues.length ? issues.join(' ') : null, createdAt, completedAt
      );
      return this.googleSheetsRun(runId);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000);
      this.db.raw.prepare(`
        INSERT INTO google_sheets_sync_runs(
          id, config_id, spreadsheet_id, sheet_range, row_count, status,
          diff_json, error, created_at, completed_at
        ) VALUES(?, ?, ?, ?, 0, 'failed', '{}', ?, ?, ?)
      `).run(runId, configId, input.spreadsheetId, input.sheetRange, message, createdAt, new Date().toISOString());
      if (error instanceof Error && error.name === 'CatalogImportCancelledError') throw error;
      return this.googleSheetsRun(runId);
    } finally {
      if (this.activeSheetOperation === activeOperation) this.activeSheetOperation = null;
    }
  }

  cancelGoogleSheetOperation(operationId: string): boolean {
    const active = this.activeSheetOperation;
    if (!active || active.operationId !== operationId) return false;
    if (!active.cancelled) {
      active.cancelled = true;
      active.phase = 'cancelling';
      active.message = 'Cancelling Google Sheets staging safely';
      active.rejectPendingFetch();
    }
    this.catalogImports.cancel(operationId);
    return true;
  }

  googleSheetOperationStatus(): CatalogImportOperationStatus | null {
    const active = this.activeSheetOperation;
    if (!active) return null;
    return {
      operationId: active.operationId,
      operation: 'stage',
      state: active.cancelled ? 'cancelling' : 'running',
      progress: active.progress,
      phase: active.phase,
      message: active.message,
      startedAt: active.startedAt
    };
  }

  googleSheetsRuns(): GoogleSheetsSyncRun[] {
    const rows = this.db.raw.prepare(`SELECT id FROM google_sheets_sync_runs ORDER BY created_at DESC LIMIT 100`).all() as Array<{ id: string }>;
    return rows.map(row => this.googleSheetsRun(row.id));
  }

  async stagedGoogleSheetPreview(previewId: string): Promise<CatalogImportPreview> {
    const run = this.db.raw.prepare(`
      SELECT materialized_path FROM google_sheets_sync_runs
      WHERE preview_id = ? AND status = 'staged'
    `).get(previewId) as { materialized_path: string | null } | undefined;
    if (!run?.materialized_path) throw new Error('A staged Google Sheets preview was not found.');
    const replacement = await this.catalogImports.preview(randomUUID(), {
      filePath: run.materialized_path,
      sheetName: 'Catalog'
    });
    this.db.raw.transaction(() => {
      this.db.raw.prepare(`
        UPDATE google_sheets_sync_runs SET preview_id = ?
        WHERE preview_id = ? AND status = 'staged'
      `).run(replacement.previewId, previewId);
      this.catalog.cancelImportPreview(previewId);
    })();
    return replacement;
  }

  private providerRuntime(
    key: string,
    settings: AppSettings,
    secrets: SecretStatus
  ): Partial<ProviderCapabilityRecord> | null {
    const remote = (
      provider: ProviderEndpointId,
      selected: boolean,
      credentialsConfigured: boolean,
      message: string
    ): Partial<ProviderCapabilityRecord> => {
      const endpoint = this.endpointState?.(provider);
      const configured = selected && credentialsConfigured && (endpoint?.ready ?? true);
      return {
        configured,
        available: configured,
        statusMessage: configured
          ? `${message}; live qualification remains unverified.`
          : endpoint && selected && !endpoint.ready
            ? endpoint.message
            : 'Credentials or provider selection are not configured.'
      };
    };
    switch (key) {
      case 'openai_compatible': return remote('openai_compatible', settings.llmProvider === 'openai_compatible', secrets.llmApiKeyConfigured || settings.llmEndpointTrust === 'custom_local', 'Language adapter is configured');
      case 'openai_compatible_vision': return remote('openai_compatible_vision', settings.visionProvider === 'openai_compatible', secrets.visionApiKeyConfigured || settings.visionEndpointTrust === 'custom_local', 'Vision adapter is configured');
      case 'http_tts': return remote('http_tts', settings.narratorProvider === 'http_tts', secrets.httpTtsApiKeyConfigured || settings.narratorEndpointTrust === 'custom_local', 'HTTP TTS adapter is configured');
      case 'tavily': return remote('tavily', settings.researchProvider === 'tavily', secrets.researchApiKeyConfigured || settings.researchEndpointTrust === 'custom_local', 'Research adapter is configured');
      case 'youtube':
      case 'youtube_analytics':
      case 'google_sheets_readonly': {
        const configured = secrets.youtubeClientConfigured && secrets.youtubeAuthorized;
        return {
          configured,
          available: configured,
          statusMessage: configured
            ? 'Google OAuth is configured; live qualification remains unverified.'
            : 'Credentials or provider selection are not configured.'
        };
      }
      case 'windows_sapi': return {
        configured: settings.narratorProvider === 'windows_sapi',
        available: process.platform === 'win32',
        statusMessage: process.platform === 'win32' ? 'Windows runtime is available; representative voice qualification remains unverified.' : 'Available only on Windows.'
      };
      default: return null;
    }
  }

  private channel(row: Record<string, unknown>): ChannelProfile {
    return {
      id: String(row.id), name: String(row.name), shortCode: String(row.short_code),
      defaultLanguageCode: String(row.default_language_code),
      defaultVoiceId: row.default_voice_id ? String(row.default_voice_id) : null,
      youtubeChannelId: row.youtube_channel_id ? String(row.youtube_channel_id) : null,
      youtubeChannelTitle: row.youtube_channel_title ? String(row.youtube_channel_title) : null,
      active: Boolean(row.active), isDefault: Boolean(row.is_default),
      policy: jsonObject(row.policy_json),
      externalQualification: row.external_qualification as ChannelProfile['externalQualification']
    };
  }

  private language(row: Record<string, unknown>): LanguageVoiceProfile {
    return {
      id: String(row.id), languageCode: String(row.language_code), languageName: String(row.language_name),
      voiceProvider: String(row.voice_provider), voiceId: String(row.voice_id), displayName: String(row.display_name),
      active: Boolean(row.active), isDefault: Boolean(row.is_default), settings: jsonObject(row.settings_json),
      externalQualification: row.external_qualification as LanguageVoiceProfile['externalQualification']
    };
  }

  private provider(row: Record<string, unknown>): ProviderCapabilityRecord {
    return {
      id: String(row.id), providerKey: String(row.provider_key), displayName: String(row.display_name),
      capability: row.capability as ProviderCapabilityRecord['capability'], implementation: String(row.implementation),
      configured: Boolean(row.configured), available: Boolean(row.available),
      externalQualification: row.external_qualification as ProviderCapabilityRecord['externalQualification'],
      capabilities: jsonObject(row.capability_json),
      lastCheckedAt: row.last_checked_at ? String(row.last_checked_at) : null,
      statusMessage: row.status_message ? String(row.status_message) : null
    };
  }

  private outputProfile(row: Record<string, unknown>): OutputProfile {
    return {
      id: String(row.id), profileKey: row.profile_key as OutputProfile['profileKey'],
      displayName: String(row.display_name), width: Number(row.width), height: Number(row.height),
      orientation: row.orientation as OutputProfile['orientation'], frameRate: Number(row.frame_rate),
      videoCodec: String(row.video_codec), audioCodec: String(row.audio_codec),
      qualificationPolicy: jsonObject(row.qualification_policy_json),
      active: Boolean(row.active), isDefault: Boolean(row.is_default)
    };
  }

  private observation(row: Record<string, unknown>): KeywordMetricObservation {
    const value: KeywordMetricObservation = {
      id: String(row.id), topicCandidateId: row.topic_candidate_id ? String(row.topic_candidate_id) : null,
      keyword: String(row.keyword), provider: String(row.provider), metricType: String(row.metric_type),
      value: row.value === null || row.value === undefined ? null : Number(row.value),
      geographyCode: row.geography_code ? String(row.geography_code) : null,
      languageCode: String(row.language_code), collectedAt: String(row.collected_at),
      confidence: Number(row.confidence), youtubeNative: Boolean(row.youtube_native),
      rawMetadata: jsonObject(row.raw_metadata_json), truthfulLabel: ''
    };
    value.truthfulLabel = truthfulMetricLabel(value);
    return value;
  }

  private googleSheetsRun(id: string): GoogleSheetsSyncRun {
    const row = this.db.raw.prepare(`SELECT * FROM google_sheets_sync_runs WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error('Google Sheets sync run not found.');
    return {
      id: String(row.id), configId: row.config_id ? String(row.config_id) : null,
      spreadsheetId: String(row.spreadsheet_id), sheetRange: String(row.sheet_range),
      sourceSha256: row.source_sha256 ? String(row.source_sha256) : null,
      materializedPath: row.materialized_path ? String(row.materialized_path) : null,
      previewId: row.preview_id ? String(row.preview_id) : null,
      rowCount: Number(row.row_count), status: row.status as GoogleSheetsSyncRun['status'],
      diff: jsonObject(row.diff_json) as unknown as GoogleSheetsSyncRun['diff'],
      error: row.error ? String(row.error) : null, createdAt: String(row.created_at),
      completedAt: row.completed_at ? String(row.completed_at) : null
    };
  }
}
