import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ElectronPerformanceEvidenceInput } from '../scripts/electron-performance-evidence.mjs';
import {
  ELECTRON_PERFORMANCE_RECEIPT_PATH,
  EXTERNAL_QUALIFICATION_INDEX_KIND,
  EXTERNAL_QUALIFICATION_INDEX_PATH,
  admitExternalQualificationEvidence,
  writeElectronPerformanceQualificationIndex
} from '../scripts/external-qualification-evidence.mjs';
import type { ValidationSource } from '../scripts/validation-source.mjs';

const roots: string[] = [];
const source: ValidationSource = {
  commit: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  ref: 'main',
  repository: 'fixture',
  workflowCommit: null,
  runId: null,
  runAttempt: null,
  dirty: false
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function evidence(overrides: Partial<ElectronPerformanceEvidenceInput> = {}): ElectronPerformanceEvidenceInput {
  const fast = [20, 22, 24, 26, 28, 30, 32, 34, 36, 38];
  return {
    schemaVersion: 1,
    generatedAt: '2026-08-26T12:00:00.000Z',
    harness: 'videofactory-electron-performance',
    mode: 'qualification',
    source,
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

function fixture(receipt = evidence()) {
  const root = mkdtempSync(join(tmpdir(), 'videofactory-external-qualification-'));
  roots.push(root);
  mkdirSync(resolve(root, 'validation/results'), { recursive: true });
  mkdirSync(resolve(root, 'validation/external-qualification'), { recursive: true });
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  writeFileSync(resolve(root, ELECTRON_PERFORMANCE_RECEIPT_PATH), receiptBytes);
  const index = {
    schemaVersion: 1,
    evidenceKind: EXTERNAL_QUALIFICATION_INDEX_KIND,
    generatedAt: '2026-08-26T12:01:00.000Z',
    qualification: 'release',
    source,
    receipts: [{
      kind: 'electron_performance',
      path: ELECTRON_PERFORMANCE_RECEIPT_PATH,
      sha256: createHash('sha256').update(receiptBytes).digest('hex'),
      sizeBytes: receiptBytes.length
    }]
  };
  writeFileSync(resolve(root, EXTERNAL_QUALIFICATION_INDEX_PATH), `${JSON.stringify(index, null, 2)}\n`);
  return { root, index, receiptBytes };
}

describe('external qualification evidence admission', () => {
  it('keeps an absent index pending without weakening validation', () => {
    const root = mkdtempSync(join(tmpdir(), 'videofactory-external-qualification-empty-'));
    roots.push(root);
    expect(admitExternalQualificationEvidence({ root, source })).toEqual({
      present: false,
      indexPath: EXTERNAL_QUALIFICATION_INDEX_PATH,
      index: null,
      receipts: [],
      qualifiedIds: [],
      qualifiedById: {}
    });
  });

  it('[CAT-001][CAT-009][PERF-001][PERF-002][PERF-003] admits only hashed exact-source target evidence', () => {
    const { root } = fixture();
    const admitted = admitExternalQualificationEvidence({
      root,
      source,
      allowedIds: ['CAT-001', 'CAT-009', 'PERF-001', 'PERF-002', 'PERF-003']
    });
    expect(admitted.present).toBe(true);
    expect(admitted.qualifiedIds).toEqual(['CAT-001', 'CAT-009', 'PERF-001', 'PERF-002', 'PERF-003']);
    expect(admitted.receipts).toHaveLength(1);
    expect(admitted.index?.path).toBe(EXTERNAL_QUALIFICATION_INDEX_PATH);
    expect(admitted.qualifiedById['PERF-002']?.kind).toBe('electron_performance');
  });

  it('writes and re-admits a canonical index for a passing target receipt', () => {
    const { root } = fixture();
    const admitted = writeElectronPerformanceQualificationIndex({
      root,
      source,
      now: new Date('2026-08-26T12:01:00.000Z')
    });
    expect(admitted.present).toBe(true);
    expect(admitted.qualifiedIds).toHaveLength(5);
    expect(admitted.index?.path).toBe(EXTERNAL_QUALIFICATION_INDEX_PATH);
  });

  it('fails closed for tampered bytes, source drift, ineligible runs, and disallowed coverage', () => {
    const tampered = fixture();
    writeFileSync(resolve(tampered.root, ELECTRON_PERFORMANCE_RECEIPT_PATH), 'tampered\n');
    expect(() => admitExternalQualificationEvidence({ root: tampered.root, source })).toThrow(/integrity/);

    const drifted = fixture();
    expect(() => admitExternalQualificationEvidence({
      root: drifted.root,
      source: { ...source, tree: 'd'.repeat(40) }
    })).toThrow(/exact admitted source/);

    const supporting = fixture(evidence({ mode: 'supporting' }));
    expect(() => admitExternalQualificationEvidence({ root: supporting.root, source })).toThrow(/not eligible/);

    const disallowed = fixture();
    expect(() => admitExternalQualificationEvidence({
      root: disallowed.root,
      source,
      allowedIds: ['CAT-001']
    })).toThrow(/disallowed gate ID/);
  });

  it('rejects unknown receipt kinds and non-normalized paths before admission', () => {
    const unknown = fixture();
    unknown.index.receipts[0]!.kind = 'manual_attestation';
    writeFileSync(
      resolve(unknown.root, EXTERNAL_QUALIFICATION_INDEX_PATH),
      `${JSON.stringify(unknown.index, null, 2)}\n`
    );
    expect(() => admitExternalQualificationEvidence({ root: unknown.root, source })).toThrow(/unknown receipt kind/);

    const traversal = fixture();
    (traversal.index.receipts[0]! as { path: string }).path = '../electron-performance.json';
    writeFileSync(
      resolve(traversal.root, EXTERNAL_QUALIFICATION_INDEX_PATH),
      `${JSON.stringify(traversal.index, null, 2)}\n`
    );
    expect(() => admitExternalQualificationEvidence({ root: traversal.root, source })).toThrow(/repository-relative/);
  });
});
