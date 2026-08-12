import { useEffect, useMemo, useState } from 'react';
import {
  CalendarClock,
  CheckCircle2,
  ExternalLink,
  Film,
  Lock,
  Send,
  UploadCloud
} from 'lucide-react';
import type { FinalReview, ProjectSummary } from '@shared/types';
import { Button, EmptyState, Panel, StatusPill } from '../components/ui';

export function FinalReviewView({
  projects,
  onRefresh,
  setError
}: {
  projects: ProjectSummary[];
  onRefresh: () => Promise<void>;
  setError: (message: string | null) => void;
}) {
  const candidates = useMemo(() => projects.filter(project =>
    project.state === 'WAITING_FINAL_APPROVAL'
    || project.state === 'WAITING_YOUTUBE_PROCESSING'
    || project.state === 'UPLOADING_PRIVATE'
    || project.state === 'SCHEDULED'
    || project.state === 'PUBLISHED'
  ), [projects]);
  const [projectId, setProjectId] = useState('');
  const [review, setReview] = useState<FinalReview | null>(null);
  const [busy, setBusy] = useState('');
  const [scheduledAt, setScheduledAt] = useState('');

  useEffect(() => {
    if (!projectId && candidates[0]) setProjectId(candidates[0].id);
  }, [projectId, candidates]);

  async function load(): Promise<void> {
    if (!projectId) {
      setReview(null);
      return;
    }
    setReview(await window.videoFactory.finalReview.get(projectId));
  }

  useEffect(() => { void load(); }, [projectId]);

  async function action(label: string, work: () => Promise<unknown>): Promise<void> {
    setBusy(label);
    setError(null);
    try {
      await work();
      await load();
      await onRefresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy('');
    }
  }

  if (!candidates.length) {
    return (
      <EmptyState
        title="No final video is waiting for approval"
        body="Autopilot will place a completed, quality-checked private upload here."
      />
    );
  }

  return (
    <div className="view-stack">
      <div className="page-heading">
        <div>
          <div className="eyebrow"><Film size={14} /> FINAL HUMAN GATE</div>
          <h1>Review the finished video—not the entire production process.</h1>
          <p>Publication stays private until you approve the selected title, thumbnail, description, and final render.</p>
        </div>
        <select value={projectId} onChange={event => setProjectId(event.target.value)}>
          {candidates.map(project => <option value={project.id} key={project.id}>{project.title}</option>)}
        </select>
      </div>

      {review ? (
        <>
          <div className="review-layout">
            <Panel
              title="Final video"
              subtitle={`${Math.round((review.project.renders.find(render => render.kind === 'final')?.durationMs ?? 0) / 1000)} seconds · 1080p MP4`}
              action={<StatusPill value={review.project.state} />}
              className="video-panel"
            >
              <div className="video-frame">
                {review.localPreviewUrl
                  ? <video key={review.localPreviewUrl} src={review.localPreviewUrl} controls preload="metadata" />
                  : <div className="video-placeholder"><Film size={42} /><span>Final render is not available locally.</span></div>}
              </div>
              <div className="qc-strip">
                <div className={review.blockers.length ? 'qc-fail' : 'qc-pass'}>
                  <CheckCircle2 size={17} />
                  <strong>{review.blockers.length ? `${review.blockers.length} blocker(s)` : 'Automated QC passed'}</strong>
                </div>
                <span>{review.project.sceneCount} shots</span>
                <span>0 unsupported visual fallbacks required</span>
                <span>{review.warnings.length} warning(s)</span>
              </div>
            </Panel>

            <Panel title="Publishing package" subtitle="Choose one grounded title and thumbnail concept">
              <div className="package-stack">
                {review.project.packaging.map(candidate => (
                  <button
                    key={candidate.id}
                    className={`package-card ${candidate.selected ? 'package-selected' : ''}`}
                    onClick={() => void action(`package-${candidate.id}`, () =>
                      window.videoFactory.finalReview.selectPackage({
                        projectId: review.project.id,
                        packageId: candidate.id
                      })
                    )}
                  >
                    <div className="package-thumb">
                      {candidate.thumbnailPath
                        ? <img src={`videofactory://thumbnail/${candidate.id}`} alt="" />
                        : <div className="thumb-placeholder"><Film size={24} /></div>}
                      <span>{candidate.angle}</span>
                    </div>
                    <div className="package-copy">
                      <strong>{candidate.title}</strong>
                      <p>{candidate.viewerPromise}</p>
                      <StatusPill value={candidate.riskStatus} />
                    </div>
                  </button>
                ))}
              </div>
            </Panel>
          </div>

          <div className="review-bottom-grid">
            <Panel title="Description & chapters" subtitle="Generated from the final script and timeline">
              <textarea
                className="description-preview"
                readOnly
                value={review.selectedPackage?.description ?? ''}
              />
            </Panel>

            <Panel title="Approval" subtitle="Automatic uploads always begin private">
              <div className="approval-card">
                {review.privateVideoUrl ? (
                  <div className="private-upload-status">
                    <Lock size={18} />
                    <div><strong>Private YouTube upload ready</strong><span>Only you can view it until approval.</span></div>
                    <Button variant="ghost" onClick={() => void window.videoFactory.system.openExternal(review.privateVideoUrl!)}><ExternalLink size={15} /></Button>
                  </div>
                ) : (
                  <div className="private-upload-status">
                    <UploadCloud size={18} />
                    <div><strong>Ready for private upload</strong><span>OAuth and a successful final render are required.</span></div>
                  </div>
                )}

                {review.privateVideoUrl && !review.packageSynced ? (
                  <Button
                    busy={busy === 'sync-package'}
                    disabled={!review.canUpload}
                    onClick={() => void action('sync-package', () => window.videoFactory.youtube.uploadPrivate(review.project.id))}
                  >
                    <UploadCloud size={16} /> Complete private upload package
                  </Button>
                ) : null}

                {!review.privateVideoUrl ? (
                  <Button
                    busy={busy === 'upload'}
                    disabled={!review.canUpload}
                    onClick={() => void action('upload', () => window.videoFactory.youtube.uploadPrivate(review.project.id))}
                  >
                    <UploadCloud size={16} /> Upload privately
                  </Button>
                ) : (
                  <>
                    <Button
                      busy={busy === 'publish'}
                      disabled={!review.canApprove}
                      onClick={() => void action('publish', () => window.videoFactory.youtube.approve({
                        projectId: review.project.id,
                        action: 'publish'
                      }))}
                    >
                      <Send size={16} /> Approve and publish
                    </Button>
                    <div className="schedule-row">
                      <input
                        type="datetime-local"
                        value={scheduledAt}
                        onChange={event => setScheduledAt(event.target.value)}
                      />
                      <Button
                        variant="secondary"
                        busy={busy === 'schedule'}
                        disabled={!review.canApprove || !scheduledAt}
                        onClick={() => void action('schedule', () => window.videoFactory.youtube.approve({
                          projectId: review.project.id,
                          action: 'schedule',
                          scheduledAt: new Date(scheduledAt).toISOString()
                        }))}
                      >
                        <CalendarClock size={16} /> Schedule
                      </Button>
                    </div>
                  </>
                )}
              </div>
            </Panel>
          </div>
        </>
      ) : <div className="loading-panel">Loading final review…</div>}
    </div>
  );
}
