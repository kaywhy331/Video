import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  Clipboard,
  Download,
  ExternalLink,
  FileCheck2,
  FolderInput,
  MapPin,
  RefreshCw
} from 'lucide-react';
import type { AcquisitionItem, ProjectSummary } from '@shared/types';
import { Button, EmptyState, Panel, ProgressBar, StatusPill } from '../components/ui';

export function DownloadsView({
  projects,
  onRefresh,
  setError
}: {
  projects: ProjectSummary[];
  onRefresh: () => Promise<void>;
  setError: (message: string | null) => void;
}) {
  const [items, setItems] = useState<AcquisitionItem[]>([]);
  const [projectId, setProjectId] = useState<string>('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const downloadProjects = projects.filter(project =>
    project.acquisitionCount > 0
    && !['PUBLISHED', 'ANALYTICS_ACTIVE', 'FAILED', 'CANCELLED', 'ARCHIVED'].includes(project.state)
  );

  useEffect(() => {
    if (!projectId && downloadProjects[0]) setProjectId(downloadProjects[0].id);
  }, [projectId, downloadProjects]);

  async function load(): Promise<void> {
    const result = await window.videoFactory.acquisitions.list(projectId || undefined) as AcquisitionItem[];
    setItems(result);
  }

  useEffect(() => { void load(); }, [projectId]);

  const pending = items.filter(item => !['COMPLETE', 'SKIPPED'].includes(item.state));
  const current = pending.find(item => ['ACTIVE_IN_BROWSER', 'WAITING_FOR_FILE'].includes(item.state))
    ?? pending[0]
    ?? null;
  const completed = items.filter(item => item.state === 'COMPLETE').length;
  const project = projects.find(item => item.id === projectId);

  async function act(id: string, action: () => Promise<unknown>): Promise<void> {
    setBusyId(id);
    setError(null);
    try {
      await action();
      await load();
      await onRefresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyId(null);
    }
  }

  async function copyProjectName(): Promise<void> {
    if (project?.envatoProjectName) await navigator.clipboard.writeText(project.envatoProjectName);
  }

  if (!downloadProjects.length) {
    return (
      <EmptyState
        title="No footage is waiting for acquisition"
        body="Autopilot will create a minimal, project-specific Envato manifest after it grounds a script in your catalog."
      />
    );
  }

  return (
    <div className="view-stack">
      <div className="page-heading">
        <div>
          <div className="eyebrow"><Download size={14} /> ACQUISITION GATE</div>
          <h1>License and download only what this project needs.</h1>
          <p>VideoFactory handles the queue, file detection, central storage, proxy creation, and verification.</p>
        </div>
        <div className="heading-controls">
          <select value={projectId} onChange={event => setProjectId(event.target.value)}>
            {downloadProjects.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
          </select>
          <Button variant="ghost" onClick={() => void load()}><RefreshCw size={15} /> Refresh</Button>
        </div>
      </div>

      <Panel className="download-command">
        <div className="download-command-top">
          <div>
            <span className="field-label">ENVATO PROJECT / LICENSE NAME</span>
            <strong className="mono-value">{project?.envatoProjectName}</strong>
          </div>
          <Button variant="secondary" onClick={() => void copyProjectName()}><Clipboard size={15} /> Copy</Button>
        </div>
        <ProgressBar
          value={items.length ? completed / items.length : 0}
          label={`${completed} of ${items.length} acquisition items complete`}
        />
      </Panel>

      {current ? (
        <div className="download-layout">
          <Panel title="Next required asset" subtitle={`Used by scene${current.requiredForScenes.length === 1 ? '' : 's'} ${current.requiredForScenes.join(', ')}`}>
            <div className="asset-focus">
              <div className="asset-focus-thumb">
                {current.thumbnailUrl
                  ? <img src={current.thumbnailUrl} alt="" />
                  : <div className="thumb-placeholder"><Download size={28} /></div>}
              </div>
              <div className="asset-focus-body">
                <div className="asset-focus-meta">
                  <StatusPill value={current.role} />
                  <StatusPill value={current.state} />
                  <span className="match-score">{Math.round(current.matchScore)} match</span>
                </div>
                <h2>{current.assetTitle}</h2>
                <div className="reason-list">
                  {current.reasons.slice(0, 5).map(reason => <span key={reason}><Check size={14} />{reason}</span>)}
                </div>
                <div className="button-row">
                  {current.role !== 'license_only' ? (
                    <Button
                      busy={busyId === current.id}
                      onClick={() => void act(current.id, () => window.videoFactory.acquisitions.open(current.id))}
                    >
                      <ExternalLink size={16} /> Open on Envato
                    </Button>
                  ) : null}
                  <Button
                    variant="secondary"
                    busy={busyId === current.id}
                    onClick={() => void act(current.id, () => window.videoFactory.acquisitions.attest({ acquisitionId: current.id }))}
                  >
                    <FileCheck2 size={16} /> License recorded
                  </Button>
                  {current.role !== 'license_only' ? (
                    <Button
                      variant="ghost"
                      busy={busyId === current.id}
                      onClick={() => void act(current.id, () => window.videoFactory.acquisitions.mapFile({ acquisitionId: current.id }))}
                    >
                      <FolderInput size={16} /> Map downloaded file
                    </Button>
                  ) : null}
                </div>
                <p className="helper-note">
                  The watched folder advances automatically after Chrome finishes the file. Temporary <code>.crdownload</code> files are ignored.
                </p>
              </div>
            </div>
          </Panel>

          <Panel title="Remaining queue" subtitle="Ordered to reduce download and licensing work">
            <div className="queue-list">
              {items.map(item => (
                <button
                  key={item.id}
                  className={`queue-item ${item.id === current.id ? 'queue-item-current' : ''}`}
                  onClick={() => item.state !== 'COMPLETE' && void act(item.id, () => window.videoFactory.acquisitions.activate(item.id))}
                >
                  <span className="queue-ordinal">{String(item.ordinal).padStart(2, '0')}</span>
                  <div className="queue-item-copy">
                    <strong>{item.assetTitle}</strong>
                    <span><MapPin size={12} /> Scenes {item.requiredForScenes.join(', ') || '—'}</span>
                  </div>
                  <StatusPill value={item.state} />
                </button>
              ))}
            </div>
          </Panel>
        </div>
      ) : (
        <EmptyState
          title="Acquisition complete"
          body="All required files and project licenses are recorded. Media verification and rendering can continue automatically."
          action={<Button onClick={() => void onRefresh()}><Check size={16} /> Return to Autopilot</Button>}
        />
      )}
    </div>
  );
}
