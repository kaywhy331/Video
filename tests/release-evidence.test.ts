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
const alpha8EvidencePath = resolve('docs', 'release-evidence', 'v0.1.0-alpha.8.json');
const alpha9EvidencePath = resolve('docs', 'release-evidence', 'v0.1.0-alpha.9.json');

function evidenceIndex(path = evidencePath): any {
  return JSON.parse(readFileSync(path, 'utf8'));
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

  it('[REL-003] validates alpha.8 publication and hosted-package qualification facts', () => {
    const index = evidenceIndex(alpha8EvidencePath);
    expect(() => assertReleaseEvidenceIndex(index)).not.toThrow();
    expect(index.validatesCurrentCheckout).toBe(false);
    expect(index.releaseSource.commit).toBe('583c165fe822717fb8a59a68c8115a360ab81de9');
    expect(index.documentationReceipt.commit).toBe('abbe57b2f90e8b79c3d3959605fdcb282012885b');
    expect(index.workflowRuns).toHaveLength(3);
    expect(index.workflowRuns[0].eventHeadCommit).toBe('1faac55fe08a7e05128747b42522adbc646bd67b');
    expect(index.workflowRuns[0].artifactHandoffCommit).toBe('b36773974b8977d814c65d757b57f36580657496');
    expect(index.releaseSource.candidateRelationship).toBe('equivalent_tree_squash_candidate');
    expect(index.publication.assetCount).toBe(15);
    expect(index.qualification.externalQualificationGatesPending).toBe(13);
    expect(index.qualification.productionReady).toBe(false);
  });

  it('[REL-003] validates alpha.9 publication and hosted-package qualification facts', () => {
    const index = evidenceIndex(alpha9EvidencePath);
    expect(() => assertReleaseEvidenceIndex(index)).not.toThrow();
    expect(index.validatesCurrentCheckout).toBe(false);
    expect(index.releaseSource.commit).toBe('af7c0ec613478185a2d3ade85382bdc2a22f8c91');
    expect(index.documentationReceipt.commit).toBe('d858b2339238115c49c1af97d3bca5e3a86541df');
    expect(index.workflowRuns).toHaveLength(3);
    expect(index.workflowRuns[0].eventHeadCommit).toBe('0fdd1fd6e2369b6fca0da30c870e059ac671b517');
    expect(index.workflowRuns[0].artifactHandoffCommit).toBe('2642d7be1b045339cf9cb0cc4d026931188f68a0');
    expect(index.releaseSource.candidateRelationship).toBe('equivalent_tree_squash_candidate');
    expect(index.publication.assetCount).toBe(15);
    expect(index.qualification.externalQualificationGatesPending).toBe(13);
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

    const squashTree = evidenceIndex(alpha8EvidencePath);
    squashTree.releaseSource.candidateTree = 'a'.repeat(40);
    expect(() => assertReleaseEvidenceIndex(squashTree)).toThrow('does not record the exact release tree');

    const unboundCandidate = evidenceIndex(alpha8EvidencePath);
    unboundCandidate.workflowRuns[0].eventHeadCommit = 'a'.repeat(40);
    expect(() => assertReleaseEvidenceIndex(unboundCandidate)).toThrow('not bound to exactly one successful release pull-request run');
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

    const alpha8 = evidenceIndex(alpha8EvidencePath);
    expect(() => assertReleaseEvidenceGitBinding(alpha8, {
      root: process.cwd(),
      indexPath: alpha8EvidencePath
    })).not.toThrow();

    const alpha9 = evidenceIndex(alpha9EvidencePath);
    expect(() => assertReleaseEvidenceGitBinding(alpha9, {
      root: process.cwd(),
      indexPath: alpha9EvidencePath
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
