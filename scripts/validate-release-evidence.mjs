import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertReleaseEvidenceIndex } from './release-evidence.mjs';

const root = process.cwd();
const evidenceDirectory = resolve(root, 'docs', 'release-evidence');
const files = readdirSync(evidenceDirectory)
  .filter(name => name.endsWith('.json'))
  .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);

if (files.length === 0) throw new Error('No historical release-evidence indexes were found.');
for (const name of files) {
  const index = JSON.parse(readFileSync(resolve(evidenceDirectory, name), 'utf8'));
  assertReleaseEvidenceIndex(index, `Historical release evidence ${name}`);
}
console.log(`Validated ${files.length} historical release-evidence index${files.length === 1 ? '' : 'es'}.`);
