import { useEffect, useState, type JSX, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import type { FourKBlocker, MusicTrack, ProjectDetail, ProjectMusicSelection } from '@shared/types';
import {
  PROJECT_TABS,
  ProjectTabPanel,
  type ProjectTab,
  type ProjectWorkspaceBusyAction
} from './ProjectDetailPanels';

export function ProjectDrawer({ projectId, onClose, onRefresh, setError }: {
  projectId: string | null;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  setError: (message: string | null) => void;
}): JSX.Element | null {
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [fourKBlockers, setFourKBlockers] = useState<FourKBlocker[]>([]);
  const [musicTracks, setMusicTracks] = useState<MusicTrack[]>([]);
  const [musicSelection, setMusicSelection] = useState<ProjectMusicSelection | null>(null);
  const [selectedMusicId, setSelectedMusicId] = useState('');
  const [busy, setBusy] = useState<ProjectWorkspaceBusyAction>(null);
  const [activeTab, setActiveTab] = useState<ProjectTab>('overview');

  const refresh = async (): Promise<void> => {
    if (!projectId) return;
    const [nextProject, blockers, tracks, selection] = await Promise.all([
      window.videoFactory.projects.get(projectId),
      window.videoFactory.renders.fourKBlockers(projectId),
      window.videoFactory.music.list(),
      window.videoFactory.music.selection(projectId)
    ]);
    setProject(nextProject);
    setFourKBlockers(blockers);
    setMusicTracks(tracks);
    setMusicSelection(selection);
    setSelectedMusicId(selection?.musicTrackId ?? tracks[0]?.id ?? '');
  };

  const selectMusic = async (): Promise<void> => {
    if (!projectId || !selectedMusicId) return;
    setBusy('music');
    setError(null);
    try {
      setMusicSelection(await window.videoFactory.music.select(projectId, selectedMusicId, 'human'));
      await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const run = async (kind: 'export' | 'rebuild'): Promise<void> => {
    if (!projectId) return;
    setBusy(kind);
    setError(null);
    try {
      if (kind === 'export') {
        const report = await window.videoFactory.projects.export({ projectId, includeOriginals: false, includeFinalOutput: true });
        if (report?.exportPath) await window.videoFactory.system.openPath(report.exportPath);
      } else {
        await window.videoFactory.projects.rebuildDerivatives(projectId);
      }
      await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const lifecycle = async (kind: 'pause' | 'resume' | 'cancel' | 'archive'): Promise<void> => {
    if (!projectId) return;
    if (kind === 'cancel' && !window.confirm('Cancel this project? Production stops permanently, but its audit history remains available for archival.')) return;
    if (kind === 'archive' && !window.confirm('Archive this inactive project? It will leave the active production queue.')) return;
    setBusy(kind);
    setError(null);
    try {
      setProject(await window.videoFactory.projects[kind](projectId));
      await Promise.all([refresh(), onRefresh()]);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    setActiveTab('overview');
    if (!projectId) {
      setProject(null);
      setFourKBlockers([]);
      setMusicTracks([]);
      setMusicSelection(null);
      setSelectedMusicId('');
      return;
    }
    void refresh().catch(error => setError(error instanceof Error ? error.message : String(error)));
  }, [projectId]);

  const moveTabFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % PROJECT_TABS.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + PROJECT_TABS.length) % PROJECT_TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = PROJECT_TABS.length - 1;
    else return;
    event.preventDefault();
    setActiveTab(PROJECT_TABS[next]![0]);
    document.getElementById(`project-tab-${PROJECT_TABS[next]![0]}`)?.focus();
  };

  if (!projectId) return null;
  return (
    <div className="drawer-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}>
      <aside className="project-drawer" aria-label="Project detail workspace">
        <header>
          <div><span className="field-label">PROJECT {project?.sequence ?? '—'}</span><h2>{project?.title ?? 'Loading…'}</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="Close project details"><X size={20} /></button>
        </header>
        {project ? (
          <div className="drawer-workspace">
            <div className="project-tabs" role="tablist" aria-label="Project detail sections">
              {PROJECT_TABS.map(([id, label], index) => (
                <button key={id} id={`project-tab-${id}`} role="tab" aria-selected={activeTab === id}
                  aria-controls={`project-panel-${id}`} tabIndex={activeTab === id ? 0 : -1}
                  className={activeTab === id ? 'active' : ''} onClick={() => setActiveTab(id)}
                  onKeyDown={event => moveTabFocus(event, index)}>{label}</button>
              ))}
            </div>
            <div className="drawer-content" id={`project-panel-${activeTab}`} role="tabpanel"
              aria-labelledby={`project-tab-${activeTab}`} tabIndex={0}>
              <ProjectTabPanel
                tab={activeTab}
                project={project}
                fourKBlockers={fourKBlockers}
                musicTracks={musicTracks}
                musicSelection={musicSelection}
                selectedMusicId={selectedMusicId}
                busy={busy}
                setSelectedMusicId={setSelectedMusicId}
                selectMusic={selectMusic}
                lifecycle={lifecycle}
                run={run}
                setError={setError}
                onStoryboardChanged={async nextProject => {
                  setProject(nextProject);
                  await Promise.all([refresh(), onRefresh()]);
                }}
              />
            </div>
          </div>
        ) : <div className="drawer-loading">Loading project…</div>}
      </aside>
    </div>
  );
}
