import { useEffect, useState, type JSX } from 'react';
import { ExternalLink, MapPin, X } from 'lucide-react';
import type { ProjectDetail } from '@shared/types';
import { Button, ProgressBar, StatusPill } from './ui';

export function ProjectDrawer({
  projectId,
  onClose,
  setError
}: {
  projectId: string | null;
  onClose: () => void;
  setError: (message: string | null) => void;
}): JSX.Element | null {
  const [project, setProject] = useState<ProjectDetail | null>(null);

  useEffect(() => {
    if (!projectId) {
      setProject(null);
      return;
    }
    window.videoFactory.projects.get(projectId)
      .then(setProject)
      .catch(error => setError(error instanceof Error ? error.message : String(error)));
  }, [projectId]);

  if (!projectId) return null;

  return (
    <div className="drawer-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}>
      <aside className="project-drawer">
        <header>
          <div>
            <span className="field-label">PROJECT {project?.sequence ?? '—'}</span>
            <h2>{project?.title ?? 'Loading…'}</h2>
          </div>
          <button className="icon-button" onClick={onClose}><X size={20} /></button>
        </header>
        {project ? (
          <div className="drawer-content">
            <div className="drawer-status">
              <StatusPill value={project.state} />
              <span>{project.envatoProjectName}</span>
            </div>
            <ProgressBar value={project.progress} label="Pipeline" />
            <div className="drawer-metrics">
              <div><span>Scenes</span><strong>{project.sceneCount}</strong></div>
              <div><span>Assets</span><strong>{project.acquiredCount}/{project.acquisitionCount}</strong></div>
              <div><span>Exceptions</span><strong>{project.openExceptions}</strong></div>
            </div>
            <section>
              <h3>Storyboard</h3>
              <div className="scene-audit">
                {project.scenes.map(scene => (
                  <div key={scene.id} className="scene-audit-row">
                    <span className="scene-number">{String(scene.ordinal).padStart(2, '0')}</span>
                    <div>
                      <strong>{scene.narration}</strong>
                      <span>
                        <MapPin size={12} />
                        {scene.requiredLocation ?? scene.requiredCity ?? scene.requiredCountry ?? 'Graphic treatment'}
                      </span>
                    </div>
                    <StatusPill value={scene.verificationState} />
                  </div>
                ))}
              </div>
            </section>
            {project.youtubeVideoId ? (
              <Button
                variant="secondary"
                onClick={() => void window.videoFactory.system.openExternal(`https://www.youtube.com/watch?v=${project.youtubeVideoId}`)}
              >
                <ExternalLink size={15} /> Open private video
              </Button>
            ) : null}
          </div>
        ) : <div className="drawer-loading">Loading project…</div>}
      </aside>
    </div>
  );
}
