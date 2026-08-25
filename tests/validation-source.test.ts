import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  admitValidationSource,
  assertValidationSourceStable,
  captureValidationSource
} from '../scripts/validation-source.mjs';

const repositoryRoot = process.cwd();
const validationScript = resolve(repositoryRoot, 'scripts', 'run-validation.mjs');
const roots: string[] = [];

function fixtureRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'videofactory-validation-source-'));
  roots.push(root);
  runGit(root, ['init', '--initial-branch=main']);
  runGit(root, ['config', 'user.email', 'validation@example.invalid']);
  runGit(root, ['config', 'user.name', 'Validation Fixture']);
  writeFileSync(resolve(root, '.gitignore'), '/VALIDATION_STATUS.json\n');
  writeFileSync(resolve(root, 'package.json'), '{"version":"1.0.0-test"}\n');
  runGit(root, ['add', '.gitignore', 'package.json']);
  runGit(root, ['commit', '-m', 'fixture']);
  return root;
}

function runGit(root: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function environmentWithoutGitHub(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of [
    'GITHUB_SHA',
    'GITHUB_REF',
    'GITHUB_REPOSITORY',
    'GITHUB_RUN_ID',
    'GITHUB_RUN_ATTEMPT'
  ]) {
    delete environment[name];
  }
  return environment;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('validation source admission', () => {
  it('[REL-001] rejects dirty release validation before touching generated receipts', () => {
    const root = fixtureRepository();
    writeFileSync(resolve(root, 'VALIDATION_STATUS.json'), 'sentinel\n');
    writeFileSync(resolve(root, 'dirty.txt'), 'dirty\n');

    const result = spawnSync(process.execPath, [validationScript, '--mode=release'], {
      cwd: root,
      env: environmentWithoutGitHub(),
      encoding: 'utf8'
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Release validation requires a clean source worktree and index.');
    expect(readFileSync(resolve(root, 'VALIDATION_STATUS.json'), 'utf8')).toBe('sentinel\n');
  });

  it('[REL-001] admits a clean exact HEAD and tree, including detached HEAD', () => {
    const root = fixtureRepository();
    const environment = {};
    const attached = admitValidationSource({ root, qualification: 'release', environment });
    expect(attached.source.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(attached.source.tree).toMatch(/^[a-f0-9]{40}$/);
    expect(attached.source.dirty).toBe(false);

    runGit(root, ['checkout', '--detach']);
    const detached = admitValidationSource({ root, qualification: 'release', environment });
    expect(detached.source.ref).toBe('HEAD');
    expect(detached.source.commit).toBe(attached.source.commit);
    expect(detached.source.tree).toBe(attached.source.tree);
  });

  it('[REL-002] rejects changed HEAD, dirty completion, and workflow SHA mismatch', () => {
    const root = fixtureRepository();
    const admission = admitValidationSource({ root, qualification: 'release', environment: {} });

    writeFileSync(resolve(root, 'second.txt'), 'second\n');
    runGit(root, ['add', 'second.txt']);
    runGit(root, ['commit', '-m', 'second']);
    expect(() => assertValidationSourceStable(admission, { root, environment: {} }))
      .toThrow('Validation HEAD changed after source admission.');

    const current = captureValidationSource(root, {});
    expect(() => admitValidationSource({
      root,
      qualification: 'release',
      environment: { GITHUB_SHA: 'a'.repeat(40) }
    })).toThrow('HEAD does not match the workflow source commit');

    const cleanAdmission = admitValidationSource({ root, qualification: 'release', environment: {} });
    writeFileSync(resolve(root, 'dirty-after-admission.txt'), 'dirty\n');
    expect(() => assertValidationSourceStable(cleanAdmission, { root, environment: {} }))
      .toThrow('Release validation requires a clean source worktree and index.');
    expect(current.commit).toBe(cleanAdmission.source.commit);
  });

  it('labels dirty development admission as non-release evidence', () => {
    const root = fixtureRepository();
    writeFileSync(resolve(root, 'development.txt'), 'dirty\n');
    const admission = admitValidationSource({ root, qualification: 'development', environment: {} });
    expect(admission.qualification).toBe('development');
    expect(admission.source.dirty).toBe(true);
  });
});
