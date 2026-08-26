import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase, SqliteConnection } from '@main/database/database';

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
      { version: 7, name: 'project_artifact_portability' },
      { version: 8, name: 'catalog_evidence_and_diagnostics' },
      { version: 9, name: 'operations_automation' },
      { version: 10, name: 'scheduler_analytics' },
      { version: 11, name: 'music_storage' },
      { version: 12, name: 'expansion_architecture' },
      { version: 13, name: 'workflow_recovery' },
      { version: 14, name: 'catalog_search_performance' },
      { version: 15, name: 'project_guidance' },
      { version: 16, name: 'job_resource_leases' },
      { version: 17, name: 'deferred_lifecycle' },
      { version: 18, name: 'perceptual_matching' },
      { version: 19, name: 'youtube_channel_binding' },
      { version: 20, name: 'provider_endpoint_trust' },
      { version: 21, name: 'state_safe_job_retry' },
      { version: 22, name: 'media_tool_trust' },
      { version: 23, name: 'active_final_publication' }
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
    for (const table of [
      'catalog_import_previews', 'catalog_import_rows', 'asset_metadata_assertions',
      'place_operations', 'diagnostic_runs', 'catalog_exports'
    ]) {
      expect(database.raw.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?
      `).get(table)).toEqual({ name: table });
    }
    for (const table of [
      'music_tracks', 'project_music_selections', 'storage_cleanup_runs',
      'storage_cleanup_items'
    ]) {
      expect(database.raw.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?
      `).get(table)).toEqual({ name: table });
    }
    for (const table of [
      'autopilot_scheduler_state', 'scheduler_runs', 'retention_mappings',
      'learning_recommendations', 'revision_requests'
    ]) {
      expect(database.raw.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?
      `).get(table)).toEqual({ name: table });
    }
    for (const table of [
      'settings_profile_operations', 'update_checks', 'catalog_validation_templates',
      'catalog_refresh_runs'
    ]) {
      expect(database.raw.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?
      `).get(table)).toEqual({ name: table });
    }
    for (const table of [
      'channels', 'language_voice_profiles', 'provider_registry', 'output_profiles',
      'keyword_metric_observations', 'google_sheets_sync_configs',
      'google_sheets_sync_runs', 'analytics_collection_runs'
    ]) {
      expect(database.raw.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?
      `).get(table)).toEqual({ name: table });
    }
    expect(database.raw.prepare('SELECT count(*) AS count FROM output_profiles').get()).toEqual({ count: 3 });
    expect(database.raw.prepare('SELECT count(*) AS count FROM provider_registry').get()).toEqual({ count: 13 });
    expect(database.raw.prepare(`SELECT name FROM pragma_table_info('projects') WHERE name = 'output_profile_snapshot_json'`).get())
      .toEqual({ name: 'output_profile_snapshot_json' });
    expect(database.raw.prepare('SELECT count(*) AS count FROM catalog_validation_templates').get())
      .toEqual({ count: 3 });
    expect(database.raw.prepare(`
      SELECT name FROM pragma_table_info('script_versions') WHERE name = 'script_type'
    `).get()).toEqual({ name: 'script_type' });
    expect(database.raw.prepare(`
      SELECT name FROM pragma_table_info('renders') WHERE name = 'scope_json'
    `).get()).toEqual({ name: 'scope_json' });
    expect(database.raw.prepare(`
      SELECT name FROM pragma_table_info('repair_attempts') WHERE name = 'range_start_ordinal'
    `).get()).toEqual({ name: 'range_start_ordinal' });
    expect(database.raw.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_assets_updated_id'
    `).get()).toEqual({ name: 'idx_assets_updated_id' });
    expect(database.raw.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_guidance'
    `).get()).toEqual({ name: 'project_guidance' });
    expect(database.raw.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'job_resource_leases'
    `).get()).toEqual({ name: 'job_resource_leases' });
    expect(database.raw.prepare(`
      SELECT name FROM pragma_table_info('projects') WHERE name = 'pending_lifecycle_action'
    `).get()).toEqual({ name: 'pending_lifecycle_action' });
    expect(database.raw.prepare(`
      SELECT name FROM pragma_table_info('asset_files') WHERE name = 'perceptual_hash'
    `).get()).toEqual({ name: 'perceptual_hash' });
    expect(database.raw.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'youtube_connection_binding'
    `).get()).toEqual({ name: 'youtube_connection_binding' });
    expect(database.raw.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'provider_endpoint_bindings'
    `).get()).toEqual({ name: 'provider_endpoint_bindings' });
    expect(database.raw.prepare(`
      SELECT name FROM pragma_table_info('jobs') WHERE name = 'transition_version'
    `).get()).toEqual({ name: 'transition_version' });
    expect(database.raw.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'job_retry_reconciliations'
    `).get()).toEqual({ name: 'job_retry_reconciliations' });
    expect(database.raw.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'media_tool_trust'
    `).get()).toEqual({ name: 'media_tool_trust' });
    expect(database.raw.prepare(`
      SELECT name FROM pragma_table_info('publication_records') WHERE name = 'final_render_id'
    `).get()).toEqual({ name: 'final_render_id' });
    expect(database.raw.prepare(`
      SELECT name FROM pragma_table_info('publication_records') WHERE name = 'snapshot_status'
    `).get()).toEqual({ name: 'snapshot_status' });
    const now = new Date().toISOString();
    database.raw.prepare(`INSERT INTO projects(id, sequence, slug, title, topic, state, progress, envato_project_name, target_duration_ms, created_at, updated_at) VALUES('claim-project', 99, 'claim-project', 'Claims', 'Claims', 'CREATED', 0, 'YT-CLAIMS', 1000, ?, ?)`).run(now, now);
    database.raw.prepare(`
      INSERT INTO project_guidance(
        project_id, mode, starting_script, starting_script_sha256,
        resolved_destination_key, resolved_destination, resolved_topic_title,
        resolved_target_duration_ms, constraints_json, created_at
      ) VALUES('claim-project', 'guided', 'Editorial seed', 'seed-hash',
        'france|paris', 'Paris', 'Claims', 60000, '{}', ?)
    `).run(now);
    expect(() => database.raw.prepare(`
      UPDATE project_guidance SET starting_script = 'Rewritten seed' WHERE project_id = 'claim-project'
    `).run()).toThrow('immutable');
    expect(() => database.raw.prepare(`INSERT INTO fact_claims(id, project_id, text, category, confidence, stability, source_ids_json, status, created_at) VALUES('claim-without-source', 'claim-project', 'Unsupported', 'other', 1, 'stable', '[]', 'accepted', ?)`).run(now)).toThrow('staged');
    expect(database.integrityCheck()).toBe('ok');

    database.close();

    const reopened = new AppDatabase(join(root, 'videofactory.sqlite'));
    expect(reopened.raw.prepare('SELECT count(*) AS count FROM schema_migrations').get())
      .toEqual({ count: 23 });
    expect(reopened.integrityCheck()).toBe('ok');
    reopened.close();
  });

  it('upgrades an existing schema-18 database without changing its application records', () => {
    const root = mkdtempSync(join(tmpdir(), 'videofactory-migrations-upgrade-'));
    roots.push(root);
    const path = join(root, 'videofactory.sqlite');
    const legacy = new SqliteConnection(path);
    const migrations = readdirSync(join(process.cwd(), 'src', 'main', 'database'))
      .filter(name => /^\d{3}_.+\.sql$/.test(name) && Number(name.slice(0, 3)) <= 18)
      .sort();
    for (const name of migrations) {
      legacy.exec(readFileSync(join(process.cwd(), 'src', 'main', 'database', name), 'utf8'));
      legacy.prepare(`INSERT OR IGNORE INTO schema_migrations(version, name) VALUES(?, ?)`).run(
        Number(name.slice(0, 3)), name.replace(/^\d{3}_|\.sql$/g, '')
      );
    }
    const now = new Date().toISOString();
    legacy.prepare(`
      INSERT INTO projects(
        id, sequence, slug, title, topic, state, progress, envato_project_name,
        target_duration_ms, created_at, updated_at
      ) VALUES('legacy-project', 1, 'legacy-project', 'Legacy', 'Legacy', 'CREATED', 0,
        'YT-LEGACY', 60000, ?, ?)
    `).run(now, now);
    for (const [id, profile, sha256] of [
      ['legacy-unique-render', 'final_1080p', 'unique-sha'],
      ['legacy-stale-render', 'final_1080p', 'stale-sha'],
      ['legacy-ambiguous-a', 'final_1080p', 'ambiguous-sha'],
      ['legacy-ambiguous-b', 'final_4k', 'ambiguous-sha']
    ] as const) {
      legacy.prepare(`
        INSERT INTO renders(
          id, project_id, kind, profile, state, output_path, sha256, created_at, completed_at
        ) VALUES(?, 'legacy-project', 'final', ?, 'SUCCEEDED', ?, ?, ?, ?)
      `).run(id, profile, join(root, `${id}.mp4`), sha256, now, now);
    }
    legacy.prepare(`UPDATE projects SET final_render_id = 'legacy-unique-render' WHERE id = 'legacy-project'`).run();
    legacy.prepare(`
      INSERT INTO publication_records(
        id, project_id, channel_id, video_id, privacy_status, final_sha256,
        approval_hash, approved_at, created_at, updated_at
      ) VALUES('legacy-unique-publication', 'legacy-project', 'legacy-channel', 'unique-video',
        'private', 'unique-sha', 'unique-approval', ?, ?, ?)
    `).run(now, now, now);
    legacy.prepare(`
      INSERT INTO publication_records(
        id, project_id, channel_id, video_id, privacy_status, final_sha256,
        approval_hash, approved_at, scheduled_at, published_at, created_at, updated_at
      ) VALUES('legacy-stale-publication', 'legacy-project', 'legacy-channel', 'stale-video',
        'public', 'stale-sha', 'stale-approval', ?, ?, ?, ?, ?)
    `).run(now, now, now, now, now);
    legacy.prepare(`
      INSERT INTO publication_records(
        id, project_id, channel_id, video_id, privacy_status, final_sha256,
        approval_hash, approved_at, created_at, updated_at
      ) VALUES('legacy-ambiguous-publication', 'legacy-project', 'legacy-channel', 'ambiguous-video',
        'private', 'ambiguous-sha', 'ambiguous-approval', ?, ?, ?)
    `).run(now, now, now);
    legacy.prepare(`
      INSERT INTO provider_health(provider, status, status_code, message, checked_at, metadata_json)
      VALUES('tavily', 'auth_invalid', 401, 'Legacy invalid credential', ?, '{}')
    `).run(now);
    legacy.close();

    const upgraded = new AppDatabase(path);
    expect(upgraded.raw.prepare(`SELECT title FROM projects WHERE id = 'legacy-project'`).get())
      .toEqual({ title: 'Legacy' });
    expect(upgraded.raw.prepare(`SELECT version, name FROM schema_migrations ORDER BY version DESC LIMIT 1`).get())
      .toEqual({ version: 23, name: 'active_final_publication' });
    expect(upgraded.raw.prepare(`SELECT count(*) AS count FROM youtube_connection_binding`).get())
      .toEqual({ count: 0 });
    expect(upgraded.raw.prepare(`SELECT count(*) AS count FROM provider_endpoint_bindings`).get())
      .toEqual({ count: 0 });
    expect(upgraded.raw.prepare(`SELECT status, status_code FROM provider_health WHERE provider = 'tavily'`).get())
      .toEqual({ status: 'auth_invalid', status_code: 401 });
    expect(upgraded.raw.prepare(`
      SELECT final_render_id, snapshot_version, snapshot_status, approval_hash
      FROM publication_records WHERE id = 'legacy-unique-publication'
    `).get()).toEqual({
      final_render_id: 'legacy-unique-render',
      snapshot_version: 1,
      snapshot_status: 'current',
      approval_hash: 'unique-approval'
    });
    expect(upgraded.raw.prepare(`
      SELECT final_render_id, snapshot_status, privacy_status, approval_hash,
        approved_at, scheduled_at, published_at, error
      FROM publication_records WHERE id = 'legacy-stale-publication'
    `).get()).toEqual({
      final_render_id: 'legacy-stale-render',
      snapshot_status: 'stale',
      privacy_status: 'private',
      approval_hash: null,
      approved_at: null,
      scheduled_at: null,
      published_at: null,
      error: 'Legacy publication targets a non-active final render; private re-upload and review are required.'
    });
    expect(upgraded.raw.prepare(`
      SELECT final_render_id, snapshot_version, snapshot_status, approval_hash, error
      FROM publication_records WHERE id = 'legacy-ambiguous-publication'
    `).get()).toEqual({
      final_render_id: null,
      snapshot_version: 0,
      snapshot_status: 'legacy_unbound',
      approval_hash: null,
      error: 'Legacy publication could not be bound to one final render; private re-upload and review are required.'
    });
    expect(upgraded.integrityCheck()).toBe('ok');
    upgraded.close();
  });
});
