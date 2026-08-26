import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertReleaseEvidenceGitBinding,
  assertReleaseEvidenceIndex
} from './release-evidence.mjs';
import {
  assertReleaseClaimDigestCoverage,
  assertReleaseClaims,
  loadReleaseClaimDocuments
} from './release-claims.mjs';

const root = process.cwd();
const evidenceDirectory = resolve(root, 'docs', 'release-evidence');
const files = readdirSync(evidenceDirectory)
  .filter(name => name.endsWith('.json'))
  .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);

if (files.length === 0) throw new Error('No historical release-evidence indexes were found.');
const indexes = [];
for (const name of files) {
  const indexPath = resolve(evidenceDirectory, name);
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  assertReleaseEvidenceIndex(index, `Historical release evidence ${name}`);
  assertReleaseEvidenceGitBinding(
    index,
    { root, indexPath },
    `Historical release evidence ${name}`
  );
  indexes.push({ path: `docs/release-evidence/${name}`, index });
}
const documents = loadReleaseClaimDocuments(root);
assertReleaseClaims({ indexes, documents });
assertReleaseClaimDigestCoverage(root, indexes);
console.log(
  `Validated ${files.length} immutable historical release-evidence index${files.length === 1 ? '' : 'es'} `
  + `and ${Object.keys(documents).length} machine-checkable claim documents.`
);
