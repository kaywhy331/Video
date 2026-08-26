import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  Bot,
  Database,
  Download,
  Film,
  FolderCog,
  Menu,
  Settings,
  Sparkles,
  X
} from 'lucide-react';
import type { AppBootstrap, CatalogImportOperationStatus, ProgressEvent } from '@shared/types';
import { canTransitionProject } from '@shared/state-machine';
import { resolveOperatorShortcut, selectOperatorTarget } from '@shared/operator-shortcuts';
import { ErrorBanner, StatusPill } from './components/ui';
import { AutopilotView } from './views/AutopilotView';
import { ExceptionsView } from './views/ExceptionsView';
import { LibraryView } from './views/LibraryView';
import { SettingsView } from './views/SettingsView';

const loadDownloadsView = () => import('./views/DownloadsView');
const loadFinalReviewView = () => import('./views/FinalReviewView');
const loadAnalyticsView = () => import('./views/AnalyticsView');
const loadProjectDrawer = () => import('./components/ProjectDrawer');

const DownloadsView = lazy(() => loadDownloadsView()
  .then(module => ({ default: module.DownloadsView })));
const FinalReviewView = lazy(() => loadFinalReviewView()
  .then(module => ({ default: module.FinalReviewView })));
const AnalyticsView = lazy(() => loadAnalyticsView()
  .then(module => ({ default: module.AnalyticsView })));
const ProjectDrawer = lazy(() => loadProjectDrawer()
  .then(module => ({ default: module.ProjectDrawer })));

function preloadWorkspaceViews(): void {
  void Promise.all([
    loadDownloadsView(),
    loadFinalReviewView(),
    loadAnalyticsView(),
    loadProjectDrawer()
  ]).catch(() => undefined);
}

type ViewId = 'autopilot' | 'downloads' | 'final-review' | 'library' | 'analytics' | 'exceptions' | 'settings';

const NAV: Array<{ id: ViewId; label: string; icon: typeof Bot }> = [
  { id: 'autopilot', label: 'Autopilot', icon: Bot },
  { id: 'downloads', label: 'Downloads', icon: Download },
  { id: 'final-review', label: 'Final Review', icon: Film },
  { id: 'library', label: 'Library', icon: Database },
  { id: 'analytics', label: 'Analytics', icon: BarChart3 },
  { id: 'settings', label: 'Settings', icon: Settings }
];

export default function App() {
  const [bootstrap, setBootstrap] = useState<AppBootstrap | null>(null);
  const [view, setView] = useState<ViewId>('autopilot');
  const [error, setError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [catalogOperation, setCatalogOperation] = useState<CatalogImportOperationStatus | null>(null);
  const [catalogCancelId, setCatalogCancelId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const dashboardReady = bootstrap !== null;

  const refresh = useCallback(async (): Promise<void> => {
    setBootstrap(await window.videoFactory.app.bootstrap());
  }, []);

  useEffect(() => {
    void refresh().catch(err => setError(err instanceof Error ? err.message : String(err)));
    const unsubscribeProgress = window.videoFactory.app.onProgress(event => {
      setProgress(event);
      if (event.progress >= 1) {
        setTimeout(() => setProgress(current => current?.jobId === event.jobId ? null : current), 3500);
      }
    });
    const unsubscribeState = window.videoFactory.app.onState(snapshot => {
      setBootstrap(current => current ? { ...current, ...snapshot } : current);
    });
    return () => {
      unsubscribeProgress();
      unsubscribeState();
    };
  }, [refresh]);

  useEffect(() => {
    if (!dashboardReady) return;
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        preloadWorkspaceViews();
        void window.videoFactory.app.rendererReady().catch(() => undefined);
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
    };
  }, [dashboardReady]);

  useEffect(() => {
    let disposed = false;
    let polling = false;
    const poll = async (): Promise<void> => {
      if (polling) return;
      polling = true;
      try {
        const status = await window.videoFactory.catalog.importStatus();
        if (disposed) return;
        setCatalogOperation(status);
        if (!status) setCatalogCancelId(null);
        else setCatalogCancelId(current => current && current !== status.operationId ? null : current);
      } catch {
        // Shutdown can reject renderer requests after admission closes; no stale control is safer.
        if (!disposed) setCatalogOperation(null);
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 750);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!bootstrap) return;
    const handleShortcut = (event: KeyboardEvent): void => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const editableTarget = Boolean(
        target?.isContentEditable
        || target?.matches('input, textarea, select, [contenteditable="true"]')
      );
      const shortcut = resolveOperatorShortcut({
        key: event.key,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        repeat: event.repeat,
        editableTarget
      });
      if (!shortcut) return;
      event.preventDefault();
      event.stopPropagation();
      const preferredProjectId = projectId;

      if (shortcut === 'next_download') {
        setProjectId(null);
        setView('downloads');
        return;
      }
      if (shortcut === 'open_exception') {
        setProjectId(null);
        setView('exceptions');
        return;
      }

      void (async () => {
        setError(null);
        try {
          if (shortcut === 'retry') {
            setProjectId(null);
            setView('exceptions');
            const retryable = selectOperatorTarget(
              bootstrap.exceptions.filter(item => item.retryAction).map(item => ({ ...item, projectId: item.projectId })),
              preferredProjectId
            );
            if (!retryable) {
              setError('No open exception has a safe retry action.');
              return;
            }
            const result = await window.videoFactory.exceptions.retry(retryable.id);
            if (result.status === 'OPEN') setError(`Retry completed but “${result.title}” remains open. Review its latest evidence.`);
            await refresh();
            return;
          }
          if (shortcut === 'pause') {
            const target = selectOperatorTarget(bootstrap.projects.filter(project =>
              !['SCHEDULED', 'PAUSED', 'BLOCKED_EXCEPTION'].includes(project.state)
              && canTransitionProject(project.state, 'PAUSED')
            ).map(project => ({ id: project.id, projectId: project.id, createdAt: project.createdAt })), preferredProjectId);
            const pausable = target ? bootstrap.projects.find(project => project.id === target.id) : null;
            if (!pausable) {
              setError('No active project can be paused at this checkpoint.');
              return;
            }
            if (!window.confirm(`Pause “${pausable.title}” at its next safe checkpoint?`)) return;
            await window.videoFactory.projects.pause(pausable.id);
            await refresh();
            return;
          }
          setProjectId(null);
          setView('final-review');
          const target = selectOperatorTarget(bootstrap.projects.filter(project => project.state === 'WAITING_FINAL_APPROVAL')
            .map(project => ({ id: project.id, projectId: project.id, createdAt: project.createdAt })), preferredProjectId);
          const approvable = target ? bootstrap.projects.find(project => project.id === target.id) : null;
          if (!approvable) return;
          const review = await window.videoFactory.finalReview.get(approvable.id);
          if (!review.canApprove) {
            setError('The current final review has unresolved processing, package, or QC prerequisites.');
            return;
          }
          if (!window.confirm(`Approve and publish “${approvable.title}” now?`)) return;
          await window.videoFactory.youtube.approve({ projectId: approvable.id, action: 'publish' });
          await refresh();
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })();
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [bootstrap, projectId, refresh]);

  async function cancelCatalogOperation(): Promise<void> {
    const operation = catalogOperation;
    if (!operation || catalogCancelId === operation.operationId) return;
    setCatalogCancelId(operation.operationId);
    setCatalogOperation(current => current?.operationId === operation.operationId
      ? { ...current, state: 'cancelling', phase: 'cancelling', message: 'Cancelling safely…' }
      : current);
    try {
      await window.videoFactory.catalog.cancelOperation(operation.operationId);
    } catch (err) {
      setCatalogCancelId(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const activeLabel = useMemo(() => NAV.find(item => item.id === view)?.label ?? 'VideoFactory', [view]);

  if (!bootstrap) {
    return (
      <div className="boot-screen">
        <div className="brand-mark"><Sparkles size={24} /></div>
        <h1>VideoFactory Desktop</h1>
        <p>Starting local database, media services, and download watcher…</p>
        {error ? <ErrorBanner message={error} /> : <div className="boot-loader" />}
      </div>
    );
  }

  return (
    <div className={`app-shell ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="brand-mark"><Sparkles size={19} /></div>
          <div><strong>VideoFactory</strong><span>DESKTOP AUTOPILOT</span></div>
        </div>

        <nav>
          {NAV.map(item => {
            const Icon = item.icon;
            const badge = item.id === 'downloads'
              ? bootstrap.queue.waitingDownloads
              : item.id === 'final-review'
                ? bootstrap.queue.waitingApproval
                : 0;
            return (
              <button
                key={item.id}
                className={view === item.id ? 'nav-active' : ''}
                onClick={() => setView(item.id)}
                aria-keyshortcuts={item.id === 'downloads'
                  ? 'Control+Alt+D'
                  : item.id === 'final-review' ? 'Control+Alt+A' : undefined}
              >
                <Icon size={18} />
                <span>{item.label}</span>
                {badge ? <i>{badge}</i> : null}
              </button>
            );
          })}
          <button
            className={view === 'exceptions' ? 'nav-active nav-exception' : 'nav-exception'}
            onClick={() => setView('exceptions')}
            aria-keyshortcuts="Control+Alt+E"
          >
            <AlertTriangle size={18} />
            <span>Exceptions</span>
            {bootstrap.queue.openExceptions ? <i>{bootstrap.queue.openExceptions}</i> : null}
          </button>
        </nav>

        <div className="sidebar-health">
          <div className="health-title"><FolderCog size={15} /> Local system</div>
          <div><span>Catalog</span><strong>{bootstrap.catalog.totalAssets.toLocaleString()}</strong></div>
          <div><span>FFmpeg</span><StatusPill value={bootstrap.diagnostics ? (bootstrap.diagnostics.ffmpeg.found ? 'ready' : 'missing') : 'checking'} /></div>
          <div><span>Database</span><StatusPill value={bootstrap.diagnostics ? (bootstrap.diagnostics.database.integrity === 'ok' ? 'healthy' : 'check') : 'checking'} /></div>
        </div>
      </aside>

      <main className="main-shell">
        <header className="topbar">
          <div className="topbar-left">
            <button className="icon-button" onClick={() => setSidebarOpen(value => !value)} aria-label="Toggle navigation sidebar"><Menu size={19} /></button>
            <div><span>WORKSPACE</span><strong>{activeLabel}</strong></div>
          </div>
          <div className="topbar-status">
            <div><span className="status-light" /> Autopilot services active</div>
            <span>{bootstrap.queue.runningJobs} running · {bootstrap.queue.queuedJobs} queued</span>
            <span
              className="shortcut-hint"
              title="Ctrl+Alt+D next download · R retry · A approve · P pause · E exceptions"
              aria-label="Operator shortcuts: Control Alt D next download, R retry, A approve, P pause, E open exceptions"
            >Ctrl+Alt+D/R/A/P/E</span>
          </div>
        </header>

        <div className="content">
          {error ? <ErrorBanner message={error} onDismiss={() => setError(null)} /> : null}

          <Suspense fallback={<div className="empty-state" role="status">Loading workspace…</div>}>
            {view === 'autopilot' ? (
              <AutopilotView
                bootstrap={bootstrap}
                onRefresh={refresh}
                onNavigate={target => setView(target as ViewId)}
                onOpenProject={setProjectId}
                setError={setError}
              />
            ) : null}
            {view === 'downloads' ? (
              <DownloadsView projects={bootstrap.projects} onRefresh={refresh} setError={setError} />
            ) : null}
            {view === 'final-review' ? (
              <FinalReviewView projects={bootstrap.projects} onRefresh={refresh} setError={setError} />
            ) : null}
            {view === 'library' ? (
              <LibraryView initialStats={bootstrap.catalog} onRefresh={refresh} setError={setError} />
            ) : null}
            {view === 'analytics' ? (
              <AnalyticsView projects={bootstrap.projects} onRefresh={refresh} />
            ) : null}
            {view === 'exceptions' ? (
              <ExceptionsView onRefresh={refresh} onOpenProject={setProjectId} setError={setError} />
            ) : null}
            {view === 'settings' ? (
              <SettingsView bootstrap={bootstrap} onRefresh={refresh} setError={setError} />
            ) : null}
          </Suspense>
        </div>
      </main>

      {catalogOperation ? (
        <div className="progress-toast catalog-operation-toast" role="status" aria-live="polite">
          <div>
            <span>{catalogOperation.operation.replaceAll('_', ' ')} · {catalogOperation.phase.replaceAll('_', ' ')}</span>
            <strong>{catalogOperation.message}</strong>
          </div>
          <button
            className="operation-cancel"
            disabled={catalogCancelId === catalogOperation.operationId}
            onClick={() => void cancelCatalogOperation()}
          >
            <X size={14} /> {catalogCancelId === catalogOperation.operationId ? 'Cancelling…' : 'Cancel'}
          </button>
          <div className="toast-progress">
            <i style={{ width: `${Math.round(Math.max(0, Math.min(1, catalogOperation.progress)) * 100)}%` }} />
          </div>
        </div>
      ) : progress ? (
        <div className="progress-toast">
          <div>
            <span>{progress.type.replaceAll('_', ' ')}</span>
            <strong>{progress.message}</strong>
          </div>
          <div className="toast-progress"><i style={{ width: `${Math.round(progress.progress * 100)}%` }} /></div>
          <button onClick={() => setProgress(null)}><X size={14} /></button>
        </div>
      ) : null}

      {projectId ? (
        <Suspense fallback={null}>
          <ProjectDrawer
            projectId={projectId}
            onClose={() => setProjectId(null)}
            onRefresh={refresh}
            setError={setError}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
