import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase } from '@main/database/database';
import { SchedulerService } from '@main/services/scheduler-service';
import type { AppSettings, ProjectDetail } from '@shared/types';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('autopilot cadence scheduler', () => {
  it('pauses when disabled, blocks on recoverable gates, and creates only when manually due and clear', async () => {
    const root = mkdtempSync(join(tmpdir(), 'videofactory-scheduler-'));
    roots.push(root);
    const db = new AppDatabase(join(root, 'db.sqlite'));
    const settings = {
      autopilotSchedulerEnabled: false,
      autopilotCadenceDays: 7,
      autopilotPublicationHourUtc: 17,
      maxActiveProjects: 2,
      maxWaitingDownloads: 1,
      maxPrivateApproval: 1,
      monthlyBudgetUsd: 100,
      researchProvider: 'disabled',
      llmProvider: 'mock',
      visionProvider: 'disabled',
      narratorProvider: 'windows_sapi',
      mediaLibraryFolder: root,
      minFreeDiskGb: 0
    } as AppSettings;
    let created = 0;
    const service = new SchedulerService(db, () => settings, async () => {
      created += 1;
      const now = new Date().toISOString();
      db.raw.prepare(`
        INSERT INTO projects(
          id, sequence, slug, title, topic, state, progress, envato_project_name,
          target_duration_ms, created_at, updated_at
        ) VALUES('scheduled-project', 1, 'scheduled', 'Scheduled Project', 'Scheduled',
          'CREATED', 0, 'YT-SCHEDULED', 300000, ?, ?)
      `).run(now, now);
      return { id: 'scheduled-project', title: 'Scheduled Project' } as ProjectDetail;
    });

    expect(await service.evaluate('startup', new Date('2026-08-12T12:00:00.000Z')))
      .toMatchObject({ enabled: false, state: 'paused', reasonCode: 'operator_disabled' });
    settings.autopilotSchedulerEnabled = true;
    expect(await service.evaluate('manual', new Date('2026-08-12T12:05:00.000Z')))
      .toMatchObject({ state: 'blocked', reasonCode: 'empty_catalog' });
    const now = new Date().toISOString();
    db.raw.prepare(`
      INSERT INTO assets(
        id, stable_key, title, raw_row_json, imported_at, updated_at
      ) VALUES('asset-1', 'asset-1', 'Fixture asset', '{}', ?, ?)
    `).run(now, now);
    const status = await service.evaluate('manual', new Date('2026-08-12T12:10:00.000Z'));
    expect(status).toMatchObject({ enabled: true, state: 'running', lastProjectId: 'scheduled-project' });
    expect(status.nextRunAt).toBe('2026-08-19T17:00:00.000Z');
    expect(created).toBe(1);
    expect(db.raw.prepare('SELECT outcome FROM scheduler_runs ORDER BY created_at').all())
      .toEqual([{ outcome: 'paused' }, { outcome: 'blocked' }, { outcome: 'created' }]);
    db.close();
  });

  it('resumes the oldest runnable project before disabled creation, cadence, and queue limits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'videofactory-scheduler-resume-'));
    roots.push(root);
    const db = new AppDatabase(join(root, 'db.sqlite'));
    const settings = {
      autopilotSchedulerEnabled: false,
      autopilotCadenceDays: 7,
      autopilotPublicationHourUtc: 17,
      maxActiveProjects: 0,
      maxWaitingDownloads: 0,
      maxPrivateApproval: 0,
      monthlyBudgetUsd: 100,
      researchProvider: 'disabled',
      llmProvider: 'mock',
      visionProvider: 'disabled',
      narratorProvider: 'windows_sapi',
      mediaLibraryFolder: root,
      minFreeDiskGb: 0
    } as AppSettings;
    const createdAt = new Date().toISOString();
    db.raw.prepare(`
      INSERT INTO projects(
        id, sequence, slug, title, topic, state, progress, envato_project_name,
        target_duration_ms, created_at, updated_at
      ) VALUES('older-project', 1, 'older-project', 'Older Project', 'Topic',
        'WAITING_FINAL_APPROVAL', 0.96, 'YT-OLDER', 300000, ?, ?)
    `).run(createdAt, createdAt);
    const resumed = { id: 'older-project', title: 'Older Project', state: 'WAITING_FINAL_APPROVAL' } as ProjectDetail;
    let resumeCalls = 0;
    let created = 0;
    const service = new SchedulerService(
      db,
      () => settings,
      async () => { created += 1; return resumed; },
      async () => { resumeCalls += 1; return resumed; }
    );

    const status = await service.evaluate('timer', new Date('2026-08-12T12:00:00.000Z'));
    expect(status).toMatchObject({ reasonCode: 'older_project_resumed', lastProjectId: 'older-project' });
    expect(resumeCalls).toBe(1);
    expect(created).toBe(0);
    expect(db.raw.prepare(`SELECT outcome, project_id FROM scheduler_runs`).get())
      .toEqual({ outcome: 'resumed', project_id: 'older-project' });
    db.close();
  });
});
