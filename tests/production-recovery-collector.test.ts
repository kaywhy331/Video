import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectProductionRecoveryEvidence } from '../scripts/collect-production-recovery-evidence.mjs';
import { PRODUCTION_RECOVERY_DRILL_KINDS } from '../scripts/production-recovery-evidence.mjs';
import type { ValidationSource } from '../scripts/validation-source.mjs';
import { qualifyingProductionRecoveryObservation } from './fixtures/production-recovery-evidence-fixture';

const roots: string[] = [];
const source: ValidationSource = {
  commit: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  ref: 'main',
  repository: 'owner/repository',
  workflowCommit: null,
  runId: null,
  runAttempt: null,
  dirty: false
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(mutator?: (value: any, kind: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'videofactory-production-recovery-'));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  const paths = PRODUCTION_RECOVERY_DRILL_KINDS.map(kind => {
    const value = qualifyingProductionRecoveryObservation(kind, { source });
    mutator?.(value, kind);
    const path = join(root, `${kind}.json`);
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
    return path;
  });
  return { root, paths };
}

describe('production recovery collector', () => {
  it('[E2E-004] hashes and privacy-reduces six exact-source raw drill observations', () => {
    const { paths } = fixture();
    const collected = collectProductionRecoveryEvidence({
      observationPaths: paths,
      source,
      appVersion: '0.1.0-alpha.7',
      now: new Date('2026-08-26T22:00:00.000Z')
    });

    expect(collected.assessment.externalQualificationPassed).toBe(true);
    expect(collected.receipt.observations.map(value => value.kind)).toEqual(PRODUCTION_RECOVERY_DRILL_KINDS);
    expect(collected.receipt.observations[0]!.observationSha256).toBe(
      createHash('sha256').update(readFileSync(paths[0]!)).digest('hex')
    );
    const serialized = JSON.stringify(collected.receipt);
    expect(serialized).not.toContain('representative-operator-workstation');
    expect(serialized).not.toContain('private-project-and-work-id');
    expect(serialized).not.toContain('10001');
    expect(serialized).not.toContain('20001');
  });

  it('rejects source drift, wrong app versions, and mixed machine/application observations', () => {
    const drifted = fixture((value, kind) => {
      if (kind === 'render') value.source.tree = 'c'.repeat(40);
    });
    expect(() => collectProductionRecoveryEvidence({
      observationPaths: drifted.paths,
      source,
      appVersion: '0.1.0-alpha.7'
    })).toThrow(/exact admitted source/);

    const wrongVersion = fixture((value, kind) => {
      if (kind === 'ingest') value.appVersion = '0.1.0-alpha.6';
    });
    expect(() => collectProductionRecoveryEvidence({
      observationPaths: wrongVersion.paths,
      source,
      appVersion: '0.1.0-alpha.7'
    })).toThrow(/wrong app version/);

    const mixed = fixture((value, kind) => {
      if (kind === 'restore') value.application.executableSha256 = 'f'.repeat(64);
    });
    expect(() => collectProductionRecoveryEvidence({
      observationPaths: mixed.paths,
      source,
      appVersion: '0.1.0-alpha.7'
    })).toThrow(/one identical packaged application/);
  });

  it('rejects duplicate files, wrong observation identity, and extra raw fields', () => {
    const duplicated = fixture();
    duplicated.paths[5] = duplicated.paths[0]!;
    expect(() => collectProductionRecoveryEvidence({
      observationPaths: duplicated.paths,
      source,
      appVersion: '0.1.0-alpha.7'
    })).toThrow(/paths must be unique/);

    const unknown = fixture((value, kind) => {
      if (kind === 'provider') value.evidenceKind = 'manual-attestation';
    });
    expect(() => collectProductionRecoveryEvidence({
      observationPaths: unknown.paths,
      source,
      appVersion: '0.1.0-alpha.7'
    })).toThrow(/unknown evidence identity/);

    const extra = fixture((value, kind) => {
      if (kind === 'provider') value.operatorSaysPassed = true;
    });
    expect(() => collectProductionRecoveryEvidence({
      observationPaths: extra.paths,
      source,
      appVersion: '0.1.0-alpha.7'
    })).toThrow(/fields must be exactly/);
  });

  it('does not emit a receipt when any raw stage fails the independent assessor', () => {
    const unsafe = fixture((value, kind) => {
      if (kind === 'upload_commit') {
        value.evidence.publicationCountAfter = 2;
      }
    });
    expect(() => collectProductionRecoveryEvidence({
      observationPaths: unsafe.paths,
      source,
      appVersion: '0.1.0-alpha.7'
    })).toThrow(/failed drill criteria: upload_commit/);
  });
});
