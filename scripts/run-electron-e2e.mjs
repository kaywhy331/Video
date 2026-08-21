import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

mkdirSync(resolve(process.cwd(), 'validation', 'results'), { recursive: true });
rmSync(resolve(process.cwd(), 'validation', 'results', 'playwright.json'), { force: true });

const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const args = ['playwright', 'test'];
const result = process.platform === 'linux'
  ? spawnSync('xvfb-run', ['-a', command, ...args], { stdio: 'inherit' })
  : spawnSync(command, args, { stdio: 'inherit' });

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
