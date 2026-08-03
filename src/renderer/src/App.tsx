import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
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
import type { AppBootstrap, ProgressEvent } from '@shared/types';
import { ErrorBanner, StatusPill } from './components/ui';
import { ProjectDrawer } from './components/ProjectDrawer';
import { AutopilotView } from './views/AutopilotView';
import { DownloadsView } from './views/DownloadsView';
import { ExceptionsView } from './views/ExceptionsView';
import { FinalReviewView } from './views/FinalReviewView';
import { LibraryView } from './views/LibraryView';
import { SettingsView } from './views/SettingsView';

type ViewId = 'autopilot' | 'downloads' | 'final-review' | 'library' | 'exceptions' | 'settings';

const NAV: Array<{ id: ViewId; label: string; icon: typeof Bot }> = [
  { id: 'autopilot', label: 'Autopilot', icon: Bot },
  { id: 'downloads', label: 'Downloads', icon: Download },
  { id: 'final-review', label: 'Final Review', icon: Film },
  { id: 'library', label: 'Library', icon: Database },
  { id: 'settings', label: 'Settings', icon: Settings }
];

export default function App() {
  const [bootstrap, setBootstrap] = useState<AppBootstrap | null>(null);
  const [view, setView] = useState<ViewId>('autopilot');
  const [error, setError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);

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
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribeState = window.videoFactory.app.onState(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 150);
    });
    return () => {
      unsubscribeProgress();
      unsubscribeState();
      if (timer) clearTimeout(timer);
    };
  }, [refresh]);

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
          >
            <AlertTriangle size={18} />
            <span>Exceptions</span>
            {bootstrap.queue.openExceptions ? <i>{bootstrap.queue.openExceptions}</i> : null}
          </button>
        </nav>

        <div className="sidebar-health">
          <div className="health-title"><FolderCog size={15} /> Local system</div>
          <div><span>Catalog</span><strong>{bootstrap.catalog.totalAssets.toLocaleString()}</strong></div>
          <div><span>FFmpeg</span><StatusPill value={bootstrap.diagnostics.ffmpeg.found ? 'ready' : 'missing'} /></div>
          <div><span>Database</span><StatusPill value={bootstrap.diagnostics.database.integrity === 'ok' ? 'healthy' : 'check'} /></div>
        </div>
      </aside>

      <main className="main-shell">
        <header className="topbar">
          <div className="topbar-left">
            <button className="icon-button" onClick={() => setSidebarOpen(value => !value)}><Menu size={19} /></button>
            <div><span>WORKSPACE</span><strong>{activeLabel}</strong></div>
          </div>
          <div className="topbar-status">
            <div><span className="status-light" /> Autopilot services active</div>
            <span>{bootstrap.queue.runningJobs} running · {bootstrap.queue.queuedJobs} queued</span>
          </div>
        </header>

        <div className="content">
          {error ? <ErrorBanner message={error} onDismiss={() => setError(null)} /> : null}

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
          {view === 'exceptions' ? (
            <ExceptionsView onRefresh={refresh} setError={setError} />
          ) : null}
          {view === 'settings' ? (
            <SettingsView bootstrap={bootstrap} onRefresh={refresh} setError={setError} />
          ) : null}
        </div>
      </main>

      {progress ? (
        <div className="progress-toast">
          <div>
            <span>{progress.type.replaceAll('_', ' ')}</span>
            <strong>{progress.message}</strong>
          </div>
          <div className="toast-progress"><i style={{ width: `${Math.round(progress.progress * 100)}%` }} /></div>
          <button onClick={() => setProgress(null)}><X size={14} /></button>
        </div>
      ) : null}

      <ProjectDrawer projectId={projectId} onClose={() => setProjectId(null)} setError={setError} />
    </div>
  );
}
