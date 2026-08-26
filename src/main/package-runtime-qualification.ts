import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const PACKAGE_RUNTIME_QUALIFICATION_SCHEMA_VERSION = 1;
export const PACKAGE_RUNTIME_QUALIFICATION_RELATIVE_PATH = join(
  'qualification',
  'windows-package-runtime.jsonl'
);

export type PackageRuntimeQualificationEventName =
  | 'qualification_started'
  | 'tray_ready'
  | 'power_blocker_started'
  | 'power_blocker_stopped'
  | 'window_hidden_to_tray'
  | 'shutdown_started'
  | 'shutdown_completed';

export interface PackageRuntimeQualificationEvent {
  schemaVersion: number;
  sequence: number;
  at: string;
  event: PackageRuntimeQualificationEventName;
  pid: number;
  details: Record<string, boolean | number | string | null>;
}

interface PackageRuntimeQualificationOptions {
  dataRoot: string;
  isPackaged: boolean;
  environmentFlag?: string;
}

/**
 * Writes qualification-only, append-only lifecycle observations from the real
 * packaged main process. It is inert unless the package smoke explicitly opts in.
 */
export class PackageRuntimeQualificationRecorder {
  readonly enabled: boolean;
  readonly path: string | null;
  private sequence = 0;

  constructor(options: PackageRuntimeQualificationOptions) {
    this.enabled = options.isPackaged && options.environmentFlag === '1';
    this.path = this.enabled
      ? join(options.dataRoot, PACKAGE_RUNTIME_QUALIFICATION_RELATIVE_PATH)
      : null;
    if (!this.path) return;

    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, '', 'utf8');
    this.record('qualification_started', { packaged: true });
  }

  record(
    event: PackageRuntimeQualificationEventName,
    details: Record<string, boolean | number | string | null> = {}
  ): void {
    if (!this.path) return;
    const observation: PackageRuntimeQualificationEvent = {
      schemaVersion: PACKAGE_RUNTIME_QUALIFICATION_SCHEMA_VERSION,
      sequence: this.sequence += 1,
      at: new Date().toISOString(),
      event,
      pid: process.pid,
      details
    };
    appendFileSync(this.path, `${JSON.stringify(observation)}\n`, 'utf8');
  }
}
