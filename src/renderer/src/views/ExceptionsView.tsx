import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';
import type { ExceptionRecord } from '@shared/types';
import { Button, EmptyState, Panel, StatusPill } from '../components/ui';

export function ExceptionsView({
  onRefresh,
  setError
}: {
  onRefresh: () => Promise<void>;
  setError: (message: string | null) => void;
}) {
  const [rows, setRows] = useState<ExceptionRecord[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  async function load(): Promise<void> {
    setRows(await window.videoFactory.exceptions.list({ openOnly: true }));
  }

  useEffect(() => { void load(); }, []);

  async function resolve(id: string): Promise<void> {
    setBusy(id);
    setError(null);
    try {
      await window.videoFactory.exceptions.resolve({ id, resolution: { method: 'operator_acknowledged' } });
      await load();
      await onRefresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="view-stack">
      <div className="page-heading">
        <div>
          <div className="eyebrow"><AlertTriangle size={14} /> EXCEPTION INBOX</div>
          <h1>Review only the problems automation cannot resolve safely.</h1>
          <p>Geographic, rights, no-upscale, media, and publishing blockers fail closed.</p>
        </div>
        <Button variant="ghost" onClick={() => void load()}><RefreshCw size={15} /> Refresh</Button>
      </div>
      {rows.length ? (
        <div className="exception-cards">
          {rows.map(row => (
            <Panel key={row.id} className={`exception-card severity-border-${row.severity.toLowerCase()}`}>
              <div className="exception-card-head">
                <div>
                  <div className="exception-meta">
                    <StatusPill value={row.severity} />
                    <span>{row.stage}</span>
                    <code>{row.code}</code>
                  </div>
                  <h3>{row.title}</h3>
                  <p>{row.message}</p>
                </div>
                <Button
                  variant="secondary"
                  busy={busy === row.id}
                  disabled={['BLOCKER', 'HIGH'].includes(row.severity)}
                  onClick={() => void resolve(row.id)}
                >
                  <CheckCircle2 size={15} /> {['BLOCKER', 'HIGH'].includes(row.severity) ? 'Repair required' : 'Acknowledge'}
                </Button>
              </div>
              {row.recommendedAction ? (
                <div className="recommended-action">
                  <strong>Recommended action</strong>
                  <span>{row.recommendedAction}</span>
                </div>
              ) : null}
              <details>
                <summary>Evidence</summary>
                <pre>{JSON.stringify(row.evidence, null, 2)}</pre>
              </details>
            </Panel>
          ))}
        </div>
      ) : (
        <EmptyState title="No open exceptions" body="The production pipeline has no unresolved blockers or warnings." />
      )}
    </div>
  );
}
