import type { ButtonHTMLAttributes, ReactNode } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  Clock3,
  LoaderCircle,
  PauseCircle,
  XCircle
} from 'lucide-react';

export function Button({
  children,
  variant = 'primary',
  busy = false,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  busy?: boolean;
}) {
  return (
    <button className={`button button-${variant}`} {...props} disabled={props.disabled || busy}>
      {busy ? <LoaderCircle size={16} className="spin" /> : null}
      {children}
    </button>
  );
}

export function StatusPill({ value }: { value: string }) {
  const normalized = value.toLowerCase();
  const kind = normalized.includes('fail') || normalized.includes('block') || normalized.includes('conflict')
    ? 'danger'
    : normalized.includes('complete') || normalized.includes('succeed') || normalized.includes('verified')
      || normalized.includes('publish') || normalized.includes('pass')
      ? 'success'
      : normalized.includes('wait') || normalized.includes('pending') || normalized.includes('queue')
        ? 'warning'
        : normalized.includes('run') || normalized.includes('process') || normalized.includes('render')
          ? 'active'
          : 'neutral';
  const icon = kind === 'danger'
    ? <XCircle size={13} />
    : kind === 'success'
      ? <CheckCircle2 size={13} />
      : kind === 'warning'
        ? <Clock3 size={13} />
        : kind === 'active'
          ? <CircleDot size={13} />
          : <PauseCircle size={13} />;
  return <span className={`status-pill status-${kind}`}>{icon}{value.replaceAll('_', ' ')}</span>;
}

export function ProgressBar({ value, label }: { value: number; label?: string }) {
  const percent = Math.max(0, Math.min(100, Math.round(value * 100)));
  return (
    <div className="progress-wrap">
      <div className="progress-track"><div className="progress-fill" style={{ width: `${percent}%` }} /></div>
      {label ? <div className="progress-label"><span>{label}</span><strong>{percent}%</strong></div> : null}
    </div>
  );
}

export function MetricCard({
  label,
  value,
  detail,
  icon
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="metric-card">
      <div className="metric-card-top"><span>{label}</span>{icon}</div>
      <div className="metric-value">{value}</div>
      {detail ? <div className="metric-detail">{detail}</div> : null}
    </div>
  );
}

export function EmptyState({
  title,
  body,
  action
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon"><CircleDot size={28} /></div>
      <h3>{title}</h3>
      <p>{body}</p>
      {action}
    </div>
  );
}

export function ErrorBanner({
  title = 'Action could not be completed',
  message,
  onDismiss
}: {
  title?: string;
  message: string;
  onDismiss?: () => void;
}) {
  return (
    <div className="error-banner">
      <AlertTriangle size={18} />
      <div><strong>{title}</strong><span>{message}</span></div>
      {onDismiss ? <button onClick={onDismiss} aria-label="Dismiss">×</button> : null}
    </div>
  );
}

export function Panel({
  title,
  subtitle,
  action,
  children,
  className = ''
}: {
  title?: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {title || subtitle || action ? (
        <header className="panel-header">
          <div>
            {title ? <h2>{title}</h2> : null}
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          {action}
        </header>
      ) : null}
      {children}
    </section>
  );
}
