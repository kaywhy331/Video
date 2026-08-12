import { useMemo, useState } from 'react';
import {
  ArrowRight,
  Database,
  Download,
  Film,
  Gauge,
  Play,
  ShieldAlert,
  Sparkles
} from 'lucide-react';
import type { AppBootstrap, ProjectSummary } from '@shared/types';
import { Button, EmptyState, MetricCard, Panel, ProgressBar, StatusPill } from '../components/ui';

interface NextAction {
  label: string;
  view?: string;
  advance?: boolean;
  inspect?: boolean;
}

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
  const current = bootstrap.projects.find(project =>
    !['PUBLISHED', 'ANALYTICS_ACTIVE', 'FAILED', 'CANCELLED', 'ARCHIVED', 'PAUSED'].includes(project.state)
  ) ?? bootstrap.projects[0];

  const nextAction = useMemo<NextAction | null>(() => {
    if (!current) return null;
    if (current.state === 'WAITING_FOR_DOWNLOADS') return { label: 'Open download queue', view: 'downloads' };
    if (current.state === 'WAITING_FINAL_APPROVAL') return { label: 'Review finished video', view: 'final-review' };
    if (current.state === 'BUILDING_TIMELINE') return { label: 'Render draft automatically', advance: true };
    if (current.state === 'QC_DRAFT') return { label: 'Render final video', advance: true };
    if (current.state === 'BLOCKED_EXCEPTION') return { label: 'Review exceptions', view: 'exceptions' };
    return { label: 'Inspect current project', inspect: true };
  }, [current]);

  async function startNext(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const project = await window.videoFactory.projects.createAutopilot({});
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
      return;
    }
    if (nextAction.advance) {
      setBusy(true);
      setError(null);
      try {
        await window.videoFactory.projects.advance(current.id);
        await onRefresh();
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
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
        <Button busy={busy} onClick={current ? executeNext : startNext}>
          {current ? nextAction?.label : 'Start first video'} <ArrowRight size={16} />
        </Button>
      </div>

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
            <div className="next-action-card">
              <Gauge size={22} />
              <span>Next action</span>
              <strong>{nextAction?.label}</strong>
              <Button variant="secondary" busy={busy} onClick={executeNext}>Continue <ArrowRight size={15} /></Button>
            </div>
          </div>
        </Panel>
      ) : (
        <EmptyState
          title="No production is active"
          body="Import the footage catalog, then let Autopilot select the strongest visually supportable destination."
          action={<Button busy={busy} onClick={startNext}><Play size={16} /> Start first video</Button>}
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
