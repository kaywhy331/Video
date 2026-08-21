import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase } from '@main/database/database';
import { AcquisitionService, validateEnvatoUrl } from '@main/services/acquisition-service';
import { MediaService } from '@main/services/media-service';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'videofactory-acquisition-'));
  roots.push(root);
  const db = new AppDatabase(join(root, 'videofactory.sqlite'));
  const now = new Date().toISOString();
  db.raw.prepare(`
    INSERT INTO projects(
      id, sequence, slug, title, topic, state, progress,
      envato_project_name, target_duration_ms, created_at, updated_at
    ) VALUES('project-1', 1, 'project-1', 'Project 1', 'Project 1',
      'WAITING_FOR_DOWNLOADS', 0.3, 'YT-PROJECT-1', 300000, ?, ?)
  `).run(now, now);

  for (const index of [1, 2]) {
    db.raw.prepare(`
      INSERT INTO assets(
        id, stable_key, title, canonical_page_url, orientation,
        location_granularity, location_confidence, verification_status,
        availability_status, local_file_id, raw_row_json, imported_at, updated_at
      ) VALUES(?, ?, ?, ?, 'landscape', 'unknown', 0.5, 'metadata',
        'available', ?, '{}', ?, ?)
    `).run(
      `asset-${index}`,
      `asset-${index}`,
      `Asset ${index}`,
      `https://elements.envato.com/asset-${index}`,
      index === 1 ? 'file-local' : null,
      now,
      now
    );
    db.raw.prepare(`
      INSERT INTO acquisition_items(
        id, project_id, asset_id, ordinal, role, state, license_state,
        source_url, required_scene_ordinals_json, match_score, reasons_json,
        created_at, updated_at
      ) VALUES(?, 'project-1', ?, ?, ?, ?, 'PENDING', ?, ?, 90, '[]', ?, ?)
    `).run(
      `acquisition-${index}`,
      `asset-${index}`,
      index,
      index === 1 ? 'license_only' : 'primary',
      index === 1 ? 'LICENSE_ONLY_PENDING' : 'WAITING_FOR_FILE',
      `https://elements.envato.com/asset-${index}`,
      JSON.stringify([index]),
      now,
      now
    );
    db.raw.prepare(`
      INSERT INTO project_licenses(
        id, project_id, asset_id, license_state, envato_project_name,
        created_at, updated_at
      ) VALUES(?, 'project-1', ?, 'PENDING', 'YT-PROJECT-1', ?, ?)
    `).run(`license-${index}`, `asset-${index}`, now, now);
  }

  const media = {
    verifyLocalAsset: vi.fn(async () => undefined),
    reconcileAcquisition: vi.fn(async () => undefined)
  };
  return { db, root, media, service: new AcquisitionService(db, media as never) };
}

describe('project license attestation', () => {
  it('[ACQ-002] accepts only credential-free HTTPS Envato acquisition URLs', () => {
    expect(validateEnvatoUrl('https://elements.envato.com/clip-ABCDE').hostname)
      .toBe('elements.envato.com');
    for (const unsafe of [
      'http://elements.envato.com/clip-ABCDE',
      'https://user:password@elements.envato.com/clip-ABCDE',
      'https://evil.example/clip-ABCDE',
      'javascript:alert(1)',
      'file:///tmp/clip.mp4'
    ]) {
      expect(() => validateEnvatoUrl(unsafe)).toThrow();
    }
  });

  it('atomically attaches one certificate and only completes license-only local assets', async () => {
    const { db, root, media, service } = fixture();
    const certificatePath = join(root, 'envato-license.pdf');
    writeFileSync(certificatePath, 'license certificate');

    const result = await service.attestProject('project-1', certificatePath);

    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'acquisition-1',
        state: 'COMPLETE',
        licenseState: 'CERTIFICATE_ATTACHED'
      }),
      expect.objectContaining({
        id: 'acquisition-2',
        state: 'WAITING_FOR_FILE',
        licenseState: 'CERTIFICATE_ATTACHED'
      })
    ]));
    expect(db.raw.prepare(`
      SELECT asset_id, license_state, certificate_path, operator_attested_at
      FROM project_licenses ORDER BY asset_id
    `).all()).toEqual([
      {
        asset_id: 'asset-1',
        license_state: 'CERTIFICATE_ATTACHED',
        certificate_path: certificatePath,
        operator_attested_at: expect.any(String)
      },
      {
        asset_id: 'asset-2',
        license_state: 'CERTIFICATE_ATTACHED',
        certificate_path: certificatePath,
        operator_attested_at: expect.any(String)
      }
    ]);
    expect(media.verifyLocalAsset).toHaveBeenCalledOnce();
    expect(media.verifyLocalAsset).toHaveBeenCalledWith('project-1', 'asset-1', 'file-local');
    expect(media.reconcileAcquisition).toHaveBeenCalledWith('project-1');
    const receipt = db.raw.prepare(`
      SELECT action, entity_type, entity_id, metadata_json
      FROM audit_log WHERE project_id = 'project-1'
    `).get() as Record<string, unknown>;
    expect(receipt).toMatchObject({
      action: 'license.batch_attested',
      entity_type: 'project',
      entity_id: 'project-1'
    });
    expect(JSON.parse(String(receipt.metadata_json))).toMatchObject({
      count: 2,
      certificateAttached: true,
      certificateName: 'envato-license.pdf'
    });
    expect(db.integrityCheck()).toBe('ok');
    db.close();
  });

  it('rolls back every item, license, and receipt when any batch update fails', async () => {
    const { db, media, service } = fixture();
    db.raw.exec(`
      CREATE TRIGGER abort_second_license
      BEFORE UPDATE ON project_licenses
      WHEN OLD.asset_id = 'asset-2'
      BEGIN
        SELECT RAISE(ABORT, 'fixture batch failure');
      END;
    `);

    await expect(service.attestProject('project-1')).rejects.toThrow('fixture batch failure');
    expect(db.raw.prepare(`
      SELECT id, state, license_state FROM acquisition_items ORDER BY id
    `).all()).toEqual([
      { id: 'acquisition-1', state: 'LICENSE_ONLY_PENDING', license_state: 'PENDING' },
      { id: 'acquisition-2', state: 'WAITING_FOR_FILE', license_state: 'PENDING' }
    ]);
    expect(db.raw.prepare(`
      SELECT id, license_state, certificate_path, operator_attested_at
      FROM project_licenses ORDER BY id
    `).all()).toEqual([
      { id: 'license-1', license_state: 'PENDING', certificate_path: null, operator_attested_at: null },
      { id: 'license-2', license_state: 'PENDING', certificate_path: null, operator_attested_at: null }
    ]);
    expect(db.raw.prepare(`SELECT count(*) AS count FROM audit_log`).get()).toEqual({ count: 0 });
    expect(media.verifyLocalAsset).not.toHaveBeenCalled();
    expect(media.reconcileAcquisition).not.toHaveBeenCalled();
    expect(db.integrityCheck()).toBe('ok');
    db.close();
  });

  it('records the license but does not complete or advance a license-only item when verification fails', async () => {
    const { db, media, service } = fixture();
    media.verifyLocalAsset.mockRejectedValueOnce(new Error('semantic verification failed'));

    await expect(service.attestProject('project-1')).rejects.toThrow('semantic verification failed');
    expect(db.raw.prepare(`
      SELECT state, license_state FROM acquisition_items WHERE id = 'acquisition-1'
    `).get()).toEqual({ state: 'LICENSE_ONLY_PENDING', license_state: 'OPERATOR_ATTESTED' });
    expect(db.raw.prepare(`
      SELECT license_state, operator_attested_at FROM project_licenses WHERE id = 'license-1'
    `).get()).toEqual({ license_state: 'OPERATOR_ATTESTED', operator_attested_at: expect.any(String) });
    expect(media.reconcileAcquisition).not.toHaveBeenCalled();
    expect(db.raw.prepare(`SELECT state FROM projects WHERE id = 'project-1'`).get())
      .toEqual({ state: 'WAITING_FOR_DOWNLOADS' });
    db.close();
  });

  it('never overwrites conflict or terminal license decisions', async () => {
    const { db, root, media, service } = fixture();
    db.raw.prepare(`UPDATE acquisition_items SET license_state = 'CONFLICT' WHERE id = 'acquisition-1'`).run();
    db.raw.prepare(`UPDATE project_licenses SET license_state = 'CONFLICT' WHERE id = 'license-1'`).run();
    db.raw.prepare(`UPDATE acquisition_items SET license_state = 'VERIFIED' WHERE id = 'acquisition-2'`).run();
    db.raw.prepare(`UPDATE project_licenses SET license_state = 'VERIFIED' WHERE id = 'license-2'`).run();
    const certificatePath = join(root, 'envato-license.pdf');
    writeFileSync(certificatePath, 'license certificate');

    await expect(service.attest('acquisition-1', certificatePath))
      .rejects.toThrow('pending or operator-attested');
    await expect(service.attest('acquisition-2')).rejects.toThrow('Only pending licenses');
    await expect(service.attestProject('project-1', certificatePath)).resolves.toHaveLength(2);
    expect(db.raw.prepare(`
      SELECT id, license_state FROM acquisition_items ORDER BY id
    `).all()).toEqual([
      { id: 'acquisition-1', license_state: 'CONFLICT' },
      { id: 'acquisition-2', license_state: 'VERIFIED' }
    ]);
    expect(media.verifyLocalAsset).not.toHaveBeenCalled();
    expect(media.reconcileAcquisition).not.toHaveBeenCalled();
    expect(db.raw.prepare(`SELECT count(*) AS count FROM audit_log`).get()).toEqual({ count: 0 });
    db.close();
  });

  it('upgrades operator-attested licenses with a certificate without repeating local verification', async () => {
    const { db, root, media, service } = fixture();
    await service.attestProject('project-1');
    media.verifyLocalAsset.mockClear();
    media.reconcileAcquisition.mockClear();
    const certificatePath = join(root, 'upgrade.pdf');
    writeFileSync(certificatePath, 'license certificate');

    await service.attestProject('project-1', certificatePath);

    expect(db.raw.prepare(`
      SELECT DISTINCT license_state, certificate_path FROM project_licenses
    `).all()).toEqual([{ license_state: 'CERTIFICATE_ATTACHED', certificate_path: certificatePath }]);
    expect(media.verifyLocalAsset).not.toHaveBeenCalled();
    expect(media.reconcileAcquisition).toHaveBeenCalledOnce();
    db.close();
  });

  it('rejects a missing certificate before changing license state', async () => {
    const { db, root, media, service } = fixture();

    await expect(service.attestProject('project-1', join(root, 'missing.pdf')))
      .rejects.toThrow('does not exist or is not a file');
    expect(db.raw.prepare(`
      SELECT DISTINCT license_state FROM acquisition_items
    `).all()).toEqual([{ license_state: 'PENDING' }]);
    expect(media.verifyLocalAsset).not.toHaveBeenCalled();
    expect(media.reconcileAcquisition).not.toHaveBeenCalled();
    db.close();
  });

  it('keeps a license pending when an already-known media file is ingested', async () => {
    const { db, root } = fixture();
    const bytes = 'existing catalog media';
    const detectedPath = join(root, 'download.mp4');
    const originalPath = join(root, 'library-original.mp4');
    writeFileSync(detectedPath, bytes);
    writeFileSync(originalPath, bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    db.raw.prepare(`
      INSERT INTO asset_files(
        id, asset_id, sha256, original_path, original_file_name,
        file_size_bytes, duration_ms, width, height, frame_rate, codec,
        audio_present, raw_ffprobe_json, pipeline_version, created_at
      ) VALUES('existing-file', 'asset-2', ?, ?, 'library-original.mp4',
        ?, 10000, 1920, 1080, 30, 'h264', 0, '{}', ?, ?)
    `).run(
      sha256,
      originalPath,
      Buffer.byteLength(bytes),
      MediaService.PIPELINE_VERSION,
      new Date().toISOString()
    );
    db.raw.prepare(`
      INSERT INTO media_segments(
        id, asset_file_id, start_ms, end_ms, duration_ms, quality_score,
        black_frame_risk, freeze_risk, effective_width, effective_height,
        eligible_1080p, eligible_4k, pipeline_version, created_at
      ) VALUES('existing-segment', 'existing-file', 0, 7000, 7000, 1,
        0, 0, 1920, 1080, 1, 0, ?, ?)
    `).run(MediaService.PIPELINE_VERSION, new Date().toISOString());
    const media = new MediaService(
      db,
      () => ({ mediaLibraryFolder: root } as never),
      {} as never,
      () => undefined
    );

    await media.ingestAcquisition('acquisition-2', detectedPath);

    expect(db.raw.prepare(`
      SELECT state, mapped_file_id, license_state FROM acquisition_items
      WHERE id = 'acquisition-2'
    `).get()).toEqual({
      state: 'COMPLETE',
      mapped_file_id: 'existing-file',
      license_state: 'PENDING'
    });
    expect(db.raw.prepare(`
      SELECT license_state, operator_attested_at FROM project_licenses WHERE id = 'license-2'
    `).get()).toEqual({ license_state: 'PENDING', operator_attested_at: null });
    expect(db.raw.prepare(`SELECT state FROM projects WHERE id = 'project-1'`).get())
      .toEqual({ state: 'WAITING_FOR_DOWNLOADS' });
    db.close();
  });
});
