import { useEffect, useMemo, useState, type JSX } from 'react';
import {
  CheckCircle2,
  Film,
  GitMerge,
  Map,
  MapPinCheck,
  RefreshCw,
  Scissors,
  ShieldAlert,
  XCircle
} from 'lucide-react';
import type {
  ProjectDetail,
  StoryboardCandidate,
  StoryboardMutationResult,
  StoryboardRecoveryScene
} from '@shared/types';
import { Button, StatusPill } from './ui';

type BusyAction =
  | 'replace'
  | 'reject'
  | 'rewrite'
  | 'graphic'
  | 'split'
  | 'merge'
  | 'verify'
  | 'range'
  | 'continue'
  | null;

export function StoryboardRecoveryEditor({
  project,
  onChanged,
  setError
}: {
  project: ProjectDetail;
  onChanged: (project: ProjectDetail) => Promise<void>;
  setError: (message: string | null) => void;
}): JSX.Element {
  const initialScene = project.scenes.find(scene => scene.verificationState === 'rejected')
    ?? project.scenes[0]
    ?? null;
  const [sceneId, setSceneId] = useState(initialScene?.id ?? '');
  const [recovery, setRecovery] = useState<StoryboardRecoveryScene | null>(null);
  const [candidateId, setCandidateId] = useState('');
  const [reason, setReason] = useState('');
  const [narration, setNarration] = useState(initialScene?.narration ?? '');
  const [splitFirst, setSplitFirst] = useState(initialScene?.narration ?? '');
  const [splitSecond, setSplitSecond] = useState('');
  const [splitTreatment, setSplitTreatment] = useState<'MAP_OR_GRAPHIC' | 'TEXT_OR_ARCHIVAL'>('MAP_OR_GRAPHIC');
  const [mergeNarration, setMergeNarration] = useState('');
  const [mergeTreatment, setMergeTreatment] = useState<'preserve' | 'MAP_OR_GRAPHIC' | 'TEXT_OR_ARCHIVAL'>('preserve');
  const [pending, setPending] = useState<StoryboardMutationResult | null>(null);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [loading, setLoading] = useState(false);

  const activeScene = project.scenes.find(scene => scene.id === sceneId) ?? initialScene;
  const nextScene = recovery?.nextSceneId
    ? project.scenes.find(scene => scene.id === recovery.nextSceneId) ?? null
    : null;
  const focusedCandidate = recovery?.candidates.find(candidate => candidate.id === candidateId)
    ?? recovery?.candidates.find(candidate => candidate.selected)
    ?? recovery?.candidates[0]
    ?? null;
  const reasonValid = reason.trim().length >= 3;

  const projectSceneKey = useMemo(
    () => project.scenes.map(scene => `${scene.id}:${scene.ordinal}:${scene.verificationState}`).join('|'),
    [project.scenes]
  );

  const load = async (targetSceneId: string): Promise<void> => {
    if (!targetSceneId) return;
    setLoading(true);
    try {
      const next = await window.videoFactory.storyboard.get(project.id, targetSceneId);
      setRecovery(next);
      setCandidateId(next.candidates.find(candidate => candidate.selected)?.id ?? next.candidates[0]?.id ?? '');
      setNarration(next.scene.narration);
      setSplitFirst(next.scene.narration);
      setSplitSecond('');
      const adjacent = next.nextSceneId
        ? project.scenes.find(scene => scene.id === next.nextSceneId)
        : null;
      setMergeNarration(adjacent ? `${next.scene.narration} ${adjacent.narration}` : next.scene.narration);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!project.scenes.some(scene => scene.id === sceneId)) {
      setSceneId(initialScene?.id ?? '');
      return;
    }
    void load(sceneId);
  }, [project.id, project.updatedAt, projectSceneKey, sceneId]);

  const mutate = async (
    action: Exclude<BusyAction, 'range' | 'continue' | null>,
    operation: () => Promise<StoryboardMutationResult>
  ): Promise<void> => {
    setBusy(action);
    setError(null);
    try {
      const result = await operation();
      setPending(result);
      const retainedScene = result.project.scenes.find(scene => scene.id === sceneId)
        ?? result.project.scenes.find(scene => result.affectedSceneIds.includes(scene.id))
        ?? result.project.scenes[0]
        ?? null;
      if (retainedScene) setSceneId(retainedScene.id);
      await onChanged(result.project);
      if (retainedScene) await load(retainedScene.id);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const regenerateRange = async (): Promise<void> => {
    if (!pending?.affectedRange) return;
    setBusy('range');
    setError(null);
    try {
      await window.videoFactory.renders.start({
        projectId: project.id,
        kind: 'range',
        startSceneOrdinal: pending.affectedRange.startSceneOrdinal,
        endSceneOrdinal: pending.affectedRange.endSceneOrdinal,
        outputProfileKey: project.outputProfileKey
      });
      const next = await window.videoFactory.projects.advance(project.id);
      setPending(null);
      await onChanged(next);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const continueWorkflow = async (): Promise<void> => {
    setBusy('continue');
    setError(null);
    try {
      const next = await window.videoFactory.projects.advance(project.id);
      setPending(null);
      await onChanged(next);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  if (!activeScene) {
    return <p className="drawer-help">No storyboard scenes are available yet.</p>;
  }

  const disabled = loading || Boolean(busy) || !recovery?.editable;
  const mergeNeedsGraphic = Boolean(
    nextScene
    && (
      activeScene.selectedAssetId !== nextScene.selectedAssetId
      || activeScene.selectedFileId !== nextScene.selectedFileId
      || activeScene.requiredPlaceId !== nextScene.requiredPlaceId
    )
  );
  const mergeGeographyConflict = Boolean(
    nextScene
    && (
      activeScene.requiredPlaceId !== nextScene.requiredPlaceId
      || activeScene.requiredCountry !== nextScene.requiredCountry
      || activeScene.requiredCity !== nextScene.requiredCity
      || activeScene.requiredLocation !== nextScene.requiredLocation
      || activeScene.requiredGranularity !== nextScene.requiredGranularity
    )
  );

  return (
    <div className="storyboard-recovery">
      <div className="storyboard-recovery-heading">
        <div>
          <h3>Storyboard recovery</h3>
          <p>Compare persisted evidence, make one bounded correction, then regenerate only the affected range.</p>
        </div>
        <StatusPill value={recovery?.editable ? 'operator ready' : 'read only'} />
      </div>
      {recovery?.editBlockedReason ? (
        <div className="storyboard-lock-notice"><ShieldAlert size={15} /><span>{recovery.editBlockedReason}</span></div>
      ) : null}

      <div className="storyboard-three-pane">
        <nav className="storyboard-beats" aria-label="Narration beats">
          <span className="field-label">NARRATION BEATS</span>
          {project.scenes.map(scene => (
            <button
              key={scene.id}
              className={scene.id === activeScene.id ? 'active' : ''}
              onClick={() => { setPending(null); setSceneId(scene.id); }}
            >
              <span>{String(scene.ordinal).padStart(2, '0')}</span>
              <div><strong>{scene.chapter ?? `Scene ${scene.ordinal}`}</strong><small>{scene.narration}</small></div>
              <StatusPill value={scene.verificationState} />
            </button>
          ))}
        </nav>

        <div className="storyboard-preview">
          <span className="field-label">PREVIEW & EDIT</span>
          <div className="storyboard-preview-frame">
            {focusedCandidate?.thumbnailUrl ? (
              <img src={focusedCandidate.thumbnailUrl} alt={`${focusedCandidate.assetTitle} candidate preview`} />
            ) : (
              <div><Film size={30} /><span>{activeScene.visualTreatment.replaceAll('_', ' ')}</span></div>
            )}
          </div>
          <div className="storyboard-scene-contract">
            <div><strong>Scene {activeScene.ordinal}</strong><StatusPill value={activeScene.verificationState} /></div>
            <span>{activeScene.requiredLocation ?? activeScene.requiredCity ?? activeScene.requiredCountry ?? 'No location requirement'}</span>
            <span>{activeScene.visualTreatment.replaceAll('_', ' ').toLowerCase()}</span>
          </div>

          <label className="storyboard-field">
            <span>Recovery reason</span>
            <input value={reason} onChange={event => setReason(event.target.value)} placeholder="Describe the evidence and intended correction." />
          </label>
          <label className="storyboard-field">
            <span>Narration</span>
            <textarea rows={5} value={narration} onChange={event => setNarration(event.target.value)} />
          </label>
          <Button
            variant="secondary"
            busy={busy === 'rewrite'}
            disabled={disabled || !reasonValid || narration.trim() === activeScene.narration.trim()}
            onClick={() => void mutate('rewrite', () => window.videoFactory.storyboard.rewriteBeat({
              projectId: project.id, sceneId: activeScene.id, narration, reason
            }))}
          >
            <RefreshCw size={14} /> Rewrite this beat
          </Button>

          <div className="storyboard-action-grid">
            <Button
              variant="secondary"
              busy={busy === 'graphic'}
              disabled={disabled || !reasonValid}
              onClick={() => void mutate('graphic', () => window.videoFactory.storyboard.useGraphic({
                projectId: project.id, sceneId: activeScene.id, treatment: 'MAP_OR_GRAPHIC', reason
              }))}
            ><Map size={14} /> Use map</Button>
            <Button
              variant="secondary"
              busy={busy === 'graphic'}
              disabled={disabled || !reasonValid}
              onClick={() => void mutate('graphic', () => window.videoFactory.storyboard.useGraphic({
                projectId: project.id, sceneId: activeScene.id, treatment: 'TEXT_OR_ARCHIVAL', reason
              }))}
            ><Film size={14} /> Use text card</Button>
            <Button
              variant="secondary"
              busy={busy === 'verify'}
              disabled={disabled || !reasonValid || !activeScene.selectedAssetId || !activeScene.requiredPlaceId}
              onClick={() => void mutate('verify', () => window.videoFactory.storyboard.verifyLocation({
                projectId: project.id, sceneId: activeScene.id, reason
              }))}
            ><MapPinCheck size={14} /> Verify location</Button>
          </div>

          <details className="storyboard-structural-edit">
            <summary><Scissors size={13} /> Split beat</summary>
            <label className="storyboard-field"><span>First narration</span><textarea rows={3} value={splitFirst} onChange={event => setSplitFirst(event.target.value)} /></label>
            <label className="storyboard-field"><span>Second narration</span><textarea rows={3} value={splitSecond} onChange={event => setSplitSecond(event.target.value)} /></label>
            <label className="storyboard-field"><span>Second visual</span><select value={splitTreatment} onChange={event => setSplitTreatment(event.target.value as typeof splitTreatment)}><option value="MAP_OR_GRAPHIC">Map / graphic</option><option value="TEXT_OR_ARCHIVAL">Text / archival card</option></select></label>
            <Button
              variant="secondary"
              busy={busy === 'split'}
              disabled={disabled || !reasonValid || !splitFirst.trim() || !splitSecond.trim()}
              onClick={() => void mutate('split', () => window.videoFactory.storyboard.splitBeat({
                projectId: project.id,
                sceneId: activeScene.id,
                firstNarration: splitFirst,
                secondNarration: splitSecond,
                secondTreatment: splitTreatment,
                reason
              }))}
            ><Scissors size={14} /> Split with graphic fallback</Button>
          </details>

          {nextScene ? (
            <details className="storyboard-structural-edit">
              <summary><GitMerge size={13} /> Merge with scene {nextScene.ordinal}</summary>
              <label className="storyboard-field"><span>Merged narration</span><textarea rows={4} value={mergeNarration} onChange={event => setMergeNarration(event.target.value)} /></label>
              <label className="storyboard-field"><span>Merged visual</span><select value={mergeTreatment} onChange={event => setMergeTreatment(event.target.value as typeof mergeTreatment)}><option value="preserve" disabled={mergeNeedsGraphic}>Preserve shared verified visual</option><option value="MAP_OR_GRAPHIC">Map / graphic</option><option value="TEXT_OR_ARCHIVAL">Text / archival card</option></select></label>
              {mergeNeedsGraphic ? <small className="storyboard-policy-note">Different visual evidence requires an explicit graphic treatment.</small> : null}
              {mergeGeographyConflict ? <small className="storyboard-policy-note">Different location contracts cannot be collapsed into one scene. Rewrite one beat to the same supported geography first.</small> : null}
              <Button
                variant="secondary"
                busy={busy === 'merge'}
                disabled={disabled || mergeGeographyConflict || !reasonValid || !mergeNarration.trim() || (mergeNeedsGraphic && mergeTreatment === 'preserve')}
                onClick={() => void mutate('merge', () => window.videoFactory.storyboard.mergeBeats({
                  projectId: project.id,
                  firstSceneId: activeScene.id,
                  secondSceneId: nextScene.id,
                  narration: mergeNarration,
                  graphicTreatment: mergeTreatment === 'preserve' ? undefined : mergeTreatment,
                  reason
                }))}
              ><GitMerge size={14} /> Merge adjacent beats</Button>
            </details>
          ) : null}
        </div>

        <aside className="storyboard-candidates">
          <span className="field-label">CANDIDATES & EVIDENCE</span>
          {recovery?.candidates.length ? recovery.candidates.map(candidate => (
            <CandidateCard
              key={candidate.id}
              candidate={candidate}
              focused={candidate.id === focusedCandidate?.id}
              disabled={disabled || !reasonValid}
              busy={busy}
              onFocus={() => setCandidateId(candidate.id)}
              onReplace={() => void mutate('replace', () => window.videoFactory.storyboard.replaceShot({
                projectId: project.id, sceneId: activeScene.id, candidateId: candidate.id, reason
              }))}
              onReject={() => {
                if (candidate.selected && !window.confirm('Reject the currently selected shot? The project will remain blocked until you choose a safe replacement.')) return;
                void mutate('reject', () => window.videoFactory.storyboard.rejectCandidate({
                  projectId: project.id, sceneId: activeScene.id, candidateId: candidate.id, reason
                }));
              }}
            />
          )) : <p className="drawer-help">No ranked footage candidates are stored for this graphic-only scene.</p>}
        </aside>
      </div>

      {pending ? (
        <div className={`storyboard-next-action next-${pending.nextAction}`}>
          <CheckCircle2 size={17} />
          <div>
            <strong>{pending.action.replaceAll('_', ' ')} saved and audited</strong>
            <span>
              {pending.nextAction === 'render_range'
                ? `Scenes ${pending.affectedRange?.startSceneOrdinal ?? '—'}–${pending.affectedRange?.endSceneOrdinal ?? '—'} are ready for bounded regeneration.`
                : pending.nextAction === 'continue_workflow'
                  ? 'The active immutable script changed; regenerate narration and dependent outputs next.'
                  : 'Choose another safe recovery action before continuing.'}
            </span>
          </div>
          {pending.nextAction === 'render_range' ? (
            <Button busy={busy === 'range'} onClick={() => void regenerateRange()}><RefreshCw size={14} /> Regenerate affected range</Button>
          ) : pending.nextAction === 'continue_workflow' ? (
            <Button busy={busy === 'continue'} onClick={() => void continueWorkflow()}><RefreshCw size={14} /> Continue recovery</Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function CandidateCard({
  candidate,
  focused,
  disabled,
  busy,
  onFocus,
  onReplace,
  onReject
}: {
  candidate: StoryboardCandidate;
  focused: boolean;
  disabled: boolean;
  busy: BusyAction;
  onFocus: () => void;
  onReplace: () => void;
  onReject: () => void;
}): JSX.Element {
  return (
    <article className={`storyboard-candidate ${focused ? 'focused' : ''}`}>
      <button type="button" className="storyboard-candidate-title" onClick={onFocus} aria-label={`Preview candidate ${candidate.rank}: ${candidate.assetTitle}`}>
        <div><strong>#{candidate.rank} {candidate.assetTitle}</strong><span>{candidate.locationName ?? candidate.city ?? candidate.country ?? 'No location label'}</span></div>
        <StatusPill value={candidate.ready ? 'verified ready' : candidate.status} />
      </button>
      <div className="storyboard-candidate-metrics"><span>score {candidate.score.toFixed(1)}</span><span>{candidate.licenseState ?? 'no license'}</span><span>{candidate.semanticStatus ?? 'not verified'}</span></div>
      {candidate.explanations.slice(0, 3).map(explanation => <p key={explanation}>{explanation}</p>)}
      {candidate.blockedReasons.length ? (
        <div className="candidate-blockers">{candidate.blockedReasons.map(reason => <span key={reason}><XCircle size={11} />{reason}</span>)}</div>
      ) : null}
      <div className="candidate-actions">
        <Button variant="secondary" busy={busy === 'replace'} disabled={disabled || !candidate.ready || candidate.selected} onClick={event => { event.stopPropagation(); onReplace(); }}>
          <CheckCircle2 size={13} /> {candidate.selected ? 'Selected' : 'Use shot'}
        </Button>
        <Button variant="ghost" busy={busy === 'reject'} disabled={disabled || candidate.status === 'rejected'} onClick={event => { event.stopPropagation(); onReject(); }}>
          <XCircle size={13} /> Reject
        </Button>
      </div>
    </article>
  );
}
