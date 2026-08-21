import { mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const resultsDirectory = resolve(process.cwd(), 'validation', 'results');
mkdirSync(resultsDirectory, { recursive: true });
rmSync(resolve(resultsDirectory, 'vitest.json'), { force: true });

const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const result = spawnSync(command, [
  'vitest',
  'run',
  '--reporter=default',
  '--reporter=json',
  `--outputFile.json=${resolve(resultsDirectory, 'vitest.json')}`
], { stdio: 'inherit' });

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
