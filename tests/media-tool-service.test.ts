import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase } from '@main/database/database';
import { buildDefaultSettings } from '@main/app-paths';
import { MediaToolService } from '@main/services/media-tool-service';
import { installMediaToolResolver } from '@main/tool-paths';
import { installProcessLaunchGuard } from '@main/services/process-utils';
import type { AppSettings, MediaToolRole } from '@shared/types';

const roots: string[] = [];

afterEach(() => {
  installProcessLaunchGuard(null);
  installMediaToolResolver(null);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function executable(root: string, role: MediaToolRole): string {
  const path = join(root, role);
  writeFileSync(path, `#!/bin/sh\nprintf '${role} version fixture-1.0\\n'\n`, 'utf8');
  chmodSync(path, 0o755);
  return path;
}

function fixture(): {
  root: string;
  db: AppDatabase;
  settings: () => AppSettings;
  service: MediaToolService;
} {
  const root = mkdtempSync(join(tmpdir(), 'videofactory-tool-trust-'));
  roots.push(root);
  const db = new AppDatabase(join(root, 'data', 'db.sqlite'));
  let current = buildDefaultSettings(root);
  const service = new MediaToolService(
    db,
    () => current,
    (role, path) => {
      current = { ...current, [role === 'ffmpeg' ? 'ffmpegPath' : 'ffprobePath']: path };
    },
    '0.1.0-test',
    false
  );
  installMediaToolResolver(service);
  installProcessLaunchGuard(path => service.guardLaunch(path));
  return { root, db, settings: () => current, service };
}

describe('device-local media tool trust', () => {
  it('[SYS-007][SYS-008] inspects without execution, probes after confirmation, and blocks a changed executable', async () => {
    const { root, db, settings, service } = fixture();
    const path = executable(root, 'ffmpeg');
    const inspection = await service.inspect('ffmpeg', path);

    expect(inspection).toMatchObject({
      role: 'ffmpeg',
      canonicalPath: path,
      detectedRole: 'ffmpeg',
      roleMatches: true,
      executableByCurrentUser: true,
      signature: { status: 'unavailable', subject: null }
    });
    expect(inspection.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(readFileSync(path, 'utf8')).toContain('fixture-1.0');

    const trustRequest = {
      role: 'ffmpeg',
      path,
      expectedSha256: inspection.sha256,
      acknowledgePermissions: true
    } as const;
    const trustOperation = service.trust(trustRequest);
    await expect(service.trust(trustRequest)).rejects.toThrow('already in progress');
    const trusted = await trustOperation;
    expect(trusted).toMatchObject({ source: 'custom', status: 'trusted', version: 'ffmpeg version fixture-1.0' });
    expect(settings().ffmpegPath).toBe(path);

    const packagedService = new MediaToolService(db, settings, () => undefined, '0.1.0-test', true);
    expect(packagedService.state('ffmpeg')).toMatchObject({
      source: 'bundled',
      status: 'trusted',
      configuredPath: path
    });
    expect(packagedService.state('ffmpeg').executablePath).not.toBe(path);

    const resolved = service.resolvePath('ffmpeg', settings().ffmpegPath);
    expect(resolved).toBe(path);
    writeFileSync(path, `#!/bin/sh\nprintf 'ffmpeg version changed\\n'\n`, 'utf8');
    chmodSync(path, 0o755);
    let changedError: unknown;
    try {
      service.guardLaunch(resolved as string);
    } catch (error) {
      changedError = error;
    }
    expect(changedError).toMatchObject({
      code: 'MEDIA_TOOL_HASH_CHANGED',
      recovery: expect.stringContaining('Inspect the executable again')
    });
    expect(String(changedError)).toContain('[MEDIA_TOOL_HASH_CHANGED]');
    expect(String(changedError)).toContain('SHA-256 changed before execution');
    expect(service.state('ffmpeg').status).toBe('changed');

    const audit = db.raw.prepare(`
      SELECT action, metadata_json FROM audit_log
      WHERE entity_type = 'media_tool' ORDER BY id
    `).all() as Array<{ action: string; metadata_json: string }>;
    expect(audit.map(row => row.action)).toContain('media_tool.execution_blocked');
    expect(audit.map(row => row.action)).toContain('security.privileged_rejected');
    expect(audit.some(row => row.metadata_json.includes(path))).toBe(false);
    const securityEvent = audit.find(row => row.action === 'security.privileged_rejected');
    expect(JSON.parse(securityEvent?.metadata_json ?? '{}')).toMatchObject({
      schemaVersion: 1,
      flow: 'media_tool',
      operation: 'trust.concurrent_change',
      code: 'MEDIA_TOOL_TRUST_IN_PROGRESS',
      outcome: 'rejected'
    });

    const cleared = service.clear('ffmpeg');
    expect(settings().ffmpegPath).toBe('');
    expect(cleared.source).not.toBe('custom');
    expect(db.raw.prepare('SELECT count(*) AS count FROM media_tool_trust').get()).toEqual({ count: 0 });

    const ffprobePath = executable(root, 'ffprobe');
    const ffprobeInspection = await service.inspect('ffprobe', ffprobePath);
    await service.trust({
      role: 'ffprobe',
      path: ffprobePath,
      expectedSha256: ffprobeInspection.sha256,
      acknowledgePermissions: true
    });
    const resolvedProbe = service.resolvePath('ffprobe', ffprobePath) as string;
    rmSync(ffprobePath);
    expect(() => service.guardLaunch(resolvedProbe)).toThrow('disappeared before launch');
    expect(service.state('ffprobe')).toMatchObject({ source: 'bundled', status: 'missing' });
    db.close();
  });

  it('quarantines legacy overrides and rejects role mismatches and non-files', async () => {
    const { root, db, settings, service } = fixture();
    const legacy = executable(root, 'ffprobe');
    const mutable = settings();
    mutable.ffprobePath = legacy;
    db.saveAppSettings(mutable);

    const quarantined = new MediaToolService(
      db,
      () => mutable,
      (role, path) => { mutable[role === 'ffmpeg' ? 'ffmpegPath' : 'ffprobePath'] = path; },
      '0.1.0-test',
      false
    );
    quarantined.quarantineLegacyOverrides();
    expect(db.raw.prepare('SELECT status FROM media_tool_trust WHERE role = ?').get('ffprobe'))
      .toEqual({ status: 'confirmation_required' });
    expect(quarantined.state('ffprobe')).toMatchObject({
      source: 'bundled',
      status: 'confirmation_required',
      configuredPath: legacy
    });
    expect(quarantined.state('ffprobe').executablePath).not.toBe(legacy);

    await expect(quarantined.inspect('ffmpeg', legacy)).resolves.toMatchObject({
      detectedRole: 'ffprobe',
      roleMatches: false
    });
    await expect(quarantined.inspect('ffmpeg', root)).rejects.toThrow('directory');
    await expect(quarantined.inspect('ffmpeg', 'relative/ffmpeg')).rejects.toThrow('absolute');
    await expect(quarantined.inspect('ffmpeg', join(root, 'missing-ffmpeg'))).rejects.toThrow('does not exist');
    if (process.platform !== 'win32') {
      const link = join(root, 'ffprobe-link');
      symlinkSync(legacy, link);
      await expect(quarantined.inspect('ffprobe', link)).resolves.toMatchObject({ canonicalPath: legacy });
      rmSync(legacy);
      await expect(quarantined.inspect('ffprobe', link)).rejects.toThrow('link could not be resolved');
    }
    db.close();
  });
});
