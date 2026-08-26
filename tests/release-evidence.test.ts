import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  assertReleaseEvidenceGitBinding,
  assertReleaseEvidenceIndex
} from '../scripts/release-evidence.mjs';

const evidencePath = resolve('docs', 'release-evidence', 'v0.1.0-alpha.7.json');

function evidenceIndex(): any {
  return JSON.parse(readFileSync(evidencePath, 'utf8'));
}

describe('historical release evidence', () => {
  it('[REL-003] validates alpha.7 as historical evidence without claiming the current checkout', () => {
    const index = evidenceIndex();
    expect(() => assertReleaseEvidenceIndex(index)).not.toThrow();
    expect(index.validatesCurrentCheckout).toBe(false);
    expect(index.releaseSource.commit).toBe('b77535f17483039380ef2415a182324c9d159e5e');
    expect(index.documentationReceipt.commit).toBe('fb291abd401ec1e06bbc6494cc60d145d28ac024');
    expect(index.workflowRuns).toHaveLength(3);
    expect(index.workflowRuns[0].eventHeadCommit).toBe('16ff2b49af89c8a6bec3e2e279041dc7b98cfce0');
    expect(index.workflowRuns[0].artifactHandoffCommit).toBe('b160047b552a3188f83389d317773779cf39662e');
    expect(index.publication.assetCount).toBe(11);
    expect(index.qualification.productionReady).toBe(false);
  });

  it('rejects current-checkout, production-ready, malformed-digest, and handoff claims', () => {
    const current = evidenceIndex();
    current.validatesCurrentCheckout = true;
    expect(() => assertReleaseEvidenceIndex(current)).toThrow('deny current-checkout validation');

    const qualified = evidenceIndex();
    qualified.qualification.productionReady = true;
    expect(() => assertReleaseEvidenceIndex(qualified)).toThrow('cannot claim production readiness');

    const digest = evidenceIndex();
    digest.publication.assets[0].digest = 'not-a-digest';
    expect(() => assertReleaseEvidenceIndex(digest)).toThrow('invalid artifact digest');

    const handoff = evidenceIndex();
    handoff.workflowRuns[0].artifactHandoffCommit = 'a'.repeat(40);
    expect(() => assertReleaseEvidenceIndex(handoff)).toThrow('not keyed to its exact handoff commit');
  });

  it('[REL-004] rejects circular digest claims inside immutable release evidence', () => {
    const circular = evidenceIndex();
    circular.claimsInputSha256 = 'a'.repeat(64);
    expect(() => assertReleaseEvidenceIndex(circular)).toThrow(/circular digest claim/i);
  });

  it('[REL-006] binds the later docs receipt to the immutable release tag, trees, and single-change index', () => {
    const index = evidenceIndex();
    expect(() => assertReleaseEvidenceGitBinding(index, {
      root: process.cwd(),
      indexPath: evidencePath
    })).not.toThrow();

    const moved = evidenceIndex();
    moved.releaseSource.commit = 'a'.repeat(40);
    moved.publication.targetCommitish = moved.releaseSource.commit;
    expect(() => assertReleaseEvidenceGitBinding(moved, {
      root: process.cwd(),
      indexPath: evidencePath
    })).toThrow(/release tag no longer resolves/i);

    const cloneRoot = mkdtempSync(join(tmpdir(), 'videofactory-release-evidence-'));
    try {
      const clone = spawnSync('git', ['clone', '--quiet', '--shared', process.cwd(), cloneRoot], {
        encoding: 'utf8'
      });
      expect(clone.status, clone.stderr).toBe(0);
      const cloneIndexPath = resolve(cloneRoot, 'docs', 'release-evidence', 'v0.1.0-alpha.7.json');
      const immutable = JSON.parse(readFileSync(cloneIndexPath, 'utf8'));
      const changes: Array<[string, (value: any) => void]> = [
        ['workflow timing', value => {
          value.workflowRuns[0].startedAt = '2026-08-24T19:38:20Z';
        }],
        ['asset digest', value => {
          value.publication.assets[0].digest = `sha256:${'a'.repeat(64)}`;
        }],
        ['prerelease state', value => {
          value.qualification.prerelease = false;
          value.publication.prerelease = false;
        }]
      ];
      for (const [name, change] of changes) {
        const changed = structuredClone(immutable);
        change(changed);
        writeFileSync(cloneIndexPath, `${JSON.stringify(changed, null, 2)}\n`);
        expect(() => assertReleaseEvidenceGitBinding(changed, {
          root: cloneRoot,
          indexPath: cloneIndexPath
        }), name).toThrow(/changed after its immutable index commit/i);
      }
    } finally {
      rmSync(cloneRoot, { recursive: true, force: true });
    }
  });
});
