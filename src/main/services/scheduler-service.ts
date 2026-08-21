import { randomUUID } from 'node:crypto';
import { statfsSync } from 'node:fs';
import type { AppDatabase } from '../database/database';
import type { AppSettings, ProjectDetail, SchedulerStatus } from '@shared/types';

type Trigger = 'timer' | 'manual' | 'settings' | 'startup';

const RESUME_BLOCKER_CODES = new Set([
  'monthly_budget',
  'auth_invalid',
  'quota_exhausted',
  'disk_pressure',
  'disk_unavailable'
]);

function nextCadenceAt(settings: AppSettings, baseline: Date): Date {
  const next = new Date(baseline.getTime() + settings.autopilotCadenceDays * 24 * 60 * 60 * 1_000);
  next.setUTCHours(settings.autopilotPublicationHourUtc, 0, 0, 0);
  if (next <= baseline) next.setUTCDate(next.getUTCDate() + settings.autopilotCadenceDays);
  return next;
}

export class SchedulerService {
  constructor(
    private readonly db: AppDatabase,
    private readonly settings: () => AppSettings,
    private readonly createProject: () => Promise<ProjectDetail>,
    private readonly resumeOldest: () => Promise<ProjectDetail | null> = async () => null
  ) {}

  status(): SchedulerStatus {
    const row = this.db.raw.prepare(`SELECT * FROM autopilot_scheduler_state WHERE id = 1`).get() as Record<string, unknown>;
    return {
      enabled: Boolean(row.enabled),
      state: row.state as SchedulerStatus['state'],
      reasonCode: row.reason_code ? String(row.reason_code) : null,
      reason: row.reason ? String(row.reason) : null,
      nextRunAt: row.next_run_at ? String(row.next_run_at) : null,
      lastRunAt: row.last_run_at ? String(row.last_run_at) : null,
      lastProjectId: row.last_project_id ? String(row.last_project_id) : null,
      evaluatedAt: String(row.evaluated_at)
    };
  }

  async evaluate(trigger: Trigger = 'manual', now = new Date()): Promise<SchedulerStatus> {
    const settings = this.settings();
    const at = now.toISOString();
    const current = this.status();
    const blockers = this.blockers(settings);
    const resumeBlockers = blockers.filter(item => RESUME_BLOCKER_CODES.has(item.code));
    if (resumeBlockers.length) {
      return this.record(
        trigger,
        'blocked',
        resumeBlockers[0]!.code,
        resumeBlockers.map(item => item.reason).join(' '),
        null,
        null,
        at,
        { blockers: resumeBlockers, scope: 'existing_and_new_projects' }
      );
    }
    try {
      const resumed = await this.resumeOldest();
      if (resumed) {
        return this.record(
          trigger,
          'resumed',
          'older_project_resumed',
          `Resumed older project ${resumed.title}.`,
          current.nextRunAt ? new Date(current.nextRunAt) : null,
          resumed.id,
          at,
          { projectId: resumed.id, resultingState: resumed.state }
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.record(trigger, 'failed', 'project_resume_failed', message, null, null, at);
    }
    if (!settings.autopilotSchedulerEnabled) {
      return this.record(trigger, 'paused', 'operator_disabled', 'Automatic project creation is disabled.', null, null, at);
    }
    if (blockers.length) {
      return this.record(trigger, 'blocked', blockers[0]!.code, blockers.map(item => item.reason).join(' '), null, null, at, { blockers });
    }
    const baseline = current.lastRunAt ? new Date(current.lastRunAt) : now;
    const dueAt = current.nextRunAt ? new Date(current.nextRunAt) : nextCadenceAt(settings, baseline);
    if (trigger !== 'manual' && now < dueAt) {
      return this.record(trigger, 'not_due', 'cadence_not_due', `Next cadence is ${dueAt.toISOString()}.`, dueAt, null, at);
    }
    try {
      const project = await this.createProject();
      const next = nextCadenceAt(settings, now);
      return this.record(trigger, 'created', null, `Created ${project.title}.`, next, project.id, at, { projectId: project.id });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.record(trigger, 'failed', 'project_creation_failed', message, null, null, at);
    }
  }

  private blockers(settings: AppSettings): Array<{ code: string; reason: string }> {
    const blockers: Array<{ code: string; reason: string }> = [];
    const queue = this.db.raw.prepare(`
      SELECT
        sum(CASE WHEN state NOT IN ('PUBLISHED','ANALYTICS_ACTIVE','FAILED','CANCELLED','ARCHIVED','PAUSED') THEN 1 ELSE 0 END) AS active,
        sum(CASE WHEN state = 'WAITING_FOR_DOWNLOADS' THEN 1 ELSE 0 END) AS downloads,
        sum(CASE WHEN state = 'WAITING_FINAL_APPROVAL' THEN 1 ELSE 0 END) AS approvals
      FROM projects
    `).get() as Record<string, number | null>;
    if (Number(queue.active ?? 0) >= settings.maxActiveProjects) blockers.push({ code: 'active_queue_limit', reason: 'Active-project queue limit is reached.' });
    if (Number(queue.downloads ?? 0) >= settings.maxWaitingDownloads) blockers.push({ code: 'download_queue_limit', reason: 'Acquisition queue limit is reached.' });
    if (Number(queue.approvals ?? 0) >= settings.maxPrivateApproval) blockers.push({ code: 'approval_queue_limit', reason: 'Private-approval queue limit is reached.' });
    const monthStart = new Date();
    monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
    const spend = this.db.raw.prepare(`SELECT coalesce(sum(estimated_cost_usd), 0) AS total FROM provider_calls WHERE created_at >= ?`).get(monthStart.toISOString()) as { total: number };
    if (Number(spend.total) >= settings.monthlyBudgetUsd) blockers.push({ code: 'monthly_budget', reason: 'Monthly provider budget is exhausted.' });
    const configured = new Set([
      ...(settings.researchProvider === 'tavily' ? ['tavily'] : []),
      ...(settings.llmProvider === 'openai_compatible' ? ['openai_compatible'] : []),
      ...(settings.visionProvider === 'openai_compatible' ? ['openai_compatible_vision'] : []),
      ...(settings.narratorProvider === 'http_tts' ? ['http_tts'] : [])
    ]);
    const health = (this.db.raw.prepare(`SELECT provider, status, message FROM provider_health WHERE status IN ('auth_invalid','quota_exhausted')`).all() as Array<{ provider: string; status: string; message: string | null }>).find(row => configured.has(row.provider));
    if (health) blockers.push({ code: health.status, reason: health.message ?? `${health.provider} ${health.status}.` });
    try {
      const stats = statfsSync(settings.mediaLibraryFolder);
      const freeGb = stats.bavail * stats.bsize / 1024 ** 3;
      if (freeGb < settings.minFreeDiskGb) blockers.push({ code: 'disk_pressure', reason: `Media storage has ${freeGb.toFixed(1)} GB free; ${settings.minFreeDiskGb} GB is required.` });
    } catch {
      blockers.push({ code: 'disk_unavailable', reason: 'Media storage free space could not be measured.' });
    }
    if (!(this.db.raw.prepare('SELECT 1 FROM assets WHERE excluded = 0 LIMIT 1').get())) blockers.push({ code: 'empty_catalog', reason: 'No eligible catalog asset is available.' });
    return blockers;
  }

  private record(
    trigger: Trigger,
    outcome: 'created' | 'resumed' | 'not_due' | 'paused' | 'blocked' | 'failed',
    reasonCode: string | null,
    reason: string,
    nextRunAt: Date | null,
    projectId: string | null,
    at: string,
    evidence: Record<string, unknown> = {}
  ): SchedulerStatus {
    const enabled = this.settings().autopilotSchedulerEnabled;
    const state: SchedulerStatus['state'] = outcome === 'blocked' || outcome === 'failed' ? 'blocked' : enabled ? 'running' : 'paused';
    this.db.raw.transaction(() => {
      this.db.raw.prepare(`
        UPDATE autopilot_scheduler_state SET enabled = ?, state = ?, reason_code = ?, reason = ?,
          next_run_at = ?, last_run_at = CASE WHEN ? = 'created' THEN ? ELSE last_run_at END,
          last_project_id = COALESCE(?, last_project_id), evaluated_at = ?, updated_at = ? WHERE id = 1
      `).run(Number(enabled), state, reasonCode, reason, nextRunAt?.toISOString() ?? null, outcome, at, projectId, at, at);
      this.db.raw.prepare(`
        INSERT INTO scheduler_runs(id, trigger, outcome, reason_code, reason, project_id, evidence_json, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), trigger, outcome, reasonCode, reason, projectId, JSON.stringify(evidence), at);
    })();
    return this.status();
  }
}
