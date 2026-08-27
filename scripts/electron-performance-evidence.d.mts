import type { ValidationSource } from './validation-source.mjs';

export type ElectronPerformanceMode = 'supporting' | 'qualification';
export type ElectronPerformanceGateId = 'CAT-001' | 'CAT-009' | 'PERF-001' | 'PERF-002' | 'PERF-003';

export interface ElectronPerformanceEvidenceInput {
  schemaVersion: 2;
  generatedAt: string;
  harness: 'videofactory-electron-performance';
  mode: ElectronPerformanceMode;
  source: ValidationSource;
  environment: {
    platform: string;
    release: string;
    architecture: string;
    node: string;
    electron: string;
    cpuModel: string;
    logicalCpuCount: number;
    totalMemoryBytes: number;
    ci: boolean;
    productionBuild: true;
    deviceClass: string | null;
  };
  fixture: {
    requestedRows: number;
    xlsxSha256: string;
    xlsxBytes: number;
  };
  measurements: {
    import: {
      previewRows: number;
      insertedRows: number;
      committedRows: number;
      catalogRows: number;
      integrity: string;
      progressEvents: number;
      previewObservedActive: boolean;
      commitObservedActive: boolean;
      previewHeartbeatGapsMs: number[];
      commitHeartbeatGapsMs: number[];
      previewNavigationSamplesMs: number[];
      commitNavigationSamplesMs: number[];
    };
    startup: {
      warmupCompleted: true;
      warmupUsableMs: number;
      usableMs: number;
      electronLaunchMs: number;
      rendererReadyMs: number;
    };
    catalog: {
      totalRows: number;
      domRows: number;
      searchSamplesMs: number[];
      uiInteractionSamplesMs: number[];
      scrollFrameSamplesMs: number[];
      rendererWorkingSetKb: number;
    };
    backgroundRender: {
      engine: 'ffmpeg-static/libx264';
      workload: 'draft-1080p30-veryfast';
      resourcePolicy: 'interactive-reserve-v1';
      threadCount: number;
      observedRunning: boolean;
      observedFrameProgress: boolean;
      elapsedMs: number;
      heartbeatGapsMs: number[];
      navigationSamplesMs: number[];
      searchSamplesMs: number[];
      rendererWorkingSetKb: number;
    };
  };
}

export interface ElectronPerformanceEvidence extends ElectronPerformanceEvidenceInput {
  thresholds: typeof ELECTRON_PERFORMANCE_THRESHOLDS;
  derived: Record<string, number>;
  targetEligibility: {
    eligible: boolean;
    checks: Record<string, boolean>;
    reasons: string[];
  };
  acceptance: Record<ElectronPerformanceGateId, 'qualified' | 'supporting' | 'failed'>;
  smokeCriteriaPassed: boolean;
  fullDatasetCriteriaPassed: boolean;
  externalQualificationPassed: boolean;
}

export const ELECTRON_PERFORMANCE_SCHEMA_VERSION: 2;
export const ELECTRON_PERFORMANCE_FFMPEG_RESOURCE_POLICY: 'interactive-reserve-v1';
export const ELECTRON_PERFORMANCE_GATE_IDS: readonly ElectronPerformanceGateId[];
export const ELECTRON_PERFORMANCE_THRESHOLDS: Readonly<{
  qualificationRows: number;
  startupUsableMs: number;
  catalogSearchP95Ms: number;
  uiInteractionP95Ms: number;
  rendererHeartbeatP99Ms: number;
  scrollFrameP99Ms: number;
  maximumDomRows: number;
  minimumBackgroundRenderMs: number;
}>;
export function percentile(samples: number[], quantile: number): number;
export function assessElectronPerformanceEvidence(document: ElectronPerformanceEvidenceInput): ElectronPerformanceEvidence;
