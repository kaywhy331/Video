import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, FileVideo2, FolderOpen, RefreshCw, RotateCcw, ShieldOff } from 'lucide-react';
import type { AmbiguousFileMappingRecovery, ExceptionRecord } from '@shared/types';
import { Button, EmptyState, Panel, StatusPill } from '../components/ui';

function dateTime(value: string): string {
  return new Date(value).toLocaleString();
}

export function ExceptionsView({ onRefresh, onOpenProject, setError }: {
  onRefresh: () => Promise<void>;
  onOpenProject: (projectId: string) => void;
  setError: (message: string | null) => void;
}) {
  const [rows, setRows] = useState<ExceptionRecord[]>([]);
  const [mappingRecoveries, setMappingRecoveries] = useState<Record<string, AmbiguousFileMappingRecovery>>({});
  const [overrideReasons, setOverrideReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  async function load(): Promise<void> {
    const nextRows = await window.videoFactory.exceptions.list({ openOnly: true });
    const recoveries = await Promise.all(nextRows.filter(row => row.code === 'AMBIGUOUS_FILE_MAPPING')
      .map(async row => [row.id, await window.videoFactory.exceptions.ambiguousMapping(row.id)] as const));
    setRows(nextRows);
    setMappingRecoveries(Object.fromEntries(recoveries));
  }

  useEffect(() => { void load().catch(error => setError(error instanceof Error ? error.message : String(error))); }, []);

  async function act(key: string, work: () => Promise<unknown>): Promise<void> {
    setBusy(key); setError(null);
    try { await work(); await load(); await onRefresh(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); await load().catch(() => undefined); }
    finally { setBusy(null); }
  }

  async function resolve(id: string): Promise<void> {
    await act(`resolve:${id}`, () => window.videoFactory.exceptions.resolve({
      id,
      resolution: { method: 'operator_acknowledged', note: 'Operator confirmed the condition is understood and safe to close.' }
    }));
  }

  async function retry(id: string): Promise<void> {
    await act(`retry:${id}`, () => window.videoFactory.exceptions.retry(id));
  }

  async function override(id: string): Promise<void> {
    const reason = overrideReasons[id]?.trim() ?? '';
    await act(`override:${id}`, () => window.videoFactory.exceptions.override({ id, reason }));
  }

  async function resolveAmbiguousMapping(exceptionId: string, acquisitionId: string): Promise<void> {
    await act(`${exceptionId}:${acquisitionId}`, () => window.videoFactory.exceptions.resolveAmbiguousMapping({ exceptionId, acquisitionId }));
  }

  return <div className="view-stack">
    <div className="page-heading"><div><div className="eyebrow"><AlertTriangle size={14} /> EXCEPTION INBOX</div><h1>Review only the problems automation cannot resolve safely.</h1><p>Every item includes its project context, safe alternatives, permitted actions, and an immutable action trail.</p></div><Button variant="ghost" onClick={() => void load().catch(error => setError(error instanceof Error ? error.message : String(error)))}><RefreshCw size={15} /> Refresh</Button></div>
    {rows.length ? <div className="exception-cards">{rows.map(row => <Panel key={row.id} className={`exception-card severity-border-${row.severity.toLowerCase()}`}>
      <div className="exception-card-head"><div>
        <div className="exception-meta"><StatusPill value={row.severity} /><span>{row.stage}</span><code>{row.code}</code><span>{dateTime(row.createdAt)}</span></div>
        <h3>{row.title}</h3><p>{row.message}</p>
        <div className="exception-project-context"><span>Project</span><strong>{row.projectTitle ?? (row.projectId ? 'Untitled project' : 'System-wide')}</strong>{row.projectId ? <Button variant="ghost" onClick={() => onOpenProject(row.projectId!)}><FolderOpen size={14} /> Open project</Button> : null}</div>
      </div><div className="exception-primary-actions">
        {row.retryAction ? <Button variant="secondary" busy={busy === `retry:${row.id}`} onClick={() => void retry(row.id)}><RotateCcw size={15} /> Retry {row.retryAction.replaceAll('_', ' ')}</Button> : null}
        {row.canAcknowledge ? <Button variant="secondary" busy={busy === `resolve:${row.id}`} onClick={() => void resolve(row.id)}><CheckCircle2 size={15} /> Resolve</Button> : null}
        {!row.retryAction && !row.canAcknowledge && row.code !== 'AMBIGUOUS_FILE_MAPPING' ? <StatusPill value="repair required" /> : null}
      </div></div>

      {row.code === 'AMBIGUOUS_FILE_MAPPING' ? <div className="mapping-recovery">
        <div className="mapping-file"><FileVideo2 size={18} /><div><strong>{mappingRecoveries[row.id]?.fileName ?? 'Detected download'}</strong><code>{mappingRecoveries[row.id]?.filePath ?? 'Loading persisted path…'}</code></div></div>
        {mappingRecoveries[row.id]?.candidates.length ? <div className="mapping-candidates">{mappingRecoveries[row.id]!.candidates.map(candidate => <div className="mapping-candidate" key={candidate.acquisitionId}><div className="mapping-candidate-thumb">{candidate.thumbnailUrl ? <img src={candidate.thumbnailUrl} alt="" /> : <FileVideo2 size={24} />}</div><div className="mapping-candidate-copy"><strong>{candidate.assetTitle}</strong><span>{candidate.projectTitle}</span><span>Scene{candidate.requiredForScenes.length === 1 ? '' : 's'} {candidate.requiredForScenes.join(', ') || 'not assigned'}</span><StatusPill value={candidate.state} /></div><Button variant="secondary" busy={busy === `${row.id}:${candidate.acquisitionId}`} onClick={() => void resolveAmbiguousMapping(row.id, candidate.acquisitionId)}>Map and ingest</Button></div>)}</div> : <div className="recommended-action"><strong>No safe candidate is currently available</strong><span>Return to Downloads and activate the intended acquisition item, then refresh this exception.</span></div>}
      </div> : null}

      {row.recommendedAction ? <div className="recommended-action"><strong>Recommended action</strong><span>{row.recommendedAction}</span></div> : null}
      {row.safeAlternatives.length ? <div className="safe-alternatives"><strong>Safe alternatives</strong><ul>{row.safeAlternatives.map(alternative => <li key={alternative}>{alternative}</li>)}</ul></div> : null}

      {row.canOverride ? <div className="exception-override"><label htmlFor={`override-${row.id}`}><span>Reasoned override</span><textarea id={`override-${row.id}`} value={overrideReasons[row.id] ?? ''} maxLength={1000} placeholder="Explain specifically why proceeding is safe (minimum 10 characters)." onChange={event => setOverrideReasons(current => ({ ...current, [row.id]: event.target.value }))} /></label><Button variant="danger" busy={busy === `override:${row.id}`} disabled={(overrideReasons[row.id]?.trim().length ?? 0) < 10} onClick={() => void override(row.id)}><ShieldOff size={15} /> Override with audit</Button></div> : null}

      <div className="exception-details-grid"><details><summary>Evidence</summary><pre>{JSON.stringify(row.evidence, null, 2)}</pre></details><details><summary>Action history ({row.auditTrail.length})</summary>{row.auditTrail.length ? <div className="exception-audit-list">{row.auditTrail.map(item => <div key={item.id}><strong>{item.action.replaceAll('_', ' ')}</strong><span>{item.actor} · {dateTime(item.createdAt)}</span>{item.metadata ? <pre>{JSON.stringify(item.metadata, null, 2)}</pre> : null}</div>)}</div> : <p>No operator action has been recorded yet.</p>}</details></div>
    </Panel>)}</div> : <EmptyState title="No open exceptions" body="The production pipeline has no unresolved blockers or warnings." />}
  </div>;
}
