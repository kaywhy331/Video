import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase } from '@main/database/database';
import { ProviderPolicyService } from '@main/services/provider-policy';
import type { AppSettings } from '@shared/types';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'videofactory-provider-policy-'));
  roots.push(root);
  const db = new AppDatabase(join(root, 'db.sqlite'));
  const now = new Date().toISOString();
  db.raw.prepare(`INSERT INTO projects(id, sequence, slug, title, topic, state, progress, envato_project_name, target_duration_ms, provider_budget_usd, created_at, updated_at) VALUES('p1', 1, 'p1', 'P1', 'P1', 'CREATED', 0, 'YT-P1', 1000, 2, ?, ?)`).run(now, now);
  const settings = { monthlyBudgetUsd: 10 } as AppSettings;
  return { db, policy: new ProviderPolicyService(db, () => settings), now };
}

describe('provider preflight', () => {
  it('blocks known auth/quota failures before a call', () => {
    const { db, policy } = fixture();
    policy.recordHealth('tavily', 'auth_invalid', 401, 'Invalid key');
    expect(() => policy.assertCanCall({ provider: 'tavily', projectId: 'p1', configured: true })).toThrow('Invalid key');
    db.close();
  });

  it('enforces monthly and per-project hard limits', () => {
    const { db, policy, now } = fixture();
    db.raw.prepare(`INSERT INTO provider_calls(id, project_id, provider, model, operation, input_hash, estimated_cost_usd, created_at) VALUES('c1', 'p1', 'tavily', 'search', 'search', 'h1', 2, ?)`).run(now);
    expect(() => policy.assertCanCall({ provider: 'tavily', projectId: 'p1', configured: true, estimatedCostUsd: 0.01 })).toThrow('Project provider budget');
    db.raw.prepare(`UPDATE projects SET provider_budget_usd = 20 WHERE id = 'p1'`).run();
    db.raw.prepare(`INSERT INTO provider_calls(id, project_id, provider, model, operation, input_hash, estimated_cost_usd, created_at) VALUES('c2', NULL, 'other', 'x', 'x', 'h2', 8, ?)`).run(now);
    expect(() => policy.assertCanCall({ provider: 'tavily', projectId: 'p1', configured: true, estimatedCostUsd: 0.01 })).toThrow('Monthly provider budget');
    db.close();
  });

  it('counts failed billed attempts toward the project budget', () => {
    const { db, policy, now } = fixture();
    db.raw.prepare(`INSERT INTO provider_calls(id, project_id, provider, model, operation, input_hash, estimated_cost_usd, error, created_at) VALUES('failed', 'p1', 'tavily', 'search', 'search', 'failed-hash', 2, 'timeout', ?)`).run(now);
    expect(() => policy.assertCanCall({ provider: 'tavily', projectId: 'p1', configured: true, estimatedCostUsd: 0.01 })).toThrow('Project provider budget');
    db.close();
  });
});
