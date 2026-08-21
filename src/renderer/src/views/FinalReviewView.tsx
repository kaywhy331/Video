import { useEffect, useMemo, useState } from 'react';
import {
  CalendarClock,
  CheckCircle2,
  ExternalLink,
  Film,
  Lock,
  RotateCcw,
  Send,
  ShieldCheck,
  UploadCloud
} from 'lucide-react';
import type { FinalReview, FinalReviewRevisionCategory, ProjectSummary } from '@shared/types';
import { Button, EmptyState, Panel, StatusPill } from '../components/ui';

const REVISION_CATEGORIES: Array<{
  value: FinalReviewRevisionCategory;
  label: string;
  route: string;
  automatic: boolean;
}> = [
  { value: 'packaging', label: 'Title, description, or thumbnail', route: 'Packaging at final QC', automatic: false },
  { value: 'caption_typo', label: 'Caption typo', route: 'Timeline and captions', automatic: false },
  { value: 'voice_pronunciation', label: 'Voice pronunciation', route: 'Affected narration section', automatic: true },
  { value: 'script_factual_issue', label: 'Script factual issue', route: 'Verified script finalization', automatic: true },
  { value: 'wrong_or_weak_shot', label: 'Wrong or weak shot', route: 'Footage verification', automatic: false },
  { value: 'new_footage_required', label: 'New footage required', route: 'Download queue', automatic: false },
  { value: 'major_story_change', label: 'Major topic or story change', route: 'Provisional script', automatic: false }
];

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
    || project.state === 'AWAITING_MANUAL_STUDIO_ACTION'
    || project.state === 'SCHEDULED'
    || project.state === 'PUBLISHED'
  ), [projects]);
  const [projectId, setProjectId] = useState('');
  const [review, setReview] = useState<FinalReview | null>(null);
  const [busy, setBusy] = useState('');
  const [scheduledAt, setScheduledAt] = useState('');
  const [revisionCategory, setRevisionCategory] = useState<FinalReviewRevisionCategory>('voice_pronunciation');
  const [revisionNote, setRevisionNote] = useState('');
  const [affectedSceneId, setAffectedSceneId] = useState('');
  const [pronunciationTerm, setPronunciationTerm] = useState('');
  const [pronunciationValue, setPronunciationValue] = useState('');
  const finalRender = review?.project.finalRenderId
    ? review.project.renders.find(render => render.id === review.project.finalRenderId)
    : undefined;
  const revisionChoice = REVISION_CATEGORIES.find(item => item.value === revisionCategory)!;
  const affectedSection = review?.project.narrationSections.find(section =>
    affectedSceneId && section.sceneIds.includes(affectedSceneId)
  );

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

  useEffect(() => {
    void load().catch(error => setError(error instanceof Error ? error.message : String(error)));
  }, [projectId]);

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
        <select aria-label="Final review project" value={projectId} onChange={event => setProjectId(event.target.value)}>
          {candidates.map(project => <option value={project.id} key={project.id}>{project.title}</option>)}
        </select>
      </div>

      {review ? (
        <>
          {review.project.state === 'AWAITING_MANUAL_STUDIO_ACTION' && review.project.youtubeVideoId ? (
            <Panel
              title="Complete the approved action in YouTube Studio"
              subtitle="The API kept this video private; no publication state was inferred"
            >
              <p>The private upload and approval receipt are preserved. Complete the publish or schedule action in the exact video editor, then return to confirm the resulting state.</p>
              <Button onClick={() => void window.videoFactory.system.openExternal(`https://studio.youtube.com/video/${encodeURIComponent(review.project.youtubeVideoId!)}/edit`)}>
                <ExternalLink size={16} /> Open exact Studio video
              </Button>
            </Panel>
          ) : null}
          <div className="review-layout">
            <Panel
              title="Final video"
              subtitle={`${Math.round((finalRender?.durationMs ?? 0) / 1000)} seconds · ${finalRender?.width ?? 1920}×${finalRender?.height ?? 1080} H.264 MP4`}
              action={<StatusPill value={review.project.state} />}
              className="video-panel"
            >
              <div className="video-frame">
                {review.localPreviewUrl
                  ? (
                    <video key={review.localPreviewUrl} src={review.localPreviewUrl} controls preload="metadata">
                      {review.localCaptionsUrl
                        ? <track kind="captions" src={review.localCaptionsUrl} srcLang="en" label="English" default />
                        : null}
                    </video>
                  )
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
                <span>{review.localCaptionsUrl ? 'WebVTT captions available' : 'Captions unavailable for this artifact'}</span>
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

          <details className="final-scene-audit">
            <summary>
              <span>Expandable scene audit</span>
              <strong>{review.project.scenes.length} scenes · treatments, locations, claims, sources, and QC</strong>
            </summary>
            <div className="final-scene-audit-list">
              {review.project.scenes.map(scene => {
                const claims = review.project.factClaims.filter(claim => claim.sceneIds.includes(scene.id));
                const sourceIds = new Set(claims.flatMap(claim => claim.sourceIds));
                const sources = review.project.researchSources.filter(source => sourceIds.has(source.id));
                const qc = review.project.qc.filter(item => {
                  const sceneId = item.evidence.sceneId;
                  const sceneOrdinal = item.evidence.sceneOrdinal;
                  const sceneIds = item.evidence.sceneIds;
                  return sceneId === scene.id
                    || Number(sceneOrdinal) === scene.ordinal
                    || (Array.isArray(sceneIds) && sceneIds.includes(scene.id));
                });
                const license = review.project.licenses.find(item => item.assetId === scene.selectedAssetId);
                return (
                  <article key={scene.id}>
                    <header>
                      <span>{String(scene.ordinal).padStart(2, '0')}</span>
                      <div><strong>{scene.chapter ?? `Scene ${scene.ordinal}`}</strong><small>{scene.narration}</small></div>
                      <StatusPill value={scene.verificationState} />
                    </header>
                    <dl>
                      <div><dt>Treatment</dt><dd>{scene.visualTreatment.replaceAll('_', ' ')}</dd></div>
                      <div><dt>Required location</dt><dd>{scene.requiredLocation ?? scene.requiredCity ?? scene.requiredCountry ?? 'Contextual only'}</dd></div>
                      <div><dt>Selection</dt><dd>{scene.selectedSegmentId ?? (scene.visualTreatment === 'MAP_OR_GRAPHIC' ? 'Generated graphic' : 'Not selected')}</dd></div>
                      <div><dt>Rights</dt><dd>{license?.licenseState ?? (scene.selectedAssetId ? 'No project snapshot' : 'Not applicable')}</dd></div>
                      <div><dt>Claims</dt><dd>{claims.length ? claims.map(claim => claim.text).join(' · ') : 'No material claim linked'}</dd></div>
                      <div><dt>Sources</dt><dd>{sources.length ? sources.map(source => source.title).join(' · ') : 'No linked source required'}</dd></div>
                      <div><dt>QC</dt><dd>{qc.length ? qc.map(item => `${item.code}: ${item.status}`).join(' · ') : 'Covered by render-level QC'}</dd></div>
                    </dl>
                  </article>
                );
              })}
            </div>
          </details>

          <div className="review-bottom-grid">
            <Panel title="Description & chapters" subtitle="Generated from the final script and timeline">
              <textarea
                className="description-preview"
                aria-label="Generated description and chapters"
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
                    <Button aria-label="Open private YouTube video" variant="ghost" onClick={() => void window.videoFactory.system.openExternal(review.privateVideoUrl!)}><ExternalLink size={15} /></Button>
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
                      variant="secondary"
                      busy={busy === 'keep-private'}
                      disabled={!review.canApprove}
                      onClick={() => void action('keep-private', () => window.videoFactory.youtube.approve({
                        projectId: review.project.id,
                        action: 'keep_private'
                      }))}
                    >
                      {review.keptPrivateAt ? <ShieldCheck size={16} /> : <Lock size={16} />}
                      {review.keptPrivateAt ? `Kept private ${new Date(review.keptPrivateAt).toLocaleString()}` : 'Keep private'}
                    </Button>
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
                        aria-label="Publication schedule"
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

            <Panel
              title="Send back for revision"
              subtitle="The project returns to the smallest affected stage; unchanged artifacts remain cached"
              className="revision-panel"
            >
              <div className="revision-form">
                <label>
                  <span className="field-label">REVISION CATEGORY</span>
                  <select
                    value={revisionCategory}
                    onChange={event => setRevisionCategory(event.target.value as FinalReviewRevisionCategory)}
                  >
                    {REVISION_CATEGORIES.map(category => (
                      <option key={category.value} value={category.value}>{category.label}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span className="field-label">AFFECTED SCENE</span>
                  <select value={affectedSceneId} onChange={event => setAffectedSceneId(event.target.value)}>
                    <option value="">No specific scene</option>
                    {review.project.scenes.map(scene => (
                      <option key={scene.id} value={scene.id}>
                        Scene {scene.ordinal}: {scene.narration.slice(0, 90)}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="revision-route-note">
                  <RotateCcw size={16} />
                  <div>
                    <strong>Returns to {revisionChoice.route}</strong>
                    <span>{revisionChoice.automatic
                      ? 'The supported correction continues automatically.'
                      : 'The project waits there for an operator correction.'}</span>
                  </div>
                </div>
                {revisionCategory === 'voice_pronunciation' ? (
                  <div className="pronunciation-grid">
                    <label>
                      <span className="field-label">TERM</span>
                      <input
                        value={pronunciationTerm}
                        onChange={event => setPronunciationTerm(event.target.value)}
                        placeholder="Oaxaca"
                      />
                    </label>
                    <label>
                      <span className="field-label">PRONUNCIATION</span>
                      <input
                        value={pronunciationValue}
                        onChange={event => setPronunciationValue(event.target.value)}
                        placeholder="wah-HAH-kah"
                      />
                    </label>
                    <div className="revision-section-hint">
                      {affectedSection
                        ? `Narration section ${affectedSection.ordinal} will be regenerated.`
                        : 'Choose the scene containing the pronunciation issue.'}
                    </div>
                  </div>
                ) : null}
                <label className="revision-note-field">
                  <span className="field-label">WHAT NEEDS TO CHANGE</span>
                  <textarea
                    value={revisionNote}
                    onChange={event => setRevisionNote(event.target.value)}
                    placeholder="Describe the correction precisely."
                  />
                </label>
                <Button
                  variant="secondary"
                  busy={busy === 'request-revision'}
                  disabled={
                    revisionNote.trim().length < 3
                    || (revisionCategory === 'voice_pronunciation'
                      && (!affectedSceneId || !pronunciationTerm.trim() || !pronunciationValue.trim()))
                  }
                  onClick={() => void action('request-revision', async () => {
                    await window.videoFactory.finalReview.requestRevision({
                      projectId: review.project.id,
                      category: revisionCategory,
                      note: revisionNote.trim(),
                      affectedSceneId: affectedSceneId || undefined,
                      affectedSectionId: affectedSection?.id,
                      pronunciation: revisionCategory === 'voice_pronunciation'
                        ? { term: pronunciationTerm.trim(), value: pronunciationValue.trim() }
                        : undefined
                    });
                    setRevisionNote('');
                    setPronunciationTerm('');
                    setPronunciationValue('');
                  })}
                >
                  <RotateCcw size={16} /> Send back to {revisionChoice.route}
                </Button>
              </div>
            </Panel>
          </div>
        </>
      ) : <div className="loading-panel">Loading final review…</div>}
    </div>
  );
}
