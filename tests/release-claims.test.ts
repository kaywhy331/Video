import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertReleaseClaims,
  loadReleaseClaimDocuments
} from '../scripts/release-claims.mjs';

const evidencePaths = readdirSync(resolve('docs', 'release-evidence'))
  .filter(name => name.endsWith('.json'))
  .sort()
  .map(name => `docs/release-evidence/${name}`);

function fixture() {
  return {
    indexes: evidencePaths.map(path => ({
      path,
      index: JSON.parse(readFileSync(resolve(path), 'utf8'))
    })),
    documents: loadReleaseClaimDocuments()
  };
}

function changedDocument(path: string, before: string, after: string) {
  const value = fixture();
  const current = value.documents[path];
  if (current === undefined) throw new Error(`Missing release claim fixture: ${path}`);
  expect(current).toContain(before);
  value.documents[path] = current.replace(before, after);
  return value;
}

describe('machine-verifiable release claims', () => {
  it('[REL-005] rejects stale tag, commit, run, asset, signing, readiness, and gate claims', () => {
    expect(() => assertReleaseClaims(fixture())).not.toThrow();

    expect(() => assertReleaseClaims(changedDocument(
      'README.md',
      'https://github.com/kaywhy331/Video/releases/tag/v0.1.0-alpha.9',
      'https://github.com/kaywhy331/Video/releases/tag/v0.1.0-alpha.10'
    ))).toThrow(/unknown release URL or tag/i);

    expect(() => assertReleaseClaims(changedDocument(
      'VALIDATION_REPORT.md',
      'for `v0.1.0-alpha.7` at the same merge commit',
      'for `v0.1.0-alpha.10` at the same merge commit'
    ))).toThrow(/unindexed release tag/i);

    expect(() => assertReleaseClaims(changedDocument(
      'VALIDATION_REPORT.md',
      'b77535f17483039380ef2415a182324c9d159e5e',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    ))).toThrow(/unknown or ambiguous release commit/i);

    expect(() => assertReleaseClaims(changedDocument(
      'VALIDATION_REPORT.md',
      'actions/runs/32769307075',
      'actions/runs/99999999999'
    ))).toThrow(/unknown workflow run ID/i);

    expect(() => assertReleaseClaims(changedDocument(
      'VALIDATION_REPORT.md',
      'all 11 published assets',
      'all 12 published assets'
    ))).toThrow(/stale release asset count 12/i);

    expect(() => assertReleaseClaims(changedDocument(
      'README.md',
      'unsigned Windows prerelease',
      'signed Windows prerelease'
    ))).toThrow(/signed release.*unsigned/i);

    expect(() => assertReleaseClaims(changedDocument(
      'VALIDATION_REPORT.md',
      'production_ready: false',
      'production_ready: true'
    ))).toThrow(/production_ready claim conflicts/i);

    expect(() => assertReleaseClaims(changedDocument(
      'README.md',
      '13 remain external qualification gates',
      '12 remain external qualification gates'
    ))).toThrow(/12 external gates.*13/i);
  });

  it('[REL-006] requires a later documentation receipt that cannot imply a moved release tag', () => {
    const relationship = fixture();
    const relationshipIndex = relationship.indexes[0]!;
    relationshipIndex.index.documentationReceipt.commit =
      relationshipIndex.index.releaseSource.commit;
    expect(() => assertReleaseClaims(relationship)).toThrow(/later documentation receipt/i);

    const narrative = changedDocument(
      'docs/release-evidence/README.md',
      'does not move or rebuild the release tag',
      'may move or rebuild the release tag'
    );
    expect(() => assertReleaseClaims(narrative)).toThrow(/later documentation receipt.*immutable release tag/i);
  });

  it('[REL-005] keeps claim-free documents valid when later release indexes disagree', () => {
    const value = fixture();
    const later = structuredClone(value.indexes.at(-1)!);
    later.path = 'docs/release-evidence/v0.1.0-alpha.10.json';
    later.index.releaseSource.tag = 'v0.1.0-alpha.10';
    later.index.publication.tag = 'v0.1.0-alpha.10';
    later.index.publication.url = 'https://github.com/kaywhy331/Video/releases/tag/v0.1.0-alpha.10';
    later.index.publication.assetCount += 1;
    later.index.publication.assets.push({
      ...later.index.publication.assets[0],
      id: 999999999,
      name: 'future-release-receipt.json'
    });
    later.index.qualification.authenticodeSigned = true;
    later.index.qualification.externalQualificationGatesPending = 0;
    for (const [offset, run] of later.index.workflowRuns.entries()) {
      run.id = 999999990 + offset;
      run.url = `https://github.com/kaywhy331/Video/actions/runs/${run.id}`;
    }
    value.indexes.push(later);

    expect(() => assertReleaseClaims(value)).toThrow(/do not project historical evidence index.*alpha\.10/i);

    value.documents['FUTURE-RELEASE.md'] =
      'See the [future release evidence](docs/release-evidence/v0.1.0-alpha.10.json).';
    expect(() => assertReleaseClaims(value)).not.toThrow();
  });
});
