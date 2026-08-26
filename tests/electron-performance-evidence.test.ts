import { describe, expect, it } from 'vitest';
import {
  assessElectronPerformanceEvidence,
  type ElectronPerformanceEvidenceInput
} from '../scripts/electron-performance-evidence.mjs';

function evidence(overrides: Partial<ElectronPerformanceEvidenceInput> = {}): ElectronPerformanceEvidenceInput {
  const fast = [20, 22, 24, 26, 28, 30, 32, 34, 36, 38];
  return {
    schemaVersion: 1,
    generatedAt: '2026-08-26T12:00:00.000Z',
    harness: 'videofactory-electron-performance',
    mode: 'qualification',
    source: {
      commit: 'a'.repeat(40), tree: 'b'.repeat(40), ref: 'main', repository: 'fixture',
      workflowCommit: null, runId: null, runAttempt: null, dirty: false
    },
    environment: {
      platform: 'win32', release: '10.0.26100', architecture: 'x64', node: 'v22.22.0',
      electron: '43.2.0', cpuModel: 'Qualification CPU', logicalCpuCount: 16,
      totalMemoryBytes: 32 * 1024 ** 3, ci: false, productionBuild: true,
      deviceClass: 'Windows 11 production workstation'
    },
    fixture: { requestedRows: 26_000, xlsxSha256: 'c'.repeat(64), xlsxBytes: 4_000_000 },
    measurements: {
      import: {
        previewRows: 26_000, insertedRows: 26_000, committedRows: 26_000, catalogRows: 26_000,
        integrity: 'ok', progressEvents: 20, previewObservedActive: true, commitObservedActive: true,
        previewHeartbeatGapsMs: fast, commitHeartbeatGapsMs: fast,
        previewNavigationSamplesMs: fast, commitNavigationSamplesMs: fast
      },
      startup: { usableMs: 1_900, electronLaunchMs: 1_000, rendererReadyMs: 900 },
      catalog: {
        totalRows: 26_000, domRows: 50, searchSamplesMs: fast,
        uiInteractionSamplesMs: fast, scrollFrameSamplesMs: fast,
        rendererWorkingSetKb: 180_000
      },
      backgroundRender: {
        engine: 'ffmpeg-static/libx264', workload: 'draft-1080p30-veryfast',
        resourcePolicy: 'interactive-reserve-v1', threadCount: 8,
        observedRunning: true, observedFrameProgress: true,
        elapsedMs: 8_000, heartbeatGapsMs: fast, navigationSamplesMs: fast,
        searchSamplesMs: fast, rendererWorkingSetKb: 220_000
      }
    },
    ...overrides
  };
}

describe('Electron production performance evidence', () => {
  it('[CAT-001][CAT-009][PERF-001][PERF-002][PERF-003] qualifies only full clean target evidence', () => {
    const assessed = assessElectronPerformanceEvidence(evidence());
    expect(assessed.fullDatasetCriteriaPassed).toBe(true);
    expect(assessed.targetEligibility.eligible).toBe(true);
    expect(assessed.externalQualificationPassed).toBe(true);
    expect(Object.values(assessed.acceptance)).toEqual(Array(5).fill('qualified'));
    expect(assessed.derived.catalogSearchP95Ms).toBe(38);
  });

  it('keeps Linux, CI, dirty, reduced, and supporting runs non-qualifying', () => {
    const input = evidence({
      mode: 'supporting',
      source: { ...evidence().source, dirty: true },
      environment: {
        ...evidence().environment,
        platform: 'linux', architecture: 'x64', ci: true, deviceClass: null
      },
      fixture: { ...evidence().fixture, requestedRows: 2_000 },
      measurements: {
        ...evidence().measurements,
        import: {
          ...evidence().measurements.import,
          previewRows: 2_000, insertedRows: 2_000, committedRows: 2_000, catalogRows: 2_000
        },
        catalog: { ...evidence().measurements.catalog, totalRows: 2_000 }
      }
    });
    const assessed = assessElectronPerformanceEvidence(input);
    expect(assessed.smokeCriteriaPassed).toBe(true);
    expect(assessed.fullDatasetCriteriaPassed).toBe(false);
    expect(assessed.targetEligibility.eligible).toBe(false);
    expect(assessed.externalQualificationPassed).toBe(false);
    expect(new Set(Object.values(assessed.acceptance))).toEqual(new Set(['supporting']));
    expect(assessed.targetEligibility.reasons).toHaveLength(6);
  });

  it('fails closed for count drift, stalled renderers, missing FFmpeg progress, and malformed evidence', () => {
    const countDrift = evidence();
    countDrift.measurements.import.committedRows = 25_999;
    expect(assessElectronPerformanceEvidence(countDrift).acceptance['CAT-001']).toBe('failed');

    const stalled = evidence();
    stalled.measurements.backgroundRender.heartbeatGapsMs = [20, 20, 20, 20, 20, 20, 20, 20, 20, 500];
    expect(assessElectronPerformanceEvidence(stalled).acceptance['PERF-002']).toBe('failed');

    const noFrames = evidence();
    noFrames.measurements.backgroundRender.observedFrameProgress = false;
    expect(assessElectronPerformanceEvidence(noFrames).externalQualificationPassed).toBe(false);

    const malformed = evidence();
    malformed.fixture.xlsxSha256 = 'not-a-digest';
    expect(() => assessElectronPerformanceEvidence(malformed)).toThrow(/SHA-256/);

    const wrongThreadPolicy = evidence();
    wrongThreadPolicy.measurements.backgroundRender.threadCount = 16;
    expect(() => assessElectronPerformanceEvidence(wrongThreadPolicy)).toThrow(/FFmpeg threads/);
  });
});
