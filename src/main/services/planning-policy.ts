import type { AppDatabase } from '../database/database';
import type { AppSettings, CoverageCluster } from '@shared/types';

export interface PlanningDecision {
  qualified: boolean;
  estimatedShots: number;
  requiredShots: number;
  reasons: string[];
  components: Record<string, number>;
  opportunityScore: number;
}
function normalizeTopic(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length > 2));
}

export function topicSimilarity(left: string, right: string): number {
  const a = normalizeTopic(left);
  const b = normalizeTopic(right);
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter(value => b.has(value)).length;
  return intersection / new Set([...a, ...b]).size;
}

export function evaluateCoverage(
  cluster: CoverageCluster,
  targetMinutes: number,
  output: { orientation: 'landscape' | 'portrait' } = { orientation: 'landscape' }
): PlanningDecision {
  const requiredShots = Math.max(12, Math.ceil(targetMinutes * 60 / 4.5));
  const estimatedShots = Math.min(cluster.assetCount * 3, Math.floor(cluster.assetCount * 2.1));
  const uniqueAssets = Math.min(100, (cluster.assetCount / 12) * 100);
  const shotDiversity = Math.min(100, (cluster.uniqueShotTypes / 4) * 100);
  const orientationCount = output.orientation === 'portrait' ? cluster.portraitCount : cluster.landscapeCount;
  const resolution = cluster.assetCount ? (orientationCount / cluster.assetCount) * 100 : 0;
  const confidence = cluster.assetCount ? (cluster.verifiedCount / cluster.assetCount) * 100 : 0;
  const shotCoverage = Math.min(100, (estimatedShots / Math.max(1, requiredShots * 1.35)) * 100);
  const visualCoverage = uniqueAssets * 0.25 + shotDiversity * 0.25 + resolution * 0.2 + shotCoverage * 0.3;
  const productionEfficiency = cluster.assetCount
    ? Math.min(100, (cluster.downloadedCount / cluster.assetCount) * 40 + Math.min(cluster.assetCount, 40) / 40 * 60)
    : 0;
  const components = {
    uniqueAssets, shotDiversity, resolution, confidence, shotCoverage,
    visualCoverage, demand: 0, lowCompetition: 0, exactLocationConfidence: confidence,
    channelFit: 0, evergreen: 50, freshness: 0, productionEfficiency, strategic: 0
  };
  const opportunityScore = visualCoverage * 0.22
    + confidence * 0.12
    + components.evergreen * 0.08
    + productionEfficiency * 0.05;
  const reasons: string[] = [];
  if (cluster.assetCount < 12) reasons.push('Fewer than 12 unique source assets');
  if (cluster.uniqueShotTypes < 4) reasons.push('Fewer than four shot categories');
  if (estimatedShots < requiredShots * 1.35) reasons.push('Estimated candidate-shot coverage is below 1.35x');
  if (orientationCount < Math.max(6, cluster.assetCount * 0.45)) {
    reasons.push(`${output.orientation === 'portrait' ? 'Portrait/vertical' : 'Landscape/full-screen'} coverage is insufficient`);
  }
  return { qualified: reasons.length === 0, estimatedShots, requiredShots, reasons, components, opportunityScore };
}

export function assertPlanningCapacity(db: AppDatabase, settings: AppSettings, proposedTitle: string): void {
  const queue = db.raw.prepare(`
    SELECT
      sum(CASE WHEN state NOT IN ('PUBLISHED','ANALYTICS_ACTIVE','FAILED','CANCELLED','ARCHIVED','PAUSED') THEN 1 ELSE 0 END) AS active,
      sum(CASE WHEN state = 'WAITING_FOR_DOWNLOADS' THEN 1 ELSE 0 END) AS waiting_downloads,
      sum(CASE WHEN state = 'WAITING_FINAL_APPROVAL' THEN 1 ELSE 0 END) AS waiting_approval
    FROM projects
  `).get() as { active: number | null; waiting_downloads: number | null; waiting_approval: number | null };
  if (Number(queue.active ?? 0) >= settings.maxActiveProjects) throw new Error(`Active project limit reached (${settings.maxActiveProjects}).`);
  if (Number(queue.waiting_downloads ?? 0) >= settings.maxWaitingDownloads) throw new Error(`Waiting-download project limit reached (${settings.maxWaitingDownloads}).`);
  if (Number(queue.waiting_approval ?? 0) >= settings.maxPrivateApproval) throw new Error(`Final-approval queue limit reached (${settings.maxPrivateApproval}).`);

  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const spend = db.raw.prepare(`
    SELECT coalesce(sum(estimated_cost_usd), 0) AS total FROM provider_calls WHERE created_at >= ?
  `).get(monthStart.toISOString()) as { total: number };
  if (Number(spend.total) >= settings.monthlyBudgetUsd) throw new Error('Monthly provider budget is exhausted.');

  const configuredProviders = new Set<string>([
    ...(settings.researchProvider === 'tavily' ? ['tavily'] : []),
    ...(settings.llmProvider === 'openai_compatible' ? ['openai_compatible'] : []),
    ...(settings.visionProvider === 'openai_compatible' ? ['openai_compatible_vision'] : [])
  ]);
  const health = (db.raw.prepare(`
    SELECT provider, status, message FROM provider_health
    WHERE status IN ('auth_invalid','quota_exhausted')
    ORDER BY checked_at DESC
  `).all() as Array<{ provider: string; status: string; message: string | null }>)
    .find(row => configuredProviders.has(row.provider));
  if (health) {
    throw new Error(health.message ?? `${health.provider} ${health.status.replace('_', ' ')}; no project or provider call was started.`);
  }

  const existing = db.raw.prepare(`
    SELECT title FROM projects WHERE state NOT IN ('FAILED','CANCELLED','ARCHIVED') ORDER BY created_at DESC LIMIT 250
  `).all() as Array<{ title: string }>;
  if (existing.some(project => topicSimilarity(project.title, proposedTitle) >= 0.8)) {
    throw new Error('A materially duplicate topic already exists in the queue or publication history.');
  }
}
