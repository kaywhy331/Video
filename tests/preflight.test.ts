import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = process.cwd();
const preflightScript = resolve(repositoryRoot, 'scripts', 'preflight.mjs');
const roots: string[] = [];

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'videofactory-preflight-'));
  roots.push(root);
  cpSync(resolve(repositoryRoot, 'package.json'), resolve(root, 'package.json'));
  cpSync(resolve(repositoryRoot, 'electron.vite.config.mjs'), resolve(root, 'electron.vite.config.mjs'));
  cpSync(resolve(repositoryRoot, 'resources'), resolve(root, 'resources'), { recursive: true });
  cpSync(resolve(repositoryRoot, 'src', 'main', 'database'), resolve(root, 'src', 'main', 'database'), { recursive: true });
  mkdirSync(resolve(root, 'validation'), { recursive: true });
  cpSync(
    resolve(repositoryRoot, 'validation', 'acceptance-map.json'),
    resolve(root, 'validation', 'acceptance-map.json')
  );
  return root;
}

function runPreflight(root: string) {
  return spawnSync(process.execPath, [preflightScript, '--before-install'], {
    cwd: root,
    encoding: 'utf8'
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('release preflight', () => {
  it('accepts a complete, contiguous source and packaged migration inventory', () => {
    const result = runPreflight(fixtureRoot());
    expect(result.stderr).not.toContain('PRECHECK FAILED');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Preflight passed');
  });

  it('rejects a package that omits the latest source migration', () => {
    const root = fixtureRoot();
    rmSync(resolve(root, 'resources', '022_media_tool_trust.sql'));
    const result = runPreflight(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Source and packaged SQLite migration inventories differ');
    expect(result.stderr).toContain('packaged latest: 021_state_safe_job_retry.sql');
  });

  it('rejects matching inventories with a missing intermediate migration', () => {
    const root = fixtureRoot();
    rmSync(resolve(root, 'src', 'main', 'database', '010_scheduler_analytics.sql'));
    rmSync(resolve(root, 'resources', '010_scheduler_analytics.sql'));
    const result = runPreflight(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('source SQLite migration inventory is not contiguous from 001');
    expect(result.stderr).toContain('packaged SQLite migration inventory is not contiguous from 001');
  });
});
