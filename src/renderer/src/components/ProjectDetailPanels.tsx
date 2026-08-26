import type { Dispatch, JSX, SetStateAction } from 'react';
import { Archive, Ban, ExternalLink, FileCheck2, Music2, Pause, Play, RotateCcw, Wrench } from 'lucide-react';
import type { FourKBlocker, JobRecord, MusicTrack, ProjectDetail, ProjectMusicSelection } from '@shared/types';
import { canTransitionProject } from '@shared/state-machine';
import { StoryboardRecoveryEditor } from './StoryboardRecoveryEditor';
import { Button, ProgressBar, StatusPill } from './ui';

export const PROJECT_TABS = [
  ['overview', 'Overview'],
  ['research', 'Research'],
  ['script', 'Script & coverage'],
  ['storyboard', 'Storyboard'],
  ['assets', 'Assets / licenses'],
  ['voice', 'Voice / audio'],
  ['renders', 'Renders / QC'],
  ['publishing', 'Publishing / analytics'],
  ['audit', 'Audit log']
] as const;

export type ProjectTab = typeof PROJECT_TABS[number][0];
export type ProjectWorkspaceBusyAction =
  | 'export'
  | 'rebuild'
  | 'music'
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'archive'
  | `job:${string}`
  | null;

interface ProjectTabPanelProps {
  tab: ProjectTab;
  project: ProjectDetail;
  fourKBlockers: FourKBlocker[];
  musicTracks: MusicTrack[];
  musicSelection: ProjectMusicSelection | null;
  jobs: JobRecord[];
  selectedMusicId: string;
  busy: ProjectWorkspaceBusyAction;
  setSelectedMusicId: Dispatch<SetStateAction<string>>;
  selectMusic: () => Promise<void>;
  lifecycle: (kind: 'pause' | 'resume' | 'cancel' | 'archive') => Promise<void>;
  run: (kind: 'export' | 'rebuild') => Promise<void>;
  retryJob: (job: JobRecord) => Promise<void>;
  setError: (message: string | null) => void;
  onStoryboardChanged: (project: ProjectDetail) => Promise<void>;
}

function dateTime(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : '—';
}

function Evidence({ value }: { value: unknown }): JSX.Element | null {
  if (value === null || value === undefined) return null;
  return (
    <details className="workspace-evidence">
      <summary>Structured evidence</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

function EmptyTab({ children }: { children: string }): JSX.Element {
  return <p className="drawer-empty">{children}</p>;
}

function OverviewPanel({ project, fourKBlockers, busy, lifecycle, run }: Pick<ProjectTabPanelProps,
  'project' | 'fourKBlockers' | 'busy' | 'lifecycle' | 'run'>): JSX.Element {
  const latestExport = project.exports[0];
  const latestRebuild = project.rebuilds[0];
  const canPause = !['SCHEDULED', 'PAUSED', 'BLOCKED_EXCEPTION'].includes(project.state)
    && canTransitionProject(project.state, 'PAUSED');
  return <>
    <div className="drawer-status"><StatusPill value={project.state} /><span>{project.envatoProjectName}</span></div>
    <ProgressBar value={project.progress} label="Pipeline" />
    <div className="drawer-metrics">
      <div><span>Scenes</span><strong>{project.sceneCount}</strong></div>
      <div><span>Assets</span><strong>{project.acquiredCount}/{project.acquisitionCount}</strong></div>
      <div><span>Exceptions</span><strong>{project.openExceptions}</strong></div>
    </div>
    <section>
      <h3>Project contract</h3>
      <div className="workspace-grid">
        <div><span>Topic</span><strong>{project.topic}</strong></div>
        <div><span>Destination</span><strong>{project.destination ?? 'Catalog selected'}</strong></div>
        <div><span>Target duration</span><strong>{Math.round(project.targetDurationMs / 60_000)} minutes</strong></div>
        <div><span>Output profile</span><strong>{project.outputProfileKey.replaceAll('_', ' ')}</strong></div>
        <div><span>Channel</span><strong>{String(project.channelSnapshot?.name ?? project.channelId ?? 'Default')}</strong></div>
        <div><span>Voice</span><strong>{String(project.languageVoiceSnapshot?.displayName ?? project.languageVoiceProfileId ?? 'Default')}</strong></div>
      </div>
      {project.description ? <p className="drawer-help">{project.description}</p> : null}
      <Evidence value={project.guidance} />
    </section>
    <section>
      <h3>Lifecycle, portability & recovery</h3>
      <div className="drawer-actions">
        {['PAUSED', 'BLOCKED_EXCEPTION'].includes(project.state) ? (
          <Button variant="secondary" busy={busy === 'resume'} onClick={() => void lifecycle('resume')}><Play size={15} /> Resume project</Button>
        ) : canPause ? (
          <Button variant="secondary" busy={busy === 'pause'} disabled={project.pendingLifecycleAction === 'pause'} onClick={() => void lifecycle('pause')}>
            <Pause size={15} /> {project.pendingLifecycleAction === 'pause' ? 'Pause requested' : 'Pause at checkpoint'}
          </Button>
        ) : null}
        {!['SCHEDULED', 'PUBLISHED', 'ANALYTICS_ACTIVE', 'CANCELLED', 'FAILED', 'ARCHIVED'].includes(project.state) ? (
          <Button variant="ghost" busy={busy === 'cancel'} onClick={() => void lifecycle('cancel')}><Ban size={15} /> Cancel project</Button>
        ) : null}
        {['PUBLISHED', 'ANALYTICS_ACTIVE', 'CANCELLED', 'FAILED'].includes(project.state) ? (
          <Button variant="ghost" busy={busy === 'archive'} onClick={() => void lifecycle('archive')}><Archive size={15} /> Archive project</Button>
        ) : null}
        <Button variant="secondary" busy={busy === 'export'} onClick={() => void run('export')}><Archive size={15} /> Export project</Button>
        <Button variant="secondary" busy={busy === 'rebuild'} onClick={() => void run('rebuild')}><Wrench size={15} /> Rebuild derivatives</Button>
      </div>
      <p className="drawer-help">Lifecycle changes are audited. Export includes checksummed metadata, rights, narration, captions, manifests, QC, packages, publication receipts, and the final output when available.</p>
      {latestExport || latestRebuild ? <div className="repair-audit portability-receipts">
        {latestExport ? <div className="repair-audit-row"><Archive size={14} /><div><strong>latest project export</strong><span>{latestExport.artifactCount} files · {Math.round(latestExport.totalBytes / 1024 / 1024)} MB</span></div><StatusPill value={latestExport.status} /></div> : null}
        {latestRebuild ? <div className="repair-audit-row"><Wrench size={14} /><div><strong>latest derivative rebuild</strong><span>{latestRebuild.rebuiltProxies + latestRebuild.rebuiltContactSheets + latestRebuild.rebuiltEditingLayers + latestRebuild.rebuiltCaptionFiles} rebuilt · {latestRebuild.missingOriginals.length} missing originals</span></div><StatusPill value={latestRebuild.status} /></div> : null}
      </div> : null}
    </section>
    <section>
      <h3>Output qualification</h3>
      <div className="four-k-qualification">
        <div><strong>{fourKBlockers.length ? '1080p fallback required' : 'Qualified for 4K'}</strong><StatusPill value={fourKBlockers.length ? 'blocked 4k' : '4k ready'} /></div>
        {fourKBlockers.length ? <p>Scenes blocking 4K: {fourKBlockers.map(item => item.sceneOrdinal).join(', ')}</p> : <p>Every selected full-screen segment retains 3840×2160 effective pixels; generated graphics render natively at the selected profile.</p>}
        {fourKBlockers.map(item => <span key={item.sceneOrdinal}>Scene {item.sceneOrdinal}: {item.reason}</span>)}
      </div>
    </section>
  </>;
}

function ResearchPanel({ project }: Pick<ProjectTabPanelProps, 'project'>): JSX.Element {
  return <>
    <section><h3>Research sources ({project.researchSources.length})</h3>
      {project.researchSources.length ? <div className="workspace-list">{project.researchSources.map(source => (
        <article key={source.id} className="workspace-row"><div><strong>{source.title}</strong><span>{source.publisher ?? source.sourceType} · accessed {dateTime(source.accessedAt)}</span><code>{source.url}</code>{source.summary ? <p>{source.summary}</p> : null}</div><StatusPill value={source.status} /></article>
      ))}</div> : <EmptyTab>No research sources have been persisted for this project.</EmptyTab>}
    </section>
    <section><h3>Fact claims ({project.factClaims.length})</h3>
      {project.factClaims.length ? <div className="workspace-list">{project.factClaims.map(claim => (
        <article key={claim.id} className="workspace-row"><div><strong>{claim.text}</strong><span>{claim.category} · confidence {Math.round(claim.confidence * 100)}% · {claim.sourceIds.length} sources · scenes {claim.sceneIds.join(', ') || 'none'}</span>{claim.omissionReason ? <p>Omitted: {claim.omissionReason}</p> : null}</div><StatusPill value={claim.status} /><Evidence value={claim.evidence} /></article>
      ))}</div> : <EmptyTab>No factual claims have been persisted for this project.</EmptyTab>}
    </section>
  </>;
}

function ScriptPanel({ project }: Pick<ProjectTabPanelProps, 'project'>): JSX.Element {
  return <>
    <section><h3>Immutable script versions ({project.scriptVersions.length})</h3>
      {project.scriptVersions.length ? <div className="workspace-list">{project.scriptVersions.map(version => (
        <article key={version.id} className="workspace-row"><div><strong>Version {version.versionNumber}: {version.title}</strong><span>{version.scriptType} · {version.provider}/{version.model} · {dateTime(version.createdAt)}</span>{version.summary ? <p>{version.summary}</p> : null}</div><StatusPill value={version.locked ? 'locked' : version.scriptType} /><Evidence value={version.script} /></article>
      ))}</div> : <EmptyTab>No script version has been persisted yet.</EmptyTab>}
    </section>
    <section><h3>Scene coverage contract ({project.scenes.length})</h3>
      <div className="scene-audit">{project.scenes.map(scene => {
        const claims = project.factClaims.filter(claim => claim.sceneIds.includes(scene.id));
        return <div className="scene-audit-row" key={scene.id}><span className="scene-number">{String(scene.ordinal).padStart(2, '0')}</span><div><strong>{scene.chapter ?? scene.narration}</strong><span>{scene.requiredLocation ?? scene.requiredCity ?? scene.requiredCountry ?? 'Contextual'} · {scene.visualTreatment.replaceAll('_', ' ')} · {claims.length} claim(s)</span></div><StatusPill value={scene.verificationState} /></div>;
      })}</div>
    </section>
  </>;
}

function StoryboardPanel({ project, setError, onStoryboardChanged }: Pick<ProjectTabPanelProps,
  'project' | 'setError' | 'onStoryboardChanged'>): JSX.Element {
  return <section><StoryboardRecoveryEditor project={project} setError={setError} onChanged={onStoryboardChanged} /></section>;
}

function AssetsPanel({ project }: Pick<ProjectTabPanelProps, 'project'>): JSX.Element {
  return <>
    <section><h3>Acquisition plan ({project.acquisitions.length})</h3>
      {project.acquisitions.length ? <div className="workspace-list">{project.acquisitions.map(item => (
        <article key={item.id} className="workspace-row"><div><strong>{item.assetTitle}</strong><span>{item.role} · scenes {item.requiredForScenes.join(', ') || 'none'} · match {Math.round(item.matchScore)}</span>{item.error ? <p>{item.error}</p> : null}</div><div className="workspace-statuses"><StatusPill value={item.state} /><StatusPill value={item.licenseState} /></div></article>
      ))}</div> : <EmptyTab>No assets have been requested.</EmptyTab>}
    </section>
    <section><h3>License evidence ({project.licenses.length})</h3>
      {project.licenses.length ? <div className="workspace-list">{project.licenses.map(license => (
        <article key={license.id} className="workspace-row"><div><strong>{license.assetTitle}</strong><span>{license.envatoProjectName} · attested {dateTime(license.operatorAttestedAt)}</span>{license.file ? <code>{license.file.fileName} · {license.file.width}×{license.file.height} · {license.file.pipelineVersion}</code> : <p>Original file not ingested.</p>}</div><StatusPill value={license.licenseState} /></article>
      ))}</div> : <EmptyTab>No project license snapshots have been created.</EmptyTab>}
    </section>
  </>;
}

function VoicePanel(props: Pick<ProjectTabPanelProps,
  'project' | 'musicTracks' | 'musicSelection' | 'selectedMusicId' | 'busy' | 'setSelectedMusicId' | 'selectMusic'>): JSX.Element {
  const { project, musicTracks, musicSelection, selectedMusicId, busy, setSelectedMusicId, selectMusic } = props;
  const selectedTrack = musicTracks.find(track => track.id === musicSelection?.musicTrackId);
  return <>
    <section><h3>Licensed background music</h3>
      {musicTracks.length ? <div className="project-music-picker">
        <select aria-label="Background music" value={selectedMusicId} onChange={event => setSelectedMusicId(event.target.value)}>
          {musicTracks.filter(track => track.enabled).map(track => <option key={track.id} value={track.id}>{track.title} · {track.provider}</option>)}
        </select>
        <Button variant="secondary" busy={busy === 'music'} disabled={!selectedMusicId || selectedMusicId === musicSelection?.musicTrackId} onClick={() => void selectMusic()}><Music2 size={15} /> {musicSelection ? 'Change track' : 'Select track'}</Button>
        {musicSelection ? <div className="music-selection-receipt"><Music2 size={14} /><div><strong>{selectedTrack?.title ?? 'Selected licensed track'}</strong><span>{musicSelection.targetGainDb} dB · duck {musicSelection.duckingDb} dB · {musicSelection.fadeOutMs} ms fade · immutable license snapshot</span></div><StatusPill value="license snapshotted" /></div> : <p className="drawer-help">Rendering remains narration-only until a licensed track is selected.</p>}
      </div> : <EmptyTab>No licensed track is available. Narration-only rendering remains valid.</EmptyTab>}
    </section>
    <section><h3>Final narration ({project.narrationSections.length})</h3>
      {project.narrationSections.length ? <div className="repair-audit">{project.narrationSections.map(section => (
        <div key={section.id} className="repair-audit-row"><span className="scene-number">{String(section.ordinal).padStart(2, '0')}</span><div><strong>{section.chapter ?? `Section ${section.ordinal}`}</strong><span>{section.sceneIds.length} scenes · {Math.round(section.durationMs / 1000)} sec · {section.timingMethod.replaceAll('_', ' ')}{Object.keys(section.pronunciation).length ? ` · ${Object.keys(section.pronunciation).length} pronunciation notes` : ''}</span></div><StatusPill value={section.status} /></div>
      ))}</div> : <EmptyTab>No final narration has been generated.</EmptyTab>}
    </section>
  </>;
}

function RendersPanel({ project }: Pick<ProjectTabPanelProps, 'project'>): JSX.Element {
  return <>
    <section><h3>Render artifacts ({project.renders.length})</h3>
      {project.renders.length ? <div className="workspace-list">{project.renders.map(render => (
        <article key={render.id} className="workspace-row"><div><strong>{render.kind} · artifact v{render.artifactVersion}</strong><span>{render.profile} · {render.width ?? '—'}×{render.height ?? '—'} · {render.durationMs ? `${Math.round(render.durationMs / 1000)} sec` : 'duration pending'}</span>{render.error ? <p>{render.error}</p> : null}</div><StatusPill value={render.state} /></article>
      ))}</div> : <EmptyTab>No render artifact exists yet.</EmptyTab>}
    </section>
    <section><h3>Quality control ({project.qc.length})</h3>
      {project.qc.length ? <div className="workspace-list">{project.qc.map(item => (
        <article key={item.id} className="workspace-row"><div><strong>{item.code.replaceAll('_', ' ')}</strong><span>{item.category} · {item.severity}</span><p>{item.message}</p></div><StatusPill value={item.status} /><Evidence value={item.evidence} /></article>
      ))}</div> : <EmptyTab>No QC result has been recorded.</EmptyTab>}
    </section>
    <section><h3>Repair history ({project.repairs.length})</h3>
      {project.repairs.length ? <div className="repair-audit">{project.repairs.map(repair => (
        <div key={repair.id} className="repair-audit-row"><RotateCcw size={14} /><div><strong>{repair.failureCode.replaceAll('_', ' ')}</strong><span>{repair.action}{repair.attemptNumber ? ` · attempt ${repair.attemptNumber}/${repair.maximumAttempts}` : ''}</span></div><StatusPill value={repair.status} /></div>
      ))}</div> : <EmptyTab>No repair has been required.</EmptyTab>}
    </section>
  </>;
}

function PublishingPanel({ project }: Pick<ProjectTabPanelProps, 'project'>): JSX.Element {
  return <>
    <section><h3>Publishing package ({project.packaging.length})</h3>
      {project.packaging.length ? <div className="workspace-list">{project.packaging.map(item => (
        <article key={item.id} className="workspace-row"><div><strong>{item.title}</strong><span>{item.angle} · {item.tags.join(', ')}</span><p>{item.viewerPromise}</p></div><div className="workspace-statuses"><StatusPill value={item.riskStatus} />{item.selected ? <StatusPill value="selected" /> : null}</div></article>
      ))}</div> : <EmptyTab>No publishing package has been generated.</EmptyTab>}
    </section>
    <section><h3>Publication receipts ({project.publicationRecords.length})</h3>
      {project.publicationRecords.length ? <div className="workspace-list">{project.publicationRecords.map(item => (
        <article key={item.id} className="workspace-row"><div><strong>{item.videoId ?? 'Upload pending'}</strong><span>{item.privacyStatus} · final {item.finalRenderId ?? 'legacy/unbound'} · SHA-256 {item.finalSha256.slice(0, 12)}… · captions {item.captionId ? 'attached' : 'pending'} · thumbnail {item.thumbnailUploaded ? 'attached' : 'pending'}</span><p>{item.error ?? `Updated ${dateTime(item.updatedAt)}`}</p></div><StatusPill value={item.staleRemote ? 'stale private upload' : item.snapshotStatus === 'current' ? item.processingStatus ?? item.privacyStatus : item.snapshotStatus} /></article>
      ))}</div> : <EmptyTab>No upload or publication receipt exists.</EmptyTab>}
    </section>
    <section><h3>Analytics snapshots ({project.analyticsSnapshots.length})</h3>
      {project.analyticsSnapshots.length ? <div className="workspace-list">{project.analyticsSnapshots.map(item => (
        <article key={item.id} className="workspace-row"><div><strong>Day {item.snapshotDay} · {item.videoId}</strong><span>{item.source.replaceAll('_', ' ')} · {item.mappings.length} scene retention mappings · {dateTime(item.capturedAt)}</span></div><StatusPill value="captured" /><Evidence value={{ metrics: item.metrics, retention: item.retention, mappings: item.mappings }} /></article>
      ))}</div> : <EmptyTab>No analytics snapshot has been captured.</EmptyTab>}
    </section>
    {project.youtubeVideoId ? <Button variant="secondary" onClick={() => void window.videoFactory.system.openExternal(`https://www.youtube.com/watch?v=${project.youtubeVideoId}`)}><ExternalLink size={15} /> Open private video</Button> : null}
  </>;
}

function AuditPanel({ project, jobs, busy, retryJob }: Pick<ProjectTabPanelProps,
  'project' | 'jobs' | 'busy' | 'retryJob'>): JSX.Element {
  return <>
    <section><h3>Durable jobs ({jobs.length})</h3>
      {jobs.length ? <div className="workspace-list">{jobs.map(job => {
        const capability = job.retryCapability;
        const label = capability.action === 'expedite'
          ? 'Expedite scheduled retry'
          : capability.requiresReason
            ? 'Grant one attempt & retry'
            : capability.action === 'reconcile_and_retry'
              ? 'Reconcile & retry'
              : 'Retry job';
        return <article key={job.id} className="workspace-row">
          <RotateCcw size={15} />
          <div><strong>{job.type.replaceAll('_', ' ')}</strong>
            <span>attempt {job.attempt}/{job.maxAttempts} · version {job.transitionVersion} · updated {dateTime(job.updatedAt)}</span>
            <p>{job.error ?? capability.message}</p>
            {job.error ? <span>{capability.message}</span> : null}
          </div>
          <div className="workspace-statuses">
            <StatusPill value={job.state} />
            {capability.action !== 'none' ? <Button variant="secondary"
              busy={busy === `job:${job.id}`}
              disabled={busy !== null && busy !== `job:${job.id}`}
              onClick={() => void retryJob(job)}>{label}</Button> : null}
          </div>
        </article>;
      })}</div> : <EmptyTab>No durable job has been created for this project.</EmptyTab>}
    </section>
    <section><h3>Immutable audit trail ({project.auditLog.length})</h3>
      {project.auditLog.length ? <div className="workspace-list audit-workspace-list">{project.auditLog.map(item => (
        <article key={item.id} className="workspace-row"><FileCheck2 size={15} /><div><strong>{item.action.replaceAll('_', ' ')}</strong><span>{item.actor} · {item.entityType ?? 'project'} {item.entityId ?? ''} · {dateTime(item.createdAt)}</span></div><Evidence value={{ before: item.before, after: item.after, metadata: item.metadata }} /></article>
      ))}</div> : <EmptyTab>No audit event has been recorded.</EmptyTab>}
    </section>
  </>;
}

export function ProjectTabPanel(props: ProjectTabPanelProps): JSX.Element {
  switch (props.tab) {
    case 'overview': return <OverviewPanel {...props} />;
    case 'research': return <ResearchPanel project={props.project} />;
    case 'script': return <ScriptPanel project={props.project} />;
    case 'storyboard': return <StoryboardPanel {...props} />;
    case 'assets': return <AssetsPanel project={props.project} />;
    case 'voice': return <VoicePanel {...props} />;
    case 'renders': return <RendersPanel project={props.project} />;
    case 'publishing': return <PublishingPanel project={props.project} />;
    case 'audit': return <AuditPanel {...props} />;
  }
}
