import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase } from '@main/database/database';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('application database migrations', () => {
  it('applies and records every forward migration through the real wrapper', () => {
    const root = mkdtempSync(join(tmpdir(), 'videofactory-migrations-'));
    roots.push(root);
    const database = new AppDatabase(join(root, 'videofactory.sqlite'));

    expect(database.raw.prepare(`
      SELECT version, name FROM schema_migrations ORDER BY version
    `).all()).toEqual([
      { version: 1, name: 'initial' },
      { version: 2, name: 'production_hardening' },
      { version: 3, name: 'automated_repair' },
      { version: 4, name: 'semantic_footage_verification' },
      { version: 5, name: 'research_provider_preflight' },
      { version: 6, name: 'verified_script_narration_range' },
      { version: 7, name: 'project_artifact_portability' }
    ]);
    expect(database.raw.prepare(`
      SELECT name FROM pragma_table_info('projects') WHERE name = 'resume_state'
    `).get()).toEqual({ name: 'resume_state' });
    expect(database.raw.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'backup_runs'
    `).get()).toEqual({ name: 'backup_runs' });
    expect(database.raw.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'repair_attempts'
    `).get()).toEqual({ name: 'repair_attempts' });
    expect(database.raw.prepare(`
      SELECT name FROM pragma_table_info('renders') WHERE name = 'artifact_version'
    `).get()).toEqual({ name: 'artifact_version' });
    expect(database.raw.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'footage_verifications'
    `).get()).toEqual({ name: 'footage_verifications' });
    expect(database.raw.prepare(`
      SELECT name FROM pragma_table_info('project_scenes') WHERE name = 'required_place_id'
    `).get()).toEqual({ name: 'required_place_id' });
    expect(database.raw.prepare(`
      SELECT name FROM pragma_table_info('projects') WHERE name = 'provider_budget_usd'
    `).get()).toEqual({ name: 'provider_budget_usd' });
    expect(database.raw.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fact_claim_sources'
    `).get()).toEqual({ name: 'fact_claim_sources' });
    expect(database.raw.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'provider_health'
    `).get()).toEqual({ name: 'provider_health' });
    for (const table of ['voice_assets', 'narration_sections', 'narration_words', 'render_fragments']) {
      expect(database.raw.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?
      `).get(table)).toEqual({ name: table });
    }
    for (const table of ['project_export_runs', 'derivative_rebuild_runs']) {
      expect(database.raw.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?
      `).get(table)).toEqual({ name: table });
    }
    expect(database.raw.prepare(`
      SELECT name FROM pragma_table_info('script_versions') WHERE name = 'script_type'
    `).get()).toEqual({ name: 'script_type' });
    expect(database.raw.prepare(`
      SELECT name FROM pragma_table_info('renders') WHERE name = 'scope_json'
    `).get()).toEqual({ name: 'scope_json' });
    expect(database.raw.prepare(`
      SELECT name FROM pragma_table_info('repair_attempts') WHERE name = 'range_start_ordinal'
    `).get()).toEqual({ name: 'range_start_ordinal' });
    const now = new Date().toISOString();
    database.raw.prepare(`INSERT INTO projects(id, sequence, slug, title, topic, state, progress, envato_project_name, target_duration_ms, created_at, updated_at) VALUES('claim-project', 99, 'claim-project', 'Claims', 'Claims', 'CREATED', 0, 'YT-CLAIMS', 1000, ?, ?)`).run(now, now);
    expect(() => database.raw.prepare(`INSERT INTO fact_claims(id, project_id, text, category, confidence, stability, source_ids_json, status, created_at) VALUES('claim-without-source', 'claim-project', 'Unsupported', 'other', 1, 'stable', '[]', 'accepted', ?)`).run(now)).toThrow('staged');
    expect(database.integrityCheck()).toBe('ok');

    database.close();

    const reopened = new AppDatabase(join(root, 'videofactory.sqlite'));
    expect(reopened.raw.prepare('SELECT count(*) AS count FROM schema_migrations').get())
      .toEqual({ count: 7 });
    expect(reopened.integrityCheck()).toBe('ok');
    reopened.close();
  });
});
