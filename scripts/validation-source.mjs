import { spawnSync } from 'node:child_process';

export const VALIDATION_QUALIFICATIONS = Object.freeze(['development', 'release']);

export function parseValidationQualification(args = process.argv.slice(2)) {
  const inline = args.find(argument => argument.startsWith('--mode='));
  const modeIndex = args.indexOf('--mode');
  const qualification = inline
    ? inline.slice('--mode='.length)
    : modeIndex >= 0
      ? args[modeIndex + 1]
      : 'development';

  if (!VALIDATION_QUALIFICATIONS.includes(qualification)) {
    throw new Error(
      `Validation mode must be one of: ${VALIDATION_QUALIFICATIONS.join(', ')}.`
    );
  }
  return qualification;
}

export function captureValidationSource(root = process.cwd(), environment = process.env) {
  const commit = gitOutput(root, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const tree = gitOutput(root, ['rev-parse', '--verify', 'HEAD^{tree}']);
  const branch = gitOutput(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], true);
  const remote = gitOutput(root, ['config', '--get', 'remote.origin.url'], true);
  const dirty = gitOutput(root, ['status', '--porcelain=v1', '--untracked-files=all']).length > 0;
  const workflowCommit = environment.GITHUB_SHA?.trim() || null;

  return {
    commit,
    tree,
    ref: environment.GITHUB_REF?.trim() || branch || 'HEAD',
    repository: environment.GITHUB_REPOSITORY?.trim() || remote || 'local',
    workflowCommit,
    runId: environment.GITHUB_RUN_ID?.trim() || null,
    runAttempt: environment.GITHUB_RUN_ATTEMPT?.trim() || null,
    dirty
  };
}

export function assertValidationSource(source, qualification, label = 'Validation source') {
  if (!VALIDATION_QUALIFICATIONS.includes(qualification)) {
    throw new Error(`${label} has an unknown qualification: ${String(qualification)}.`);
  }
  if (!isGitObjectId(source?.commit)) {
    throw new Error(`${label} does not contain an exact 40-character HEAD commit.`);
  }
  if (!isGitObjectId(source?.tree)) {
    throw new Error(`${label} does not contain an exact 40-character tree hash.`);
  }
  if (typeof source?.ref !== 'string' || source.ref.length === 0) {
    throw new Error(`${label} does not contain a source ref.`);
  }
  if (typeof source?.repository !== 'string' || source.repository.length === 0) {
    throw new Error(`${label} does not contain a repository identity.`);
  }
  if (typeof source?.dirty !== 'boolean') {
    throw new Error(`${label} does not contain an explicit dirty state.`);
  }
  if (source.workflowCommit !== null && source.workflowCommit !== undefined) {
    if (!isGitObjectId(source.workflowCommit)) {
      throw new Error(`${label} contains an invalid workflow source commit.`);
    }
    if (source.workflowCommit !== source.commit) {
      throw new Error(`${label} HEAD does not match the workflow source commit.`);
    }
  }
  if (qualification === 'release' && source.dirty) {
    throw new Error('Release validation requires a clean source worktree and index.');
  }
  return source;
}

export function admitValidationSource({
  root = process.cwd(),
  qualification = 'development',
  environment = process.env
} = {}) {
  const source = captureValidationSource(root, environment);
  assertValidationSource(source, qualification, 'Admitted validation source');
  return {
    admittedAt: new Date().toISOString(),
    qualification,
    source
  };
}

export function assertValidationSourceStable(admission, {
  root = process.cwd(),
  environment = process.env
} = {}) {
  assertValidationSource(
    admission?.source,
    admission?.qualification,
    'Admitted validation source'
  );
  const current = captureValidationSource(root, environment);
  assertValidationSource(current, admission.qualification, 'Completed validation source');
  if (current.commit !== admission.source.commit) {
    throw new Error('Validation HEAD changed after source admission.');
  }
  if (current.tree !== admission.source.tree) {
    throw new Error('Validation source tree changed after source admission.');
  }
  return current;
}

function isGitObjectId(value) {
  return /^[a-f0-9]{40}$/i.test(String(value ?? ''));
}

function gitOutput(root, args, optional = false) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status === 0) return result.stdout.trim();
  if (optional) return '';
  const detail = result.stderr.trim() || result.error?.message || `git exited with ${result.status}`;
  throw new Error(`Could not capture validation source identity: ${detail}`);
}
