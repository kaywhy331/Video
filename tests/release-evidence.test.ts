import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertReleaseEvidenceIndex } from '../scripts/release-evidence.mjs';

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
});
