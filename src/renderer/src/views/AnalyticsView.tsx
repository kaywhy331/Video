import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  Check,
  FileJson,
  RefreshCw,
  RotateCcw,
  Sparkles,
  X
} from 'lucide-react';
import type {
  AnalyticsMetrics,
  AnalyticsSnapshot,
  LearningRecommendation,
  ProjectSummary,
  RetentionPointInput
} from '@shared/types';
import { Button, EmptyState, ErrorBanner, MetricCard, Panel, StatusPill } from '../components/ui';

const SAMPLE_SNAPSHOT = JSON.stringify({
  metrics: {
    views: 0,
    impressions: null,
    clickThroughRate: null,
    watchTimeMinutes: null,
    averageViewDurationSeconds: null,
    averagePercentageViewed: null,
    subscribersGained: null,
    trafficSources: {},
    searchTerms: {},
    playlistStarts: null,
    endScreenClicks: null
  },
  retention: [
    { elapsedRatio: 0, audienceWatchRatio: 1, relativeRetention: null },
    { elapsedRatio: 0.5, audienceWatchRatio: null, relativeRetention: null },
    { elapsedRatio: 1, audienceWatchRatio: null, relativeRetention: null }
  ]
}, null, 2);

function percent(value: number | null): string {
  return value === null ? 'Unavailable' : `${(value * 100).toFixed(1)}%`;
}

function compactNumber(value: number | null): string {
  return value === null ? 'Unavailable' : value.toLocaleString();
}

function seconds(value: number | null): string {
  if (value === null) return 'Unavailable';
  const minutes = Math.floor(value / 60);
  const remainder = Math.round(value % 60);
  return minutes ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

export function AnalyticsView({
  projects,
  onRefresh
}: {
  projects: ProjectSummary[];
  onRefresh: () => Promise<void>;
}) {
  const publishedProjects = useMemo(() => projects.filter(project => project.youtubeVideoId), [projects]);
  const projectName = useMemo(() => new Map(projects.map(project => [project.id, project.title])), [projects]);
  const [snapshots, setSnapshots] = useState<AnalyticsSnapshot[]>([]);
  const [recommendations, setRecommendations] = useState<LearningRecommendation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [projectFilter, setProjectFilter] = useState('all');
  const [selectedSnapshotId, setSelectedSnapshotId] = useState('');
  const [importProjectId, setImportProjectId] = useState('');
  const [snapshotDay, setSnapshotDay] = useState<1 | 3 | 7 | 28 | 90>(7);
  const [capturedAt, setCapturedAt] = useState(() => new Date().toISOString().slice(0, 16));
  const [snapshotJson, setSnapshotJson] = useState(SAMPLE_SNAPSHOT);
  const [evidenceIds, setEvidenceIds] = useState<Set<string>>(new Set());
  const [metricKey, setMetricKey] = useState<'preferredShotMinSeconds' | 'preferredShotMaxSeconds' | 'targetVideoMinutes'>('preferredShotMaxSeconds');
  const [proposedValue, setProposedValue] = useState('');
  const [rationale, setRationale] = useState('');
  const [metricDraft, setMetricDraft] = useState({
    topicCandidateId: '', keyword: '', provider: 'manual', metricType: 'demand score',
    value: '', geographyCode: '', languageCode: 'en', confidence: '0.8', youtubeNative: false
  });
  const [opportunities, setOpportunities] = useState<Awaited<ReturnType<typeof window.videoFactory.expansion.opportunities>>>([]);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [nextSnapshots, nextRecommendations, nextOpportunities] = await Promise.all([
        window.videoFactory.analytics.list(),
        window.videoFactory.analytics.recommendations(),
        window.videoFactory.expansion.opportunities()
      ]);
      setSnapshots(nextSnapshots);
      setRecommendations(nextRecommendations);
      setOpportunities(nextOpportunities);
      setSelectedSnapshotId(current => nextSnapshots.some(item => item.id === current) ? current : (nextSnapshots[0]?.id ?? ''));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!importProjectId && publishedProjects[0]) setImportProjectId(publishedProjects[0].id);
  }, [importProjectId, publishedProjects]);

  const visibleSnapshots = useMemo(() => projectFilter === 'all'
    ? snapshots
    : snapshots.filter(snapshot => snapshot.projectId === projectFilter), [projectFilter, snapshots]);
  const selectedSnapshot = snapshots.find(snapshot => snapshot.id === selectedSnapshotId)
    ?? visibleSnapshots[0]
    ?? null;
  const uniqueProjects = new Set(snapshots.map(snapshot => snapshot.projectId)).size;

  async function run(label: string, work: () => Promise<void>): Promise<void> {
    setBusy(label);
    setError(null);
    try {
      await work();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy('');
    }
  }

  async function importSnapshot(): Promise<void> {
    await run('import', async () => {
      const project = publishedProjects.find(item => item.id === importProjectId);
      if (!project?.youtubeVideoId) throw new Error('Choose a project with a persisted YouTube video ID.');
      const document = JSON.parse(snapshotJson) as {
        metrics?: AnalyticsMetrics;
        retention?: RetentionPointInput[];
      };
      if (!document.metrics || !Array.isArray(document.retention)) {
        throw new Error('Snapshot JSON must contain metrics and retention fields.');
      }
      const imported = await window.videoFactory.analytics.importSnapshot({
        projectId: project.id,
        videoId: project.youtubeVideoId,
        snapshotDay,
        capturedAt: new Date(capturedAt).toISOString(),
        source: 'manual_import',
        metrics: document.metrics,
        retention: document.retention
      });
      await load();
      setSelectedSnapshotId(imported.id);
    });
  }

  async function collectLive(): Promise<void> {
    await run('collect', async () => {
      if (!importProjectId) throw new Error('Choose a published project.');
      const snapshot = await window.videoFactory.analytics.collect(importProjectId, snapshotDay);
      await load();
      setSelectedSnapshotId(snapshot.id);
    });
  }

  async function importKeywordMetric(): Promise<void> {
    await run('metric-import', async () => {
      const value = metricDraft.value.trim() ? Number(metricDraft.value) : null;
      if (value !== null && !Number.isFinite(value)) throw new Error('Metric value must be numeric or blank.');
      await window.videoFactory.expansion.importKeywordMetric({
        topicCandidateId: metricDraft.topicCandidateId || undefined,
        keyword: metricDraft.keyword,
        provider: metricDraft.provider,
        metricType: metricDraft.metricType,
        value,
        geographyCode: metricDraft.geographyCode || null,
        languageCode: metricDraft.languageCode,
        collectedAt: new Date().toISOString(),
        confidence: Number(metricDraft.confidence),
        youtubeNative: metricDraft.youtubeNative,
        rawMetadata: {}
      });
      setMetricDraft(current => ({ ...current, keyword: '', value: '' }));
      await load();
    });
  }

  function toggleEvidence(id: string): void {
    setEvidenceIds(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function propose(): Promise<void> {
    await run('propose', async () => {
      const numeric = Number(proposedValue);
      if (!Number.isFinite(numeric)) throw new Error('Enter a numeric proposed value.');
      const created = await window.videoFactory.analytics.propose({
        metricKey,
        proposedValue: numeric,
        rationale,
        evidenceSnapshotIds: [...evidenceIds]
      });
      setRecommendations(current => [created, ...current.filter(item => item.id !== created.id)]);
      setRationale('');
      setProposedValue('');
    });
  }

  async function decide(id: string, decision: 'apply' | 'reject' | 'rollback'): Promise<void> {
    await run(`${decision}-${id}`, async () => {
      const updated = await window.videoFactory.analytics.decide(id, decision);
      setRecommendations(current => current.map(item => item.id === id ? updated : item));
      await onRefresh();
    });
  }

  if (loading) return <div className="loading-panel">Loading immutable analytics snapshots…</div>;

  return (
    <div className="view-stack analytics-view">
      <div className="page-heading">
        <div>
          <div className="eyebrow"><BarChart3 size={14} /> ANALYTICS & CONTROLLED LEARNING</div>
          <h1>Trace audience behavior back to the exact rendered scene.</h1>
          <p>Snapshots are local and immutable. Recommendations require repeated evidence and only change policy after human approval.</p>
        </div>
        <Button variant="ghost" busy={busy === 'reload'} onClick={() => void run('reload', load)}><RefreshCw size={15} /> Retry / refresh</Button>
      </div>

      {error ? <ErrorBanner title="Analytics action failed" message={error} onDismiss={() => setError(null)} /> : null}

      <div className="metric-grid">
        <MetricCard label="Snapshots" value={snapshots.length.toLocaleString()} detail="1 / 3 / 7 / 28 / 90-day receipts" icon={<FileJson size={18} />} />
        <MetricCard label="Measured videos" value={uniqueProjects.toLocaleString()} detail="Learning requires at least two" icon={<BarChart3 size={18} />} />
        <MetricCard label="Latest views" value={compactNumber(selectedSnapshot?.metrics.views ?? null)} detail={selectedSnapshot ? `${selectedSnapshot.snapshotDay}-day snapshot` : 'No imported data'} />
        <MetricCard label="Average viewed" value={percent(selectedSnapshot?.metrics.averagePercentageViewed ?? null)} detail={selectedSnapshot ? seconds(selectedSnapshot.metrics.averageViewDurationSeconds) : 'No imported data'} />
      </div>

      <div className="analytics-grid">
        <Panel
          title="Snapshot history"
          subtitle="Provider source labels are retained; manual data is never presented as live YouTube API collection"
          action={(
            <select aria-label="Filter snapshot history by project" value={projectFilter} onChange={event => setProjectFilter(event.target.value)}>
              <option value="all">All projects</option>
              {projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}
            </select>
          )}
        >
          {visibleSnapshots.length ? (
            <div className="snapshot-list">
              {visibleSnapshots.map(snapshot => (
                <button
                  key={snapshot.id}
                  className={selectedSnapshot?.id === snapshot.id ? 'snapshot-row snapshot-selected' : 'snapshot-row'}
                  onClick={() => setSelectedSnapshotId(snapshot.id)}
                >
                  <div><strong>{projectName.get(snapshot.projectId) ?? snapshot.projectId}</strong><span>{new Date(snapshot.capturedAt).toLocaleString()}</span></div>
                  <span>{snapshot.metrics.views.toLocaleString()} views</span>
                  <StatusPill value={`${snapshot.snapshotDay} day`} />
                  <StatusPill value={snapshot.source} />
                </button>
              ))}
            </div>
          ) : (
            <EmptyState title="No analytics snapshots" body="Import a bounded JSON snapshot from an eligible published project to create the first retention mapping." />
          )}
        </Panel>

        <Panel title="Analytics collection and manual import" subtitle="Live collection uses YouTube Analytics read-only scope; manual values retain a manual source label">
          <div className="settings-form analytics-import-form">
            <label><span>Published project</span><select value={importProjectId} onChange={event => setImportProjectId(event.target.value)}><option value="">Choose project</option>{publishedProjects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}</select></label>
            <div className="analytics-inline-fields">
              <label><span>Snapshot day</span><select value={snapshotDay} onChange={event => setSnapshotDay(Number(event.target.value) as typeof snapshotDay)}>{[1, 3, 7, 28, 90].map(day => <option key={day} value={day}>{day}</option>)}</select></label>
              <label><span>Captured at</span><input type="datetime-local" value={capturedAt} onChange={event => setCapturedAt(event.target.value)} /></label>
            </div>
            <label><span>Metrics and retention JSON</span><textarea rows={15} value={snapshotJson} onChange={event => setSnapshotJson(event.target.value)} spellCheck={false} /></label>
            <div className="button-row">
              <Button busy={busy === 'collect'} disabled={!importProjectId} onClick={() => void collectLive()}><RefreshCw size={15} /> Collect read-only API snapshot</Button>
              <Button variant="secondary" busy={busy === 'import'} disabled={!importProjectId || !capturedAt} onClick={() => void importSnapshot()}><FileJson size={15} /> Validate manual snapshot</Button>
            </div>
            <small>Impressions, CTR, playlist, and end-screen metrics remain unavailable when the API does not expose them. A live credential rehearsal is still required before provider qualification.</small>
          </div>
        </Panel>
      </div>

      <div className="analytics-grid">
        <Panel title="Keyword and opportunity evidence" subtitle="Every observation preserves provider, geography, language, date, confidence, and whether it is YouTube-native">
          <div className="settings-form">
            <label><span>Topic candidate (optional)</span><select value={metricDraft.topicCandidateId} onChange={event => setMetricDraft({ ...metricDraft, topicCandidateId: event.target.value })}><option value="">Unassigned observation</option>{opportunities.map(item => <option key={item.topicCandidateId} value={item.topicCandidateId}>{item.title}</option>)}</select></label>
            <div className="analytics-inline-fields"><label><span>Keyword</span><input value={metricDraft.keyword} onChange={event => setMetricDraft({ ...metricDraft, keyword: event.target.value })} /></label><label><span>Value</span><input type="number" value={metricDraft.value} onChange={event => setMetricDraft({ ...metricDraft, value: event.target.value })} /></label></div>
            <div className="analytics-inline-fields"><label><span>Provider</span><input value={metricDraft.provider} onChange={event => setMetricDraft({ ...metricDraft, provider: event.target.value })} /></label><label><span>Metric type</span><input value={metricDraft.metricType} onChange={event => setMetricDraft({ ...metricDraft, metricType: event.target.value })} /></label></div>
            <div className="analytics-inline-fields"><label><span>Geography</span><input value={metricDraft.geographyCode} onChange={event => setMetricDraft({ ...metricDraft, geographyCode: event.target.value })} /></label><label><span>Language</span><input value={metricDraft.languageCode} onChange={event => setMetricDraft({ ...metricDraft, languageCode: event.target.value })} /></label></div>
            <label><span>Confidence</span><input type="number" min="0" max="1" step="0.05" value={metricDraft.confidence} onChange={event => setMetricDraft({ ...metricDraft, confidence: event.target.value })} /></label>
            <label className="checkbox-field"><input type="checkbox" checked={metricDraft.youtubeNative} onChange={event => setMetricDraft({ ...metricDraft, youtubeNative: event.target.checked })} /><span>This value is truly YouTube-native (Google Search/Ads proxies are rejected if checked)</span></label>
            <Button busy={busy === 'metric-import'} disabled={!metricDraft.keyword || !metricDraft.provider || !metricDraft.metricType} onClick={() => void importKeywordMetric()}><FileJson size={15} /> Record evidence</Button>
          </div>
        </Panel>
        <Panel title="Explainable opportunity ledger" subtitle="Missing evidence receives zero credit and an explicit label; hard feasibility remains upstream of scoring">
          <div className="opportunity-list">
            {opportunities.map(item => <article key={item.topicCandidateId}><header><div><strong>{item.title}</strong><span>{item.destination}</span></div><StatusPill value={`${item.opportunityScore.toFixed(1)} score`} /></header><div className="opportunity-components">{Object.entries(item.components).map(([key, value]) => <span key={key}>{key.replaceAll(/([A-Z])/g, ' $1')}: <strong>{value.toFixed(1)}</strong></span>)}</div>{item.labels.map(label => <small key={label}>{label}</small>)}</article>)}
            {!opportunities.length ? <EmptyState title="No topic candidates" body="Create an Autopilot project to persist the first coverage-qualified candidate." /> : null}
          </div>
        </Panel>
      </div>

      <Panel title="Retention-to-render mapping" subtitle={selectedSnapshot ? `${projectName.get(selectedSnapshot.projectId) ?? selectedSnapshot.projectId} · ${selectedSnapshot.snapshotDay}-day snapshot · ${selectedSnapshot.source.replaceAll('_', ' ')}` : 'Select a snapshot'}>
        {selectedSnapshot?.mappings.length ? (
          <div className="retention-table-wrap">
            <table className="retention-table">
              <thead><tr><th>Timeline</th><th>Audience</th><th>Relative</th><th>Scene / chapter</th><th>Treatment</th><th>Location</th><th>Shot</th><th>Voice</th></tr></thead>
              <tbody>{selectedSnapshot.mappings.map((mapping, index) => (
                <tr key={`${mapping.positionMs}-${index}`}>
                  <td>{seconds(mapping.positionMs / 1000)}</td>
                  <td>{percent(mapping.audienceWatchRatio)}</td>
                  <td>{mapping.relativeRetention === null ? '—' : `${mapping.relativeRetention >= 0 ? '+' : ''}${(mapping.relativeRetention * 100).toFixed(1)}%`}</td>
                  <td><strong>{mapping.sceneOrdinal === null ? 'Unmapped' : `Scene ${mapping.sceneOrdinal}`}</strong><span>{mapping.chapter ?? 'No chapter'}</span></td>
                  <td>{mapping.visualTreatment?.replaceAll('_', ' ') ?? mapping.sourceKind ?? '—'}</td>
                  <td>{mapping.locationName ?? '—'}</td>
                  <td>{mapping.shotLengthMs === null ? '—' : `${(mapping.shotLengthMs / 1000).toFixed(1)}s`}</td>
                  <td>{mapping.voiceWordsPerMinute === null ? '—' : `${Math.round(mapping.voiceWordsPerMinute)} wpm`}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <EmptyState title="No mapped retention points" body="Choose an imported snapshot with retention observations." />}
      </Panel>

      <div className="analytics-grid">
        <Panel title="Propose a bounded policy change" subtitle="Evidence must span at least two videos and 1,000 aggregate views">
          <div className="settings-form">
            <div className="analytics-inline-fields">
              <label><span>Policy metric</span><select value={metricKey} onChange={event => setMetricKey(event.target.value as typeof metricKey)}><option value="preferredShotMinSeconds">Preferred shot minimum</option><option value="preferredShotMaxSeconds">Preferred shot maximum</option><option value="targetVideoMinutes">Target video minutes</option></select></label>
              <label><span>Proposed value</span><input type="number" min="1" max="30" step="0.1" value={proposedValue} onChange={event => setProposedValue(event.target.value)} /></label>
            </div>
            <label><span>Rationale</span><textarea rows={4} value={rationale} onChange={event => setRationale(event.target.value)} placeholder="Describe the repeated retention pattern and why this small policy adjustment is warranted." /></label>
            <div className="evidence-picker">
              <span>Evidence snapshots ({evidenceIds.size} selected)</span>
              {snapshots.map(snapshot => (
                <label key={snapshot.id}><input type="checkbox" checked={evidenceIds.has(snapshot.id)} onChange={() => toggleEvidence(snapshot.id)} /><span><strong>{projectName.get(snapshot.projectId) ?? snapshot.projectId}</strong> · day {snapshot.snapshotDay} · {snapshot.metrics.views.toLocaleString()} views</span></label>
              ))}
            </div>
            <Button busy={busy === 'propose'} disabled={evidenceIds.size < 2 || rationale.trim().length < 20 || !proposedValue} onClick={() => void propose()}><Sparkles size={15} /> Create recommendation</Button>
          </div>
        </Panel>

        <Panel title="Recommendation ledger" subtitle="Apply, reject, and rollback decisions are audit logged">
          {recommendations.length ? (
            <div className="recommendation-list">
              {recommendations.map(recommendation => (
                <article key={recommendation.id}>
                  <header><div><strong>{recommendation.metricKey}</strong><span>{String(recommendation.beforeValue)} → {String(recommendation.proposedValue)}</span></div><StatusPill value={recommendation.status} /></header>
                  <p>{recommendation.rationale}</p>
                  <small>{recommendation.evidenceVideoCount} videos · {recommendation.evidenceTotalViews.toLocaleString()} views · {recommendation.evidenceSnapshotIds.length} snapshots</small>
                  <div className="button-row">
                    {recommendation.status === 'proposed' ? <><Button busy={busy === `apply-${recommendation.id}`} onClick={() => void decide(recommendation.id, 'apply')}><Check size={14} /> Apply</Button><Button variant="danger" busy={busy === `reject-${recommendation.id}`} onClick={() => void decide(recommendation.id, 'reject')}><X size={14} /> Reject</Button></> : null}
                    {recommendation.status === 'applied' ? <Button variant="secondary" busy={busy === `rollback-${recommendation.id}`} onClick={() => void decide(recommendation.id, 'rollback')}><RotateCcw size={14} /> Roll back</Button> : null}
                  </div>
                </article>
              ))}
            </div>
          ) : <EmptyState title="No learning recommendations" body="Recommendations remain empty until an operator proposes a bounded change backed by repeated evidence." />}
        </Panel>
      </div>
    </div>
  );
}
