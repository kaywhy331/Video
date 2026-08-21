import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { XLSX } from '@shared/xlsx-node';
import { AppDatabase } from '@main/database/database';
import { CatalogService } from '@main/services/catalog-service';
import { PlaceService } from '@main/services/place-service';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(rows: Array<Record<string, unknown>>) {
  const root = mkdtempSync(join(tmpdir(), 'videofactory-catalog-evidence-'));
  roots.push(root);
  const filePath = join(root, 'catalog.xlsx');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'Catalog');
  XLSX.writeFile(workbook, filePath);
  const db = new AppDatabase(join(root, 'videofactory.sqlite'));
  const places = new PlaceService(db);
  const catalog = new CatalogService(db, places);
  return { root, filePath, db, places, catalog };
}

describe('catalog evidence and P0 metadata operations', () => {
  it('[CAT-002] imports equivalent CSV with identical canonical identities and effective values', () => {
    const rows = [
      { ID: '101', Page: 'https://elements.envato.com/paris-CSV01', Title: 'Paris, France', Country: 'France', City: 'Paris', Location: 'Eiffel Tower', Duration: '00:00:12' },
      { ID: '102', Page: 'https://elements.envato.com/lyon-CSV02', Title: 'Lyon river', Country: 'France', City: 'Lyon', Duration: '8.5 sec' }
    ];
    const value = fixture(rows);
    const xlsxPreview = value.catalog.previewImport(value.filePath);
    value.catalog.commitImport(value.filePath, xlsxPreview.selectedSheet, xlsxPreview.mapping, xlsxPreview.previewId);
    const before = value.db.raw.prepare(`
      SELECT id, stable_key, provider_asset_id, canonical_page_url, title, country, city,
        location_name, declared_duration_ms
      FROM assets ORDER BY stable_key
    `).all();

    const csvPath = join(value.root, 'catalog.csv');
    writeFileSync(csvPath, XLSX.utils.sheet_to_csv(XLSX.utils.json_to_sheet(rows)), 'utf8');
    const csvPreview = value.catalog.previewImport(csvPath);
    expect(csvPreview.mapping).toEqual(xlsxPreview.mapping);
    expect(csvPreview.diff).toMatchObject({ inserted: 0, changed: 0, unchanged: 2 });
    value.catalog.commitImport(csvPath, csvPreview.selectedSheet, csvPreview.mapping, csvPreview.previewId);
    expect(value.db.raw.prepare(`
      SELECT id, stable_key, provider_asset_id, canonical_page_url, title, country, city,
        location_name, declared_duration_ms
      FROM assets ORDER BY stable_key
    `).all()).toEqual(before);
    value.db.close();
  });

  it('[CAT-003] preserves canonical identities when source rows reorder and row IDs change', () => {
    const value = fixture([
      { ID: 'row-1', Page: 'https://elements.envato.com/paris-ABCDE', Title: 'Paris', Country: 'France' },
      { ID: 'row-2', Page: 'https://elements.envato.com/lyon-FGHIJ', Title: 'Lyon', Country: 'France' }
    ]);
    const firstPreview = value.catalog.previewImport(value.filePath);
    value.catalog.commitImport(
      value.filePath, firstPreview.selectedSheet, firstPreview.mapping, firstPreview.previewId
    );
    const before = value.catalog.search({ page: 1, pageSize: 10 }).rows
      .map(asset => ({ id: asset.id, url: asset.canonicalPageUrl }))
      .sort((left, right) => String(left.url).localeCompare(String(right.url)));

    const reordered = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(reordered, XLSX.utils.json_to_sheet([
      { ID: 'renumbered-200', Page: 'https://elements.envato.com/lyon-FGHIJ', Title: 'Lyon', Country: 'France' },
      { ID: 'renumbered-100', Page: 'https://elements.envato.com/paris-ABCDE', Title: 'Paris', Country: 'France' }
    ]), 'Catalog');
    XLSX.writeFile(reordered, value.filePath);
    const secondPreview = value.catalog.previewImport(value.filePath);
    expect(secondPreview.diff).toMatchObject({ inserted: 0, missing: 0, changed: 2 });
    value.catalog.commitImport(
      value.filePath, secondPreview.selectedSheet, secondPreview.mapping, secondPreview.previewId
    );
    expect(value.catalog.search({ page: 1, pageSize: 10 }).rows
      .map(asset => ({ id: asset.id, url: asset.canonicalPageUrl }))
      .sort((left, right) => String(left.url).localeCompare(String(right.url))))
      .toEqual(before);
    expect(value.catalog.stats().totalAssets).toBe(2);
    value.db.close();
  });

  it('requires a staged diff, preserves duplicate source rows, and reports missing assets without deleting them', () => {
    const value = fixture([
      { ID: '1', Page: 'https://elements.envato.com/paris-ABCDE', Title: 'Paris One', Country: 'France', City: 'Paris', Location: 'Eiffel Tower' },
      { ID: '2', Page: 'https://elements.envato.com/paris-ABCDE', Title: 'Duplicate source row', Country: 'France', City: 'Paris', Location: 'Eiffel Tower' },
      { ID: '3', Page: 'https://elements.envato.com/lyon-FGHIJ', Title: 'Lyon One', Country: 'France', City: 'Lyon' }
    ]);
    const preview = value.catalog.previewImport(value.filePath);
    expect(preview.diff).toMatchObject({ inserted: 2, changed: 0, missing: 0, invalid: 0 });
    expect(() => value.catalog.commitImport(value.filePath, preview.selectedSheet, preview.mapping))
      .toThrow('staged import preview');
    const first = value.catalog.commitImport(value.filePath, preview.selectedSheet, preview.mapping, preview.previewId);
    expect(first).toMatchObject({ inserted: 2, updated: 0, missing: 0, total: 3 });
    expect(value.db.raw.prepare(`SELECT count(*) AS count FROM catalog_import_rows WHERE import_id = ?`).get(first.importId))
      .toEqual({ count: 3 });
    expect(value.db.raw.prepare(`SELECT count(*) AS count FROM catalog_import_rows WHERE import_id = ? AND disposition = 'duplicate'`).get(first.importId))
      .toEqual({ count: 1 });

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([
      { ID: '1', Page: 'https://elements.envato.com/paris-ABCDE', Title: 'Paris Updated', Country: 'France', City: 'Paris', Location: 'Eiffel Tower' }
    ]), 'Catalog');
    XLSX.writeFile(workbook, value.filePath);
    const secondPreview = value.catalog.previewImport(value.filePath);
    expect(secondPreview.diff).toMatchObject({ changed: 1, missing: 1 });
    const second = value.catalog.commitImport(value.filePath, secondPreview.selectedSheet, secondPreview.mapping, secondPreview.previewId);
    expect(second.missing).toBe(1);
    expect(value.catalog.stats().totalAssets).toBe(2);
    expect(value.db.raw.prepare(`SELECT count(*) AS count FROM catalog_import_rows WHERE import_id = ? AND disposition = 'missing'`).get(second.importId))
      .toEqual({ count: 1 });
    value.db.close();
  });

  it('cancels staged imports without changing assets and rolls failed commits back atomically', () => {
    const cancelled = fixture([
      { ID: '1', Page: 'https://elements.envato.com/paris-ABCDE', Title: 'Paris' }
    ]);
    const cancelledPreview = cancelled.catalog.previewImport(cancelled.filePath);
    expect(cancelled.catalog.cancelImportPreview(cancelledPreview.previewId)).toBe(true);
    expect(cancelled.catalog.cancelImportPreview(cancelledPreview.previewId)).toBe(false);
    expect(() => cancelled.catalog.commitImport(
      cancelled.filePath, cancelledPreview.selectedSheet, cancelledPreview.mapping, cancelledPreview.previewId
    )).toThrow('staged import preview');
    expect(cancelled.catalog.stats().totalAssets).toBe(0);
    expect(cancelled.db.raw.prepare('SELECT status FROM catalog_import_previews WHERE id = ?').get(cancelledPreview.previewId))
      .toEqual({ status: 'cancelled' });
    cancelled.db.close();

    const failed = fixture([
      { ID: '2', Page: 'https://elements.envato.com/lyon-FGHIJ', Title: 'Lyon', Country: 'France' }
    ]);
    const failedPreview = failed.catalog.previewImport(failed.filePath);
    failed.db.raw.exec(`
      CREATE TRIGGER inject_catalog_metadata_failure
      BEFORE INSERT ON asset_metadata_assertions
      WHEN NEW.field_name = 'title'
      BEGIN
        SELECT RAISE(ABORT, 'injected catalog failure');
      END;
    `);
    expect(() => failed.catalog.commitImport(
      failed.filePath, failedPreview.selectedSheet, failedPreview.mapping, failedPreview.previewId
    )).toThrow('injected catalog failure');
    expect(failed.catalog.stats().totalAssets).toBe(0);
    expect(failed.db.raw.prepare('SELECT status, error FROM catalog_imports ORDER BY started_at DESC LIMIT 1').get())
      .toEqual({ status: 'failed', error: 'injected catalog failure' });
    expect(failed.db.raw.prepare('SELECT count(*) AS count FROM catalog_import_rows').get()).toEqual({ count: 0 });
    expect(failed.db.raw.prepare('SELECT status FROM catalog_import_previews WHERE id = ?').get(failedPreview.previewId))
      .toEqual({ status: 'staged' });
    expect(failed.db.integrityCheck()).toBe('ok');
    failed.db.close();
  });

  it('cooperatively cancels an active commit and rolls its transaction back', () => {
    const value = fixture([
      { ID: '1', Page: 'https://elements.envato.com/paris-ABCDE', Title: 'Paris' },
      { ID: '2', Page: 'https://elements.envato.com/lyon-FGHIJ', Title: 'Lyon' }
    ]);
    const preview = value.catalog.previewImport(value.filePath);
    let checkpoints = 0;
    const progress: string[] = [];
    const cancellingCatalog = new CatalogService(value.db, value.places, {
      isCancelled: () => ++checkpoints > 3,
      onProgress: (_value, phase) => progress.push(phase)
    });

    expect(() => cancellingCatalog.commitImport(
      value.filePath, preview.selectedSheet, preview.mapping, preview.previewId
    )).toThrow('cancelled by the operator');
    expect(progress).toContain('commit_assets');
    expect(value.db.raw.prepare(`SELECT count(*) AS count FROM assets`).get()).toEqual({ count: 0 });
    expect(value.db.raw.prepare(`SELECT count(*) AS count FROM catalog_import_rows`).get()).toEqual({ count: 0 });
    expect(value.db.raw.prepare(`
      SELECT status, error FROM catalog_imports ORDER BY started_at DESC LIMIT 1
    `).get()).toEqual({
      status: 'cancelled',
      error: 'Catalog import cancelled by the operator.'
    });
    expect(value.db.raw.prepare(`
      SELECT status FROM catalog_import_previews WHERE id = ?
    `).get(preview.previewId)).toEqual({ status: 'staged' });
    expect(value.db.integrityCheck()).toBe('ok');
    value.db.close();
  });

  it('reports missing rows only against the latest successful import from the same source', () => {
    const value = fixture([
      { ID: '1', Page: 'https://elements.envato.com/paris-ABCDE', Title: 'Paris' },
      { ID: '2', Page: 'https://elements.envato.com/lyon-FGHIJ', Title: 'Lyon' }
    ]);
    const sourceAPreview = value.catalog.previewImport(value.filePath);
    value.catalog.commitImport(value.filePath, sourceAPreview.selectedSheet, sourceAPreview.mapping, sourceAPreview.previewId);

    const sourceB = join(value.root, 'second-catalog.xlsx');
    const secondWorkbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(secondWorkbook, XLSX.utils.json_to_sheet([
      { ID: '3', Page: 'https://elements.envato.com/rome-KLMNO', Title: 'Rome' }
    ]), 'Catalog');
    XLSX.writeFile(secondWorkbook, sourceB);
    const sourceBPreview = value.catalog.previewImport(sourceB);
    expect(sourceBPreview.diff.missing).toBe(0);
    value.catalog.commitImport(sourceB, sourceBPreview.selectedSheet, sourceBPreview.mapping, sourceBPreview.previewId);

    const reducedWorkbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(reducedWorkbook, XLSX.utils.json_to_sheet([
      { ID: '1', Page: 'https://elements.envato.com/paris-ABCDE', Title: 'Paris' }
    ]), 'Catalog');
    XLSX.writeFile(reducedWorkbook, value.filePath);
    const reducedPreview = value.catalog.previewImport(value.filePath);
    expect(reducedPreview.diff.missing).toBe(1);
    expect(reducedPreview.diff.sampleMissing).toEqual(['Lyon']);
    const reduced = value.catalog.commitImport(
      value.filePath, reducedPreview.selectedSheet, reducedPreview.mapping, reducedPreview.previewId
    );
    expect(reduced.missing).toBe(1);
    expect(value.catalog.stats().totalAssets).toBe(3);
    value.db.close();
  });

  it('does not report a reconciled legacy identity as missing', () => {
    const value = fixture([
      { ID: '1', Page: 'https://elements.envato.com/paris-ABCDE', Title: 'Paris' }
    ]);
    const firstPreview = value.catalog.previewImport(value.filePath);
    const first = value.catalog.commitImport(
      value.filePath, firstPreview.selectedSheet, firstPreview.mapping, firstPreview.previewId
    );
    const asset = value.catalog.search({ page: 1, pageSize: 10 }).rows[0]!;
    const legacyStableKey = 'legacy-descriptive-key';
    value.db.raw.prepare('UPDATE assets SET stable_key = ? WHERE id = ?').run(legacyStableKey, asset.id);
    value.db.raw.prepare(`
      UPDATE catalog_import_rows SET stable_key = ? WHERE import_id = ? AND asset_id = ?
    `).run(legacyStableKey, first.importId, asset.id);

    const nextPreview = value.catalog.previewImport(value.filePath);
    expect(nextPreview.diff).toMatchObject({ inserted: 0, missing: 0, unchanged: 1 });
    const next = value.catalog.commitImport(
      value.filePath, nextPreview.selectedSheet, nextPreview.mapping, nextPreview.previewId
    );
    expect(next).toMatchObject({ inserted: 0, missing: 0, unchanged: 1 });
    expect(value.catalog.stats().totalAssets).toBe(1);
    value.db.close();
  });

  it('enforces human-over-normalized-over-accepted-AI-over-raw precedence and reviews suggestions', () => {
    const value = fixture([
      { ID: '1', Page: 'https://elements.envato.com/paris-ABCDE', Title: 'Imported title', Country: 'France', City: 'Paris' }
    ]);
    const preview = value.catalog.previewImport(value.filePath);
    value.catalog.commitImport(value.filePath, preview.selectedSheet, preview.mapping, preview.previewId);
    const asset = value.catalog.search({ page: 1, pageSize: 10 }).rows[0]!;
    const suggestion = value.catalog.metadata.propose({
      assetId: asset.id, fieldName: 'title', value: 'AI title', provider: 'fixture', model: 'fixture-v1', confidence: 0.99
    });
    expect(value.catalog.metadata.inbox()).toEqual([
      expect.objectContaining({ id: suggestion.id, assetTitle: 'Imported title', verificationState: 'proposed' })
    ]);
    value.catalog.metadata.review(suggestion.id, 'accept');
    expect(value.catalog.metadata.inbox()).toEqual([]);
    expect(value.catalog.search({ page: 1, pageSize: 10 }).rows[0]!.title).toBe('Imported title');
    value.catalog.updateAsset(asset.id, { title: 'Human title' }, 'verified correction');
    expect(value.catalog.search({ page: 1, pageSize: 10 }).rows[0]!.title).toBe('Human title');
    expect(value.catalog.metadata.list(asset.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldName: 'title', layer: 'raw' }),
      expect.objectContaining({ fieldName: 'title', layer: 'normalized' }),
      expect.objectContaining({ fieldName: 'title', layer: 'ai', verificationState: 'accepted', effective: false }),
      expect.objectContaining({ fieldName: 'title', layer: 'human', effective: true })
    ]));
    value.db.close();
  });

  it('[CAT-008][CAT-010][UX-004] ranks grounded fields and transactionally updates and restores FTS metadata', () => {
    const value = fixture([
      {
        ID: '1', Page: 'https://elements.envato.com/palenque-ABCDE',
        Title: 'Ancient site walk', Country: 'Mexico', City: 'Palenque',
        Location: 'Temple of the Inscriptions', Activity: 'walking', Objects: 'stone temple'
      },
      {
        ID: '2', Page: 'https://elements.envato.com/cancun-FGHIJ',
        Title: 'Mexico stone temple walking tour', Country: 'Mexico', City: 'Cancun',
        Location: 'Hotel district', Activity: 'touring', Objects: 'buildings'
      }
    ]);
    const preview = value.catalog.previewImport(value.filePath);
    value.catalog.commitImport(value.filePath, preview.selectedSheet, preview.mapping, preview.previewId);
    const palenque = value.catalog.search({
      query: 'stone temple walking', page: 1, pageSize: 10
    }).rows[0]!;
    expect(palenque.locationName).toBe('Temple of the Inscriptions');

    value.catalog.updateAsset(palenque.id, { locationName: 'Restoration workshop' }, 'Correct location');
    expect(value.catalog.search({ query: 'Inscriptions', page: 1, pageSize: 10 }).rows).toEqual([]);
    expect(value.catalog.search({ query: 'Restoration', page: 1, pageSize: 10 }).rows)
      .toEqual([expect.objectContaining({ id: palenque.id })]);

    const revision = value.catalog.revisions(palenque.id)
      .find(item => item.fieldName === 'locationName' && item.reason === 'Correct location');
    expect(revision).toBeDefined();
    expect(value.catalog.revertRevision(revision!.id)).toMatchObject({
      id: palenque.id,
      locationName: 'Temple of the Inscriptions'
    });
    expect(value.catalog.search({ query: 'Inscriptions', page: 1, pageSize: 10 }).rows)
      .toEqual([expect.objectContaining({ id: palenque.id })]);
    expect(value.catalog.revisions(palenque.id).find(item => item.id === revision!.id)?.revertedAt)
      .toEqual(expect.any(String));
    value.db.close();
  });

  it('bulk edits and exports exactly the filtered catalog rows with a checksum receipt', () => {
    const value = fixture([
      { ID: '1', Page: 'https://elements.envato.com/france-ABCDE', Title: 'France', Country: 'France' },
      { ID: '2', Page: 'https://elements.envato.com/italy-FGHIJ', Title: 'Italy', Country: 'Italy' }
    ]);
    const preview = value.catalog.previewImport(value.filePath);
    value.catalog.commitImport(value.filePath, preview.selectedSheet, preview.mapping, preview.previewId);
    const ids = value.catalog.search({ page: 1, pageSize: 10 }).rows.map(asset => asset.id);
    value.catalog.bulkUpdateAssets(ids, { style: 'Documentary' }, 'batch classification');
    const output = join(value.root, 'france.csv');
    const report = value.catalog.exportFiltered({ country: 'France', page: 1, pageSize: 10 }, output);
    expect(existsSync(output)).toBe(true);
    expect(report.rowCount).toBe(1);
    expect(readFileSync(output, 'utf8')).toContain('France');
    expect(readFileSync(output, 'utf8')).not.toContain('Italy');
    expect(value.db.raw.prepare('SELECT row_count, sha256 FROM catalog_exports WHERE id = ?').get(report.id))
      .toEqual({ row_count: 1, sha256: report.sha256 });
    value.db.close();
  });

  it('filters by verification, confidence, use, license, and technical media state', () => {
    const value = fixture([
      { ID: '1', Page: 'https://elements.envato.com/paris-ABCDE', Title: 'Paris', Country: 'France', Location: 'Tower' },
      { ID: '2', Page: 'https://elements.envato.com/lyon-FGHIJ', Title: 'Lyon', Country: 'France' }
    ]);
    const preview = value.catalog.previewImport(value.filePath);
    value.catalog.commitImport(value.filePath, preview.selectedSheet, preview.mapping, preview.previewId);
    const assets = value.catalog.search({ page: 1, pageSize: 10, sortBy: 'title', sortDirection: 'asc' }).rows;
    const paris = assets.find(asset => asset.title === 'Paris')!;
    const lyon = assets.find(asset => asset.title === 'Lyon')!;
    value.catalog.updateAsset(paris!.id, { verificationStatus: 'human_verified', locationConfidence: 1 }, 'verified');
    const now = new Date().toISOString();
    value.db.raw.prepare(`
      INSERT INTO projects(id, sequence, slug, title, topic, state, progress, envato_project_name, target_duration_ms, created_at, updated_at)
      VALUES('project-filter', 1, 'filter', 'Filter', 'Filter', 'CREATED', 0, 'YT-FILTER', 1000, ?, ?)
    `).run(now, now);
    value.db.raw.prepare(`
      INSERT INTO project_scenes(id, project_id, ordinal, narration, target_duration_ms,
        required_granularity, required_objects_json, required_activities_json,
        preferred_shots_json, visual_treatment, selected_asset_id, verification_state, created_at, updated_at)
      VALUES('scene-filter', 'project-filter', 1, 'Filter', 2000, 'landmark', '[]', '[]', '[]',
        'EXACT_LOCATION_FOOTAGE', ?, 'verified', ?, ?)
    `).run(paris!.id, now, now);
    value.db.raw.prepare(`
      INSERT INTO project_licenses(id, project_id, asset_id, license_state, envato_project_name, created_at, updated_at)
      VALUES('license-filter', 'project-filter', ?, 'VERIFIED', 'YT-FILTER', ?, ?)
    `).run(paris!.id, now, now);
    value.db.raw.prepare(`
      INSERT INTO asset_files(id, asset_id, sha256, original_path, original_file_name, file_size_bytes,
        duration_ms, width, height, frame_rate, codec, raw_ffprobe_json, pipeline_version, created_at)
      VALUES('file-filter', ?, 'filter-sha', '/tmp/filter.mp4', 'filter.mp4', 1000,
        5000, 3840, 2160, 30, 'h264', '{}', 'fixture', ?)
    `).run(paris!.id, now);
    value.db.raw.prepare('UPDATE assets SET local_file_id = ? WHERE id = ?').run('file-filter', paris!.id);
    value.db.raw.prepare(`
      INSERT INTO media_segments(id, asset_file_id, start_ms, end_ms, duration_ms, quality_score,
        effective_width, effective_height, eligible_1080p, eligible_4k, pipeline_version, created_at)
      VALUES('segment-filter', 'file-filter', 0, 3000, 3000, 1, 3840, 2160, 1, 1, 'fixture', ?)
    `).run(now);

    const filtered = value.catalog.search({
      verificationStatus: 'human_verified', minimumLocationConfidence: 0.9,
      used: true, licensed: true, mediaStatus: 'usable_4k', page: 1, pageSize: 10
    });
    expect(filtered.rows).toHaveLength(1);
    expect(filtered.rows[0]).toMatchObject({
      id: paris!.id, usedProjectCount: 1, licensedProjectCount: 1, mediaStatus: 'usable_4k'
    });
    expect(value.catalog.search({ used: false, licensed: false, mediaStatus: 'metadata_only', page: 1, pageSize: 10 }).rows)
      .toEqual([expect.objectContaining({ id: lyon!.id })]);
    expect(value.catalog.search({ metadataField: 'locationName', metadataValue: 'Tow', page: 1, pageSize: 10 }).rows)
      .toEqual([expect.objectContaining({ id: paris!.id })]);
    value.db.close();
  });

  it('stages scheduled refresh diffs only after a named validation template passes', () => {
    const value = fixture([
      { ID: '1', Page: 'https://elements.envato.com/paris-ABCDE', Title: 'Paris', Country: 'France' }
    ]);
    const firstPreview = value.catalog.previewImport(value.filePath);
    value.catalog.commitImport(value.filePath, firstPreview.selectedSheet, firstPreview.mapping, firstPreview.previewId);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([
      { ID: '1', Page: 'https://elements.envato.com/paris-ABCDE', Title: 'Paris Updated', Country: 'France' },
      { ID: '2', Page: 'https://elements.envato.com/lyon-FGHIJ', Title: 'Lyon', Country: 'France' }
    ]), 'Catalog');
    XLSX.writeFile(workbook, value.filePath);
    const run = value.catalog.refresh(value.filePath, 'strict-grounding');
    expect(run).toMatchObject({ status: 'staged', validation: { valid: true }, diff: { inserted: 1, changed: 1 } });
    expect(run.previewId).not.toBeNull();
    expect(value.catalog.stats().totalAssets).toBe(1);
    expect(value.catalog.latestRefresh()).toEqual(run);
    expect(value.catalog.validationTemplates()).toHaveLength(3);

    const blocked = value.catalog.refresh(value.filePath, 'technical-library');
    expect(blocked.status).toBe('blocked');
    expect(blocked.validation.issues).toContain('Required mapped field is missing: declaredResolution.');
    expect(value.catalog.stats().totalAssets).toBe(1);
    value.db.close();
  });
});
