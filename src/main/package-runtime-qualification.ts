import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DiagnosticsReport, RendererReadyObservation } from '@shared/types';
import type { SystemStorageProbeObservation } from './system-storage-qualification';

export const PACKAGE_RUNTIME_QUALIFICATION_SCHEMA_VERSION = 1;
export const PACKAGE_RUNTIME_QUALIFICATION_RELATIVE_PATH = join(
  'qualification',
  'windows-package-runtime.jsonl'
);

export type PackageRuntimeQualificationEventName =
  | 'qualification_started'
  | 'system_diagnostics'
  | 'renderer_ready'
  | 'storage_probe'
  | 'storage_matrix_complete'
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
  systemEnvironmentFlag?: string;
}

/**
 * Writes qualification-only, append-only lifecycle observations from the real
 * packaged main process. It is inert unless the package smoke explicitly opts in.
 */
export class PackageRuntimeQualificationRecorder {
  readonly enabled: boolean;
  readonly systemQualification: boolean;
  readonly path: string | null;
  private sequence = 0;

  constructor(options: PackageRuntimeQualificationOptions) {
    this.systemQualification = options.isPackaged && options.systemEnvironmentFlag === '1';
    this.enabled = options.isPackaged && (options.environmentFlag === '1' || this.systemQualification);
    this.path = this.enabled
      ? join(options.dataRoot, PACKAGE_RUNTIME_QUALIFICATION_RELATIVE_PATH)
      : null;
    if (!this.path) return;

    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, '', 'utf8');
    this.record('qualification_started', {
      packaged: true,
      scope: this.systemQualification ? 'windows_system' : 'package_runtime'
    });
  }

  recordRendererReady(observation: RendererReadyObservation): void {
    this.record('renderer_ready', {
      activeView: observation.activeView,
      initialSetupRequired: observation.initialSetupRequired,
      setupReady: observation.setupReady,
      setupChecklistVisible: observation.setupChecklistVisible
    });
  }

  recordSystemDiagnostics(report: DiagnosticsReport): void {
    const encoder = (id: DiagnosticsReport['ffmpeg']['encoderTests'][number]['id']) =>
      report.ffmpeg.encoderTests.find(value => value.id === id);
    this.record('system_diagnostics', {
      platform: report.platform,
      status: report.status,
      issuesCount: report.issues.length,
      pathsReady: report.paths.length >= 7 && report.paths.every(path => path.exists && path.writable === true),
      databaseReady: report.database.open && report.database.integrity === 'ok' && report.database.walMode,
      ffmpegFound: report.ffmpeg.found,
      ffprobeFound: report.ffprobe.found,
      mediaEncoded: report.mediaSmokeTest.encoded,
      mediaProbed: report.mediaSmokeTest.probed,
      nvencAdvertised: encoder('h264_nvenc')?.advertised ?? false,
      nvencUsable: encoder('h264_nvenc')?.usable ?? false,
      qsvAdvertised: encoder('h264_qsv')?.advertised ?? false,
      qsvUsable: encoder('h264_qsv')?.usable ?? false,
      amfAdvertised: encoder('h264_amf')?.advertised ?? false,
      amfUsable: encoder('h264_amf')?.usable ?? false,
      softwareAdvertised: encoder('libx264')?.advertised ?? false,
      softwareUsable: encoder('libx264')?.usable ?? false
    });
  }

  recordStorageProbe(observation: SystemStorageProbeObservation): void {
    this.record('storage_probe', {
      kind: observation.kind,
      pathType: observation.pathType,
      pathSha256: observation.pathSha256,
      observed: observation.observed,
      matched: observation.matched,
      exists: observation.exists,
      directory: observation.directory,
      writable: observation.writable,
      freeBytes: observation.freeBytes,
      statErrorCode: observation.statErrorCode,
      writeErrorCode: observation.writeErrorCode,
      timedOut: observation.timedOut
    });
  }

  recordStorageMatrixComplete(details: {
    probeCount: number;
    matchedCount: number;
    databaseIntegrity: string;
    databaseChangesBefore: number;
    databaseChangesAfter: number;
  }): void {
    this.record('storage_matrix_complete', {
      ...details,
      databaseUnchanged: details.databaseChangesAfter === details.databaseChangesBefore
    });
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
