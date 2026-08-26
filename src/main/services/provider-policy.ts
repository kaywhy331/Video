import type { AppDatabase } from '../database/database';
import type { AppSettings } from '@shared/types';

export type ProviderHealthStatus = 'healthy' | 'auth_invalid' | 'quota_exhausted' | 'unavailable'
  | 'invalid_endpoint' | 'endpoint_untrusted' | 'credential_origin_mismatch'
  | 'timeout' | 'provider_failure';

export interface ProviderPreflightOptions {
  projectId?: string;
  provider: string;
  estimatedCostUsd?: number;
  configured: boolean;
}

export class ProviderPreflightError extends Error {
  constructor(
    readonly code: 'PROVIDER_NOT_CONFIGURED' | 'PROVIDER_AUTH_INVALID' | 'PROVIDER_QUOTA_EXHAUSTED'
      | 'PROVIDER_ENDPOINT_INVALID' | 'PROVIDER_ENDPOINT_UNTRUSTED' | 'PROVIDER_CREDENTIAL_ORIGIN_MISMATCH'
      | 'MONTHLY_BUDGET_EXHAUSTED' | 'PROJECT_BUDGET_EXHAUSTED',
    message: string
  ) {
    super(message);
    this.name = 'ProviderPreflightError';
  }
}

export class ProviderPolicyService {
  constructor(
    private readonly db: AppDatabase,
    private readonly settings: () => AppSettings
  ) {}

  assertCanCall(options: ProviderPreflightOptions): void {
    const health = this.db.raw.prepare(`
      SELECT status, message FROM provider_health WHERE provider = ?
    `).get(options.provider) as { status: ProviderHealthStatus; message: string | null } | undefined;
    if (health?.status === 'auth_invalid') {
      throw new ProviderPreflightError('PROVIDER_AUTH_INVALID', health.message ?? `${options.provider} authentication is invalid; no provider request was sent.`);
    }
    if (health?.status === 'quota_exhausted') {
      throw new ProviderPreflightError('PROVIDER_QUOTA_EXHAUSTED', health.message ?? `${options.provider} quota is exhausted; no provider request was sent.`);
    }
    if (health?.status === 'invalid_endpoint') {
      throw new ProviderPreflightError('PROVIDER_ENDPOINT_INVALID', health.message ?? `${options.provider} endpoint is invalid; no provider request was sent.`);
    }
    if (health?.status === 'endpoint_untrusted') {
      throw new ProviderPreflightError('PROVIDER_ENDPOINT_UNTRUSTED', health.message ?? `${options.provider} endpoint is not confirmed; no provider request was sent.`);
    }
    if (health?.status === 'credential_origin_mismatch') {
      throw new ProviderPreflightError('PROVIDER_CREDENTIAL_ORIGIN_MISMATCH', health.message ?? `${options.provider} credential is not bound to its endpoint; no provider request was sent.`);
    }
    if (!options.configured) {
      throw new ProviderPreflightError('PROVIDER_NOT_CONFIGURED', `${options.provider} is not configured; no provider request was sent.`);
    }

    const estimated = Math.max(0, options.estimatedCostUsd ?? 0);
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const monthly = this.db.raw.prepare(`
      SELECT coalesce(sum(estimated_cost_usd), 0) AS total
      FROM provider_calls WHERE created_at >= ?
    `).get(monthStart.toISOString()) as { total: number };
    if (Number(monthly.total) + estimated > this.settings().monthlyBudgetUsd) {
      throw new ProviderPreflightError('MONTHLY_BUDGET_EXHAUSTED', 'Monthly provider budget would be exceeded; no provider request was sent.');
    }

    if (options.projectId) {
      const project = this.db.raw.prepare(`SELECT provider_budget_usd FROM projects WHERE id = ?`).get(options.projectId) as { provider_budget_usd: number } | undefined;
      if (!project) throw new Error('Project not found for provider preflight.');
      const spend = this.db.raw.prepare(`
        SELECT coalesce(sum(estimated_cost_usd), 0) AS total
        FROM provider_calls WHERE project_id = ?
      `).get(options.projectId) as { total: number };
      if (Number(spend.total) + estimated > Number(project.provider_budget_usd)) {
        throw new ProviderPreflightError('PROJECT_BUDGET_EXHAUSTED', 'Project provider budget would be exceeded; no provider request was sent.');
      }
    }
  }

  recordHealth(provider: string, status: ProviderHealthStatus, statusCode: number | null, message: string | null, metadata: Record<string, unknown> = {}): void {
    this.db.raw.prepare(`
      INSERT INTO provider_health(provider, status, status_code, message, checked_at, metadata_json)
      VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET status = excluded.status,
        status_code = excluded.status_code, message = excluded.message,
        checked_at = excluded.checked_at, metadata_json = excluded.metadata_json
    `).run(provider, status, statusCode, message, new Date().toISOString(), JSON.stringify(metadata));
  }

  classifyHttpFailure(provider: string, status: number, message: string): void {
    if (status === 401 || status === 403) this.recordHealth(provider, 'auth_invalid', status, message);
    else if (status === 402 || status === 429) this.recordHealth(provider, 'quota_exhausted', status, message);
    else this.recordHealth(provider, 'provider_failure', status, message);
  }
}
