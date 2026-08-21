import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Database,
  Download,
  Film,
  Gauge,
  HardDrive,
  LoaderCircle,
  Pause,
  Play,
  ShieldAlert,
  Sparkles,
  UploadCloud,
  WalletCards
} from 'lucide-react';
import type {
  AppBootstrap,
  CoverageCluster,
  OpportunityAssessment,
  OutputProfileKey,
  ProjectSummary
} from '@shared/types';
import { Button, EmptyState, MetricCard, Panel, ProgressBar, StatusPill } from '../components/ui';

interface NextAction {
  label: string;
  view?: string;
  inspect?: boolean;
  automatic?: boolean;
}

const AUTOMATIC_CONTINUATION_STATES = new Set<ProjectSummary['state']>([
  'FINALIZING_SCRIPT',
  'GENERATING_VOICE',
  'BUILDING_TIMELINE',
  'RENDERING_DRAFT',
  'QC_DRAFT',
  'RENDERING_FINAL',
  'QC_FINAL',
  'UPLOADING_PRIVATE',
  'WAITING_YOUTUBE_PROCESSING'
]);

export function AutopilotView({
  bootstrap,
  onRefresh,
  onNavigate,
  onOpenProject,
  setError
}: {
  bootstrap: AppBootstrap;
  onRefresh: () => Promise<void>;
  onNavigate: (view: string) => void;
  onOpenProject: (projectId: string) => void;
  setError: (message: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const defaultChannel = bootstrap.expansion.channels.find(item => item.isDefault) ?? bootstrap.expansion.channels[0];
  const defaultLanguage = bootstrap.expansion.languages.find(item => item.isDefault) ?? bootstrap.expansion.languages[0];
  const [channelId, setChannelId] = useState(defaultChannel?.id ?? '');
  const [languageVoiceProfileId, setLanguageVoiceProfileId] = useState(defaultLanguage?.id ?? '');
  const [outputProfileKey, setOutputProfileKey] = useState<OutputProfileKey>(
    bootstrap.settings.defaultOutput === 'qualified_4k' ? 'landscape_4k' : 'landscape_1080p'
  );
  const [creationMode, setCreationMode] = useState<'automatic' | 'guided'>('automatic');
  const [coverage, setCoverage] = useState<CoverageCluster[]>([]);
  const [opportunities, setOpportunities] = useState<OpportunityAssessment[]>([]);
  const [destinationKey, setDestinationKey] = useState('');
  const [topicId, setTopicId] = useState('');
  const [targetMinutes, setTargetMinutes] = useState(bootstrap.settings.targetVideoMinutes);
  const [startingScript, setStartingScript] = useState('');
  const current = bootstrap.projects.find(project =>
    !['PUBLISHED', 'ANALYTICS_ACTIVE', 'FAILED', 'CANCELLED', 'ARCHIVED'].includes(project.state)
  ) ?? null;
  const qualifiedOpportunities = opportunities.filter(item =>
    item.feasibility === 'qualified' && (!destinationKey || item.destinationKey === destinationKey)
  );
  const canStart = creationMode === 'automatic'
    || (Boolean(destinationKey) && Number.isFinite(targetMinutes) && targetMinutes >= 1 && targetMinutes <= 30);
  const diskGb = bootstrap.operationsHealth.disk.freeBytes === null
    ? null
    : bootstrap.operationsHealth.disk.freeBytes / 1024 ** 3;
  const unhealthyProviders = bootstrap.operationsHealth.providers.filter(provider => provider.status !== 'healthy');

  useEffect(() => {
    if (current) return;
    void Promise.all([
      window.videoFactory.catalog.coverage(250),
      window.videoFactory.expansion.opportunities()
    ]).then(([nextCoverage, nextOpportunities]) => {
      setCoverage(nextCoverage);
      setOpportunities(nextOpportunities);
      setDestinationKey(value => value || nextCoverage[0]?.key || '');
    }).catch(error => setError(error instanceof Error ? error.message : String(error)));
  }, [current?.id, bootstrap.catalog.totalAssets]);

  useEffect(() => {
    if (topicId && !qualifiedOpportunities.some(item => item.topicCandidateId === topicId)) setTopicId('');
  }, [destinationKey, topicId, opportunities]);

  const nextAction = useMemo<NextAction | null>(() => {
    if (!current) return null;
    if (current.state === 'WAITING_FOR_DOWNLOADS') return { label: 'Open download queue', view: 'downloads' };
    if (current.state === 'WAITING_FINAL_APPROVAL') return { label: 'Review finished video', view: 'final-review' };
    if (current.state === 'BLOCKED_EXCEPTION') return { label: 'Review exceptions', view: 'exceptions' };
    if (AUTOMATIC_CONTINUATION_STATES.has(current.state)) {
      return { label: 'Continuing automatically', inspect: true, automatic: true };
    }
    return { label: 'Inspect current project', inspect: true };
  }, [current]);

  async function startNext(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const project = await window.videoFactory.projects.createAutopilot({
        destinationKey: creationMode === 'guided' ? destinationKey || undefined : undefined,
        targetMinutes: creationMode === 'guided' ? targetMinutes : undefined,
        topicId: creationMode === 'guided' ? topicId || undefined : undefined,
        startingScript: creationMode === 'guided' ? startingScript || undefined : undefined,
        channelId: channelId || undefined,
        languageVoiceProfileId: languageVoiceProfileId || undefined,
        outputProfileKey
      });
      onOpenProject(project.id);
      await onRefresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function executeNext(): Promise<void> {
    if (!current || !nextAction) return;
    if (nextAction.view) {
      onNavigate(nextAction.view);
      return;
    }
    if (nextAction.inspect) {
      onOpenProject(current.id);
    }
  }

  async function runScheduler(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await window.videoFactory.scheduler.evaluate();
      await onRefresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function toggleAutopilot(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await window.videoFactory.settings.update({
        autopilotSchedulerEnabled: !bootstrap.settings.autopilotSchedulerEnabled
      });
      await window.videoFactory.scheduler.evaluate();
      await onRefresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="view-stack">
      <div className="hero-strip">
        <div>
          <div className="eyebrow"><Sparkles size={14} /> AUTOPILOT CONTROL</div>
          <h1>Produce the next accurate video with minimal intervention.</h1>
          <p>The catalog constrains the topic, footage is exact-location gated, and clean projects stop only for acquisition and final approval.</p>
        </div>
        <div className="hero-actions">
          <Button
            variant="secondary"
            busy={busy}
            onClick={() => void toggleAutopilot()}
            aria-label={bootstrap.settings.autopilotSchedulerEnabled
              ? 'Pause new Autopilot projects; current projects continue'
              : 'Resume new Autopilot projects'}
          >
            {bootstrap.settings.autopilotSchedulerEnabled ? <Pause size={16} /> : <Play size={16} />}
            {bootstrap.settings.autopilotSchedulerEnabled ? 'Pause new projects' : 'Resume new projects'}
          </Button>
          <Button busy={busy} disabled={!current && !canStart} onClick={current ? executeNext : startNext}>
            {current ? (nextAction?.automatic ? 'Inspect project' : nextAction?.label) : 'Start first video'} <ArrowRight size={16} />
          </Button>
        </div>
      </div>

      <Panel
        title="Operations health"
        subtitle="Live worker activity and the hard gates checked before provider calls or new projects"
        action={<StatusPill value={bootstrap.diagnostics?.status ?? 'checking'} />}
      >
        <div className="operations-health-grid">
          <div><div><Gauge size={17} /><span>Media worker</span></div><strong>{bootstrap.operationsHealth.workers.media}</strong><small>{bootstrap.queue.runningJobs} running · {bootstrap.queue.queuedJobs} queued</small></div>
          <div><div><Film size={17} /><span>Render</span></div><strong>{bootstrap.operationsHealth.workers.render}</strong><small>{bootstrap.operationsHealth.workers.runningTypes.filter(type => type.startsWith('render_')).join(', ') || 'No render job running'}</small></div>
          <div><div><UploadCloud size={17} /><span>Upload</span></div><strong>{bootstrap.operationsHealth.workers.upload}</strong><small>{current && ['UPLOADING_PRIVATE', 'WAITING_YOUTUBE_PROCESSING'].includes(current.state) ? current.state.replaceAll('_', ' ') : 'No upload job running'}</small></div>
          <div className={`health-${bootstrap.operationsHealth.disk.status}`}><div><HardDrive size={17} /><span>Disk</span></div><strong>{diskGb === null ? 'Unavailable' : `${diskGb.toFixed(1)} GB free`}</strong><small>{(bootstrap.operationsHealth.disk.minimumBytes / 1024 ** 3).toFixed(1)} GB minimum · {bootstrap.operationsHealth.disk.status}</small></div>
          <div className={`health-${bootstrap.operationsHealth.budget.status}`}><div><WalletCards size={17} /><span>API budget</span></div><strong>${bootstrap.operationsHealth.budget.remainingUsd.toFixed(2)} remaining</strong><small>${bootstrap.operationsHealth.budget.spentUsd.toFixed(2)} of ${bootstrap.operationsHealth.budget.limitUsd.toFixed(2)} this month · {bootstrap.operationsHealth.budget.status}</small></div>
          <div className={unhealthyProviders.length ? 'health-blocked' : 'health-healthy'}><div><ShieldAlert size={17} /><span>Providers</span></div><strong>{unhealthyProviders.length ? `${unhealthyProviders.length} unhealthy` : 'No hard health gate'}</strong><small>{unhealthyProviders.map(provider => `${provider.provider}: ${provider.status}`).join(' · ') || `${bootstrap.operationsHealth.providers.length} provider health receipt(s)`}</small></div>
        </div>
      </Panel>

      <div className="metric-grid">
        <MetricCard
          label="Catalog"
          value={bootstrap.catalog.totalAssets.toLocaleString()}
          detail={`${bootstrap.catalog.countries} countries · ${bootstrap.catalog.locations} exact locations`}
          icon={<Database size={18} />}
        />
        <MetricCard
          label="Waiting downloads"
          value={bootstrap.queue.waitingDownloads}
          detail="Routine operator gate"
          icon={<Download size={18} />}
        />
        <MetricCard
          label="Waiting approval"
          value={bootstrap.queue.waitingApproval}
          detail="Private uploads only"
          icon={<Film size={18} />}
        />
        <MetricCard
          label="Open exceptions"
          value={bootstrap.queue.openExceptions}
          detail={bootstrap.queue.openExceptions ? 'Automation needs attention' : 'No blockers'}
          icon={<ShieldAlert size={18} />}
        />
      </div>

      <Panel
        title="Publication cadence"
        subtitle="Queue, provider budget, authentication, and disk gates are re-evaluated before project creation"
        action={<StatusPill value={bootstrap.scheduler.state} />}
      >
        <div className="production-stats">
          <span><strong>{bootstrap.scheduler.enabled ? 'Enabled' : 'Disabled'}</strong> scheduler</span>
          <span><strong>{bootstrap.scheduler.nextRunAt ? new Date(bootstrap.scheduler.nextRunAt).toLocaleString() : 'Not scheduled'}</strong> next cadence</span>
          <span>{bootstrap.scheduler.reason ?? 'All automatic-start gates are currently clear.'}</span>
          <span>Pausing prevents new project creation; work already in progress continues to its next safe operator gate.</span>
          <Button variant="secondary" busy={busy} onClick={() => void runScheduler()}>Evaluate now</Button>
          <Button variant="secondary" busy={busy} onClick={() => void toggleAutopilot()}>
            {bootstrap.settings.autopilotSchedulerEnabled ? <Pause size={14} /> : <Play size={14} />}
            {bootstrap.settings.autopilotSchedulerEnabled ? 'Pause new projects' : 'Resume new projects'}
          </Button>
        </div>
      </Panel>

      {!current ? (
        <Panel title="Next project" subtitle="Choose full Autopilot or guide only the bounded, catalog-qualified inputs">
          <div className="creation-mode-tabs">
            <button className={creationMode === 'automatic' ? 'active' : ''} onClick={() => setCreationMode('automatic')}>
              Full Autopilot
            </button>
            <button className={creationMode === 'guided' ? 'active' : ''} onClick={() => setCreationMode('guided')}>
              Guided
            </button>
          </div>
          <div className="project-profile-picker">
            <label><span>Channel</span><select value={channelId} onChange={event => setChannelId(event.target.value)}>{bootstrap.expansion.channels.filter(item => item.active).map(channel => <option key={channel.id} value={channel.id}>{channel.name} · {channel.shortCode}</option>)}</select></label>
            <label><span>Language / voice</span><select value={languageVoiceProfileId} onChange={event => setLanguageVoiceProfileId(event.target.value)}>{bootstrap.expansion.languages.filter(item => item.active).map(language => <option key={language.id} value={language.id}>{language.displayName}</option>)}</select></label>
            <label><span>Output</span><select value={outputProfileKey} onChange={event => setOutputProfileKey(event.target.value as OutputProfileKey)}>{bootstrap.expansion.outputProfiles.filter(item => item.active).map(profile => <option key={profile.id} value={profile.profileKey}>{profile.displayName} · {profile.width}×{profile.height}</option>)}</select></label>
            {creationMode === 'guided' ? (
              <>
                <label>
                  <span>Destination</span>
                  <select value={destinationKey} onChange={event => setDestinationKey(event.target.value)}>
                    {coverage.map(cluster => (
                      <option key={cluster.key} value={cluster.key}>
                        {cluster.locationName ?? cluster.city ?? cluster.country ?? cluster.key} · {cluster.assetCount} assets
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Qualified topic</span>
                  <select value={topicId} onChange={event => setTopicId(event.target.value)}>
                    <option value="">Generate a coverage-qualified visual guide</option>
                    {qualifiedOpportunities.map(topic => (
                      <option key={topic.topicCandidateId} value={topic.topicCandidateId}>
                        {topic.title} · score {Math.round(topic.opportunityScore)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Target duration</span>
                  <input
                    type="number"
                    min={1}
                    max={30}
                    step={0.5}
                    value={targetMinutes}
                    onChange={event => setTargetMinutes(Number(event.target.value))}
                  />
                </label>
                <label className="project-guidance-script">
                  <span>Starting script (optional)</span>
                  <textarea
                    maxLength={20_000}
                    rows={7}
                    value={startingScript}
                    placeholder="Paste an outline or draft to guide tone, pacing, structure, and catalog-grounded emphasis."
                    onChange={event => setStartingScript(event.target.value)}
                  />
                  <small>
                    Guidance only, not evidence. Factual wording is omitted unless independently supported by accepted research or catalog metadata. {startingScript.length.toLocaleString()}/20,000
                  </small>
                </label>
              </>
            ) : null}
            <p>
              {creationMode === 'guided'
                ? 'Destination, topic, duration, and safe editorial guidance are snapshotted immutably. Coverage is revalidated before any project or provider call begins.'
                : 'Autopilot selects the strongest current destination and topic. Channel, voice, output, and all qualification evidence are snapshotted immutably.'}
            </p>
          </div>
        </Panel>
      ) : null}

      {current ? (
        <Panel
          title="Current production"
          subtitle={current.destination ?? current.topic}
          action={<StatusPill value={current.state} />}
          className="current-production"
        >
          <div className="production-grid">
            <div className="production-main">
              <div className="project-kicker">{current.envatoProjectName}</div>
              <h3>{current.title}</h3>
              <ProgressBar value={current.progress} label="Pipeline progress" />
              <div className="production-stats">
                <span><strong>{current.sceneCount}</strong> scenes</span>
                <span><strong>{current.acquiredCount}/{current.acquisitionCount}</strong> assets acquired</span>
                <span><strong>{Math.round(current.targetDurationMs / 60_000)}</strong> min target</span>
              </div>
            </div>
            <div className="next-action-card" aria-live="polite">
              {nextAction?.automatic ? <LoaderCircle size={22} className="spin" /> : <Gauge size={22} />}
              <span>{nextAction?.automatic ? 'Pipeline status' : 'Next action'}</span>
              <strong>{nextAction?.label}</strong>
              <Button variant="secondary" busy={busy} onClick={executeNext}>
                {nextAction?.automatic ? 'Inspect project' : 'Continue'} <ArrowRight size={15} />
              </Button>
            </div>
          </div>
        </Panel>
      ) : (
        <EmptyState
          title="No production is active"
          body="Import the footage catalog, then let Autopilot select the strongest visually supportable destination."
          action={<Button busy={busy} disabled={!canStart} onClick={startNext}><Play size={16} /> Start first video</Button>}
        />
      )}

      <div className="split-grid">
        <Panel title="Production queue" subtitle="Most recent projects">
          <div className="list-stack">
            {bootstrap.projects.slice(0, 6).map(project => (
              <button key={project.id} className="project-row" onClick={() => onOpenProject(project.id)}>
                <div className="project-row-index">{String(project.sequence).padStart(2, '0')}</div>
                <div className="project-row-body">
                  <strong>{project.title}</strong>
                  <span>{project.destination ?? project.topic}</span>
                </div>
                <ProgressBar value={project.progress} />
                <StatusPill value={project.state} />
              </button>
            ))}
            {!bootstrap.projects.length ? <div className="muted-row">No projects yet.</div> : null}
          </div>
        </Panel>

        <Panel
          title="Attention required"
          subtitle="Only exceptions are surfaced"
          action={bootstrap.exceptions.length
            ? <button className="text-link" onClick={() => onNavigate('exceptions')}>View all</button>
            : null}
        >
          <div className="list-stack">
            {bootstrap.exceptions.slice(0, 5).map(exception => (
              <button key={exception.id} className="exception-row" onClick={() => onNavigate('exceptions')}>
                <span className={`severity-dot severity-${exception.severity.toLowerCase()}`} />
                <div>
                  <strong>{exception.title}</strong>
                  <span>{exception.message}</span>
                </div>
                <StatusPill value={exception.severity} />
              </button>
            ))}
            {!bootstrap.exceptions.length ? (
              <div className="clean-state"><Sparkles size={18} /><span>No exceptions are blocking automation.</span></div>
            ) : null}
          </div>
        </Panel>
      </div>
    </div>
  );
}
