import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase } from '@main/database/database';
import { AnalyticsService } from '@main/services/analytics-service';
import { JobService } from '@main/services/job-service';
import type { AppSettings } from '@shared/types';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function seedProject(db: AppDatabase, id: string, sequence: number): void {
  const now = new Date().toISOString();
  db.raw.prepare(`
    INSERT INTO projects(
      id, sequence, slug, title, topic, state, progress, envato_project_name,
      target_duration_ms, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, 'PUBLISHED', 1, ?, 10000, ?, ?)
  `).run(id, sequence, id, `Project ${sequence}`, `Topic ${sequence}`, `YT-${sequence}`, now, now);
  for (const ordinal of [1, 2]) {
    db.raw.prepare(`
      INSERT INTO project_scenes(
        id, project_id, ordinal, chapter, narration, target_duration_ms,
        required_location, required_granularity, required_objects_json,
        required_activities_json, preferred_shots_json, visual_treatment,
        verification_state, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, 5000, ?, 'landmark', '[]', '[]', '[]',
        'EXACT_LOCATION_FOOTAGE', 'verified', ?, ?)
    `).run(`${id}-scene-${ordinal}`, id, ordinal, `Chapter ${ordinal}`, `Five words map this scene ${ordinal}`, `Location ${ordinal}`, now, now);
  }
  const manifestId = `${id}-manifest`;
  const manifest = {
    scenes: [1, 2].map(ordinal => ({
      sceneId: `${id}-scene-${ordinal}`,
      ordinal,
      chapter: `Chapter ${ordinal}`,
      narration: `Five words map this scene ${ordinal}`,
      timelineStartMs: (ordinal - 1) * 5000,
      timelineEndMs: ordinal * 5000,
      durationMs: 5000,
      visualTreatment: 'EXACT_LOCATION_FOOTAGE',
      requiredLocation: `Location ${ordinal}`,
      editingPlan: { sourceKind: 'footage' }
    }))
  };
  db.raw.prepare(`
    INSERT INTO render_manifests(
      id, project_id, profile, manifest_json, manifest_hash, path, created_at
    ) VALUES(?, ?, 'final_1080p', ?, ?, ?, ?)
  `).run(manifestId, id, JSON.stringify(manifest), `${id}-hash`, `${id}.json`, now);
  db.raw.prepare(`
    INSERT INTO renders(
      id, project_id, kind, profile, state, manifest_id, duration_ms, width,
      height, created_at, completed_at
    ) VALUES(?, ?, 'final', 'final_1080p', 'SUCCEEDED', ?, 10000, 1920, 1080, ?, ?)
  `).run(`${id}-render`, id, manifestId, now, now);
}

function publishProject(db: AppDatabase, id: string, videoId: string, publishedAt = new Date().toISOString()): void {
  const now = new Date().toISOString();
  db.raw.prepare(`UPDATE projects SET youtube_video_id = ?, published_at = ? WHERE id = ?`)
    .run(videoId, publishedAt, id);
  db.raw.prepare(`
    INSERT INTO publication_records(
      id, project_id, channel_id, video_id, privacy_status, final_sha256,
      processing_status, approval_hash, published_at, created_at, updated_at
    ) VALUES(?, ?, 'channel-fixture', ?, 'public', ?, 'succeeded', ?, ?, ?, ?)
  `).run(`${id}-publication`, id, videoId, `${id}-final-sha`, `${id}-fingerprint`, publishedAt, now, now);
}

function scheduleProject(db: AppDatabase, id: string, videoId: string, scheduledAt: string): void {
  const now = new Date().toISOString();
  db.raw.prepare(`
    UPDATE projects SET state = 'SCHEDULED', youtube_video_id = ?, published_at = NULL WHERE id = ?
  `).run(videoId, id);
  db.raw.prepare(`
    INSERT INTO publication_records(
      id, project_id, channel_id, video_id, privacy_status, final_sha256,
      processing_status, approval_hash, scheduled_at, created_at, updated_at
    ) VALUES(?, ?, 'channel-fixture', ?, 'private', ?, 'succeeded', ?, ?, ?, ?)
  `).run(`${id}-publication`, id, videoId, `${id}-final-sha`, `${id}-fingerprint`, scheduledAt, now, now);
}

function snapshot(projectId: string, videoId: string, views: number) {
  return {
    projectId,
    videoId,
    snapshotDay: 7 as const,
    capturedAt: '2026-08-12T12:00:00.000Z',
    source: 'manual_import' as const,
    metrics: {
      views, impressions: views * 5, clickThroughRate: 0.08,
      watchTimeMinutes: views * 2, averageViewDurationSeconds: 120,
      averagePercentageViewed: 0.5, subscribersGained: 10,
      trafficSources: { search: views / 2 }, searchTerms: { travel: views / 4 },
      playlistStarts: 5, endScreenClicks: 8
    },
    retention: [
      { elapsedRatio: 0.25, audienceWatchRatio: 0.8, relativeRetention: 0.1 },
      { elapsedRatio: 0.75, audienceWatchRatio: 0.5, relativeRetention: -0.1 }
    ]
  };
}

describe('analytics snapshots, retention mapping, and reversible learning', () => {
  it('maps retention to immutable final scenes and requires repeated evidence before bounded changes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'videofactory-analytics-'));
    roots.push(root);
    const db = new AppDatabase(join(root, 'db.sqlite'));
    seedProject(db, 'project-1', 1);
    seedProject(db, 'project-2', 2);
    let settings = {
      preferredShotMinSeconds: 3,
      preferredShotMaxSeconds: 5.5,
      targetVideoMinutes: 5
    } as AppSettings;
    const service = new AnalyticsService(db, () => settings, async patch => {
      settings = { ...settings, ...patch };
      return settings;
    });
    const first = service.importSnapshot(snapshot('project-1', 'video-1', 600));
    const second = service.importSnapshot(snapshot('project-2', 'video-2', 700));
    expect(first.mappings.map(item => item.sceneOrdinal)).toEqual([1, 2]);
    expect(first.mappings[0]).toMatchObject({ positionMs: 2500, sourceKind: 'footage', locationName: 'Location 1' });
    expect(first.mappings[0]!.voiceWordsPerMinute).toBeGreaterThan(0);
    const storedSearch = db.raw.prepare(`
      SELECT project_id, video_id, metrics_json FROM analytics_snapshots WHERE id = ?
    `).get(first.id) as { project_id: string; video_id: string; metrics_json: string };
    expect(storedSearch).toMatchObject({ project_id: 'project-1', video_id: 'video-1' });
    expect(JSON.parse(storedSearch.metrics_json)).toMatchObject({
      trafficSources: { search: 300 },
      searchTerms: { travel: 150 }
    });
    expect(service.importSnapshot(snapshot('project-1', 'video-1', 600)).id).toBe(first.id);

    expect(() => service.propose({
      metricKey: 'preferredShotMaxSeconds', proposedValue: 5,
      rationale: 'Repeated retention evidence supports a small reduction in maximum shot length.',
      evidenceSnapshotIds: [first.id]
    })).toThrow('at least two videos');
    const recommendation = service.propose({
      metricKey: 'preferredShotMaxSeconds', proposedValue: 5,
      rationale: 'Repeated retention evidence supports a small reduction in maximum shot length.',
      evidenceSnapshotIds: [first.id, second.id]
    });
    expect(recommendation).toMatchObject({ status: 'proposed', evidenceVideoCount: 2, evidenceTotalViews: 1300 });
    expect(settings.preferredShotMaxSeconds).toBe(5.5);
    expect(await service.decide(recommendation.id, 'apply')).toMatchObject({ status: 'applied', currentValue: 5 });
    expect(settings.preferredShotMaxSeconds).toBe(5);
    expect(await service.decide(recommendation.id, 'rollback')).toMatchObject({ status: 'rolled_back', currentValue: 5.5 });
    expect(settings.preferredShotMaxSeconds).toBe(5.5);
    db.close();
  });

  it('collects through an injected provider and records durable success and failure receipts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'videofactory-analytics-provider-'));
    roots.push(root);
    const db = new AppDatabase(join(root, 'db.sqlite'));
    seedProject(db, 'project-provider', 1);
    publishProject(db, 'project-provider', 'video-provider');
    const settings = { preferredShotMinSeconds: 3, preferredShotMaxSeconds: 5.5, targetVideoMinutes: 5 } as AppSettings;
    const provider = {
      collect: async () => ({
        metrics: snapshot('project-provider', 'video-provider', 900).metrics,
        retention: snapshot('project-provider', 'video-provider', 900).retention,
        rawMetadata: { fixture: true }
      })
    };
    const service = new AnalyticsService(db, () => settings, async () => settings, provider);
    const collected = await service.collect('project-provider', 7);
    expect(collected).toMatchObject({ projectId: 'project-provider', videoId: 'video-provider', source: 'youtube_api' });
    expect(service.collectionRuns('project-provider')[0]).toMatchObject({
      status: 'complete', analyticsSnapshotId: collected.id, provider: 'youtube_analytics'
    });

    const failing = new AnalyticsService(db, () => settings, async () => settings, {
      collect: async () => { throw new Error('fixture auth failure'); }
    });
    await expect(failing.collect('project-provider', 28)).rejects.toThrow('fixture auth failure');
    expect(failing.collectionRuns('project-provider')[0]).toMatchObject({ status: 'failed', error: 'fixture auth failure' });
    db.close();
  });

  it('creates exactly five durable checkpoints and activates analytics on first success', async () => {
    const root = mkdtempSync(join(tmpdir(), 'videofactory-analytics-cadence-'));
    roots.push(root);
    const db = new AppDatabase(join(root, 'db.sqlite'));
    seedProject(db, 'project-cadence', 1);
    const anchor = '2026-08-10T12:00:00.000Z';
    publishProject(db, 'project-cadence', 'video-cadence', anchor);
    const current = new Date('2026-08-11T12:00:00.000Z');
    const settings = { preferredShotMinSeconds: 3, preferredShotMaxSeconds: 5.5, targetVideoMinutes: 5 } as AppSettings;
    const provider = {
      collect: vi.fn(async () => ({
        metrics: snapshot('project-cadence', 'video-cadence', 900).metrics,
        retention: snapshot('project-cadence', 'video-cadence', 900).retention
      }))
    };
    const jobs = new JobService(db);
    const service = new AnalyticsService(db, () => settings, async () => settings, provider, jobs, () => current);

    expect(service.scheduleCheckpoints('project-cadence').map(job => job.availableAt)).toEqual([
      '2026-08-11T12:00:00.000Z',
      '2026-08-13T12:00:00.000Z',
      '2026-08-17T12:00:00.000Z',
      '2026-09-07T12:00:00.000Z',
      '2026-11-08T12:00:00.000Z'
    ]);
    const first = await service.processDue();
    expect(first).toMatchObject({ dueJobs: 1, succeeded: 1, deferred: 0, failed: 0 });
    expect(provider.collect).toHaveBeenCalledTimes(1);
    expect(db.raw.prepare(`SELECT state FROM projects WHERE id = 'project-cadence'`).get())
      .toEqual({ state: 'ANALYTICS_ACTIVE' });
    expect(db.raw.prepare(`SELECT count(*) AS count FROM jobs WHERE type = 'analytics_checkpoint'`).get())
      .toEqual({ count: 5 });
    await service.processDue();
    expect(db.raw.prepare(`SELECT count(*) AS count FROM jobs WHERE type = 'analytics_checkpoint'`).get())
      .toEqual({ count: 5 });
    db.close();
  });

  it('defers a still-private scheduled video without consuming a retry, then confirms publication', async () => {
    const root = mkdtempSync(join(tmpdir(), 'videofactory-analytics-scheduled-'));
    roots.push(root);
    const db = new AppDatabase(join(root, 'db.sqlite'));
    seedProject(db, 'project-scheduled', 1);
    scheduleProject(db, 'project-scheduled', 'video-scheduled', '2026-08-10T12:00:00.000Z');
    let current = new Date('2026-08-11T12:00:00.000Z');
    let publicNow = false;
    const settings = { preferredShotMinSeconds: 3, preferredShotMaxSeconds: 5.5, targetVideoMinutes: 5 } as AppSettings;
    const provider = {
      publicationStatus: vi.fn(async () => ({
        isPublic: publicNow,
        privacyStatus: publicNow ? 'public' : 'private',
        publishedAt: publicNow ? '2026-08-10T12:02:00.000Z' : null
      })),
      collect: vi.fn(async () => ({
        metrics: snapshot('project-scheduled', 'video-scheduled', 500).metrics,
        retention: snapshot('project-scheduled', 'video-scheduled', 500).retention
      }))
    };
    const service = new AnalyticsService(
      db, () => settings, async () => settings, provider, new JobService(db), () => current
    );

    expect(await service.processDue()).toMatchObject({ dueJobs: 1, deferred: 1, succeeded: 0, failed: 0 });
    expect(provider.collect).not.toHaveBeenCalled();
    expect(db.raw.prepare(`
      SELECT state, attempt, available_at FROM jobs
      WHERE type = 'analytics_checkpoint' AND json_extract(input_json, '$.snapshotDay') = 1
    `).get()).toEqual({ state: 'QUEUED', attempt: 0, available_at: '2026-08-11T13:00:00.000Z' });

    publicNow = true;
    current = new Date('2026-08-11T13:00:00.000Z');
    expect(await service.processDue()).toMatchObject({ dueJobs: 1, deferred: 0, succeeded: 1, failed: 0 });
    expect(provider.collect).toHaveBeenCalledTimes(1);
    expect(db.raw.prepare(`SELECT state, published_at FROM projects WHERE id = 'project-scheduled'`).get())
      .toEqual({ state: 'ANALYTICS_ACTIVE', published_at: '2026-08-10T12:02:00.000Z' });
    expect(db.raw.prepare(`SELECT privacy_status FROM publication_records WHERE project_id = 'project-scheduled'`).get())
      .toEqual({ privacy_status: 'public' });
    expect(db.raw.prepare(`SELECT count(*) AS count FROM jobs WHERE type = 'analytics_checkpoint'`).get())
      .toEqual({ count: 5 });
    await service.processDue();
    expect(db.raw.prepare(`SELECT count(*) AS count FROM jobs WHERE type = 'analytics_checkpoint'`).get())
      .toEqual({ count: 5 });
    db.close();
  });
});
