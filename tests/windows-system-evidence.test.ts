import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  WINDOWS_SYSTEM_GATE_IDS,
  assessWindowsSystemEvidence,
  collectWindowsSystemEvidence
} from '../scripts/windows-system-evidence.mjs';
import {
  WINDOWS_SYSTEM_FIXTURE_SOURCE,
  windowsSystemEvidenceFixture
} from './fixtures/windows-system-evidence-fixture';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Windows system qualification evidence', () => {
  it('[SYS-001][SYS-003][SYS-004] qualifies a clean install, encoder matrix, and storage matrix', () => {
    const assessed = assessWindowsSystemEvidence(windowsSystemEvidenceFixture());
    expect(assessed.externalQualificationPassed).toBe(true);
    expect(assessed.qualifiedGateIds).toEqual(WINDOWS_SYSTEM_GATE_IDS);
    expect(assessed.acceptance).toEqual({
      'SYS-001': 'qualified',
      'SYS-003': 'qualified',
      'SYS-004': 'qualified'
    });
  });

  it('fails closed when a representative hardware encoder is only advertised', () => {
    const receipt = windowsSystemEvidenceFixture();
    const intel = receipt.observations.find(value =>
      (value.runner as Record<string, unknown>).hardwareClass === 'intel')!;
    (intel.diagnostics as Record<string, unknown>).qsvUsable = false;
    const assessed = assessWindowsSystemEvidence(receipt);
    expect(assessed.externalQualificationPassed).toBe(false);
    expect(assessed.failures).toContain('intel hardware encoder observation is missing or failed');
  });

  it('fails closed when storage classification is asserted without matching observations', () => {
    const receipt = windowsSystemEvidenceFixture();
    const first = receipt.observations[0]!;
    ((first.storage as Array<Record<string, unknown>>)[0]!).writable = true;
    const assessed = assessWindowsSystemEvidence(receipt);
    expect(assessed.externalQualificationPassed).toBe(false);
    expect(assessed.failures).toContain('read_only storage failure mode is missing or failed');
  });

  it('rejects mixed qualifier scripts', () => {
    const receipt = windowsSystemEvidenceFixture();
    (receipt.observations[1]!.artifacts as Record<string, unknown>).qualifierSha256 = '1'.repeat(64);
    expect(() => assessWindowsSystemEvidence(receipt)).toThrow(/qualifier script/i);
  });

  it('collects exact raw observations while omitting device labels and filesystem paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'videofactory-windows-system-collector-'));
    roots.push(root);
    const qualifierPath = resolve(root, 'QUALIFY_WINDOWS_SYSTEM.ps1');
    const qualifierBytes = Buffer.from('# signed fixture qualifier\n');
    const qualifierSha256 = createHash('sha256').update(qualifierBytes).digest('hex');
    writeFileSync(qualifierPath, qualifierBytes);
    const fixture = windowsSystemEvidenceFixture();
    const paths = fixture.observations.map((value, index) => {
      const observation = value as Record<string, any>;
      const { observationSha256: _sha, observationSizeBytes: _size, ...body } = observation;
      const { deviceClassSha256: _deviceHash, ...runner } = body.runner as Record<string, unknown>;
      const artifacts = structuredClone(body.artifacts) as Record<string, unknown>;
      artifacts.qualifierSha256 = qualifierSha256;
      const raw = {
        observationVersion: 1,
        evidenceKind: 'videofactory-windows-system-observation',
        capturedAt: body.capturedAt,
        appVersion: fixture.appVersion,
        source: WINDOWS_SYSTEM_FIXTURE_SOURCE,
        runner: { ...runner, deviceClass: `Fixture-device-class-${index + 1}` },
        environment: body.environment,
        artifacts,
        installation: body.installation,
        eventStream: body.eventStream,
        diagnostics: body.diagnostics,
        renderer: body.renderer,
        storage: body.storage,
        storageIntegrity: body.storageIntegrity
      };
      const path = resolve(root, `observation-${index + 1}.json`);
      writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
      return path;
    });
    const collected = collectWindowsSystemEvidence({
      observationPaths: paths,
      source: WINDOWS_SYSTEM_FIXTURE_SOURCE,
      appVersion: fixture.appVersion,
      qualifierPath,
      now: new Date('2026-08-26T13:00:00.000Z')
    });
    expect(collected.assessment.externalQualificationPassed).toBe(true);
    expect(collected.receipt.qualifierSha256).toBe(qualifierSha256);
    const serialized = JSON.stringify(collected.receipt);
    expect(serialized).not.toContain('Fixture-device-class');
    expect(serialized).not.toContain('read-only');
  });
});
