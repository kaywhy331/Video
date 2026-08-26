import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

export function assertReleaseEvidenceIndex(index, label = 'Release evidence index') {
  if (!index || typeof index !== 'object' || Array.isArray(index)) {
    throw new Error(`${label} is not a JSON object.`);
  }
  if (index.schemaVersion !== 1 || index.evidenceKind !== 'historical_release') {
    throw new Error(`${label} has an unsupported schema or evidence kind.`);
  }
  if (index.validatesCurrentCheckout !== false) {
    throw new Error(`${label} must explicitly deny current-checkout validation.`);
  }
  if (typeof index.repository !== 'string' || !/^[^/]+\/[^/]+$/.test(index.repository)) {
    throw new Error(`${label} has an invalid repository identity.`);
  }

  const releaseSource = index.releaseSource;
  assertGitObjectId(releaseSource?.commit, `${label} release commit`);
  assertGitObjectId(releaseSource?.tree, `${label} release tree`);
  assertGitObjectId(releaseSource?.candidateCommit, `${label} candidate commit`);
  assertGitObjectId(releaseSource?.candidateTree, `${label} candidate tree`);
  if (typeof releaseSource?.tag !== 'string' || !releaseSource.tag.startsWith('v')) {
    throw new Error(`${label} has an invalid release tag.`);
  }

  const documentation = index.documentationReceipt;
  assertGitObjectId(documentation?.commit, `${label} documentation receipt commit`);
  assertGitObjectId(documentation?.tree, `${label} documentation receipt tree`);
  assertTimestamp(documentation?.recordedAt, `${label} documentation receipt timestamp`);
  if (
    documentation?.relationship !== 'later_docs_commit_describing_immutable_release'
    || documentation.commit === releaseSource.commit
  ) {
    throw new Error(`${label} does not distinguish its later documentation receipt from the release commit.`);
  }

  const qualification = index.qualification;
  for (const name of [
    'prerelease',
    'productionReady',
    'authenticodeSigned',
    'hostedWindowsPackageSmokePassed',
    'cleanMachineQualified'
  ]) {
    if (typeof qualification?.[name] !== 'boolean') {
      throw new Error(`${label} qualification ${name} is not explicit.`);
    }
  }
  if (qualification.productionReady !== false) {
    throw new Error(`${label} cannot claim production readiness while external gates are pending.`);
  }
  if (!Number.isSafeInteger(qualification.externalQualificationGatesPending) || qualification.externalQualificationGatesPending < 0) {
    throw new Error(`${label} has an invalid external qualification-gate count.`);
  }

  if (!Array.isArray(index.workflowRuns) || index.workflowRuns.length === 0) {
    throw new Error(`${label} contains no workflow runs.`);
  }
  const runIds = new Set();
  for (const run of index.workflowRuns) {
    if (!Number.isSafeInteger(run?.id) || runIds.has(run.id)) {
      throw new Error(`${label} contains an invalid or duplicate workflow run ID.`);
    }
    runIds.add(run.id);
    assertGitObjectId(run.eventHeadCommit, `${label} workflow event HEAD`);
    assertGitObjectId(run.artifactHandoffCommit, `${label} workflow artifact handoff commit`);
    if (run.status !== 'completed' || run.conclusion !== 'success') {
      throw new Error(`${label} contains a workflow run that did not complete successfully.`);
    }
    assertTimestamp(run.startedAt, `${label} workflow start`);
    assertTimestamp(run.completedAt, `${label} workflow completion`);
    assertUrl(run.url, `${label} workflow URL`);
    assertNamedRecords(run.jobs, `${label} jobs`, record => {
      if (!Number.isSafeInteger(record.id) || record.conclusion !== 'success') {
        throw new Error(`${label} contains invalid workflow job evidence.`);
      }
      assertTimestamp(record.startedAt, `${label} job start`);
      assertTimestamp(record.completedAt, `${label} job completion`);
      assertUrl(record.url, `${label} job URL`);
    });
    assertNamedRecords(run.artifacts, `${label} workflow artifacts`, artifact => {
      assertArtifact(artifact, label);
      if (!artifact.name.includes(run.artifactHandoffCommit)) {
        throw new Error(`${label} workflow artifact is not keyed to its exact handoff commit.`);
      }
      assertTimestamp(artifact.createdAt, `${label} workflow artifact creation`);
      assertTimestamp(artifact.expiresAt, `${label} workflow artifact expiration`);
    });
  }

  const publication = index.publication;
  if (
    !Number.isSafeInteger(publication?.releaseId)
    || publication.tag !== releaseSource.tag
    || publication.targetCommitish !== releaseSource.commit
    || publication.prerelease !== qualification.prerelease
    || publication.draft !== false
  ) {
    throw new Error(`${label} publication metadata does not match the release source and qualification.`);
  }
  assertUrl(publication.url, `${label} publication URL`);
  assertTimestamp(publication.createdAt, `${label} publication creation`);
  assertTimestamp(publication.publishedAt, `${label} publication timestamp`);
  if (!Array.isArray(publication.assets) || publication.assetCount !== publication.assets.length) {
    throw new Error(`${label} publication asset count is stale.`);
  }
  assertNamedRecords(publication.assets, `${label} publication assets`, asset => {
    assertArtifact(asset, label);
    if (!Number.isSafeInteger(asset.id)) throw new Error(`${label} contains an invalid release asset ID.`);
    assertUrl(asset.url, `${label} release asset URL`);
  });

  const serialized = JSON.stringify(index);
  if (/runtimeInputSha256|claimsInputSha256/.test(serialized)) {
    throw new Error(`${label} creates a circular digest claim.`);
  }
  return index;
}

export function assertReleaseEvidenceGitBinding(
  index,
  { root = process.cwd(), indexPath },
  label = 'Release evidence index'
) {
  assertReleaseEvidenceIndex(index, label);
  if (typeof indexPath !== 'string' || indexPath.length === 0) {
    throw new Error(`${label} has no repository-relative index path.`);
  }
  const absoluteIndexPath = resolve(root, indexPath);
  const normalizedPath = relative(root, absoluteIndexPath).replaceAll('\\', '/');
  if (!normalizedPath || normalizedPath.startsWith('../')) {
    throw new Error(`${label} path is outside the repository.`);
  }

  const releaseCommit = git(root, ['rev-parse', '--verify', `refs/tags/${index.releaseSource.tag}^{commit}`], label);
  if (releaseCommit !== index.releaseSource.commit) {
    throw new Error(`${label} release tag no longer resolves to its recorded immutable commit.`);
  }
  assertGitTree(root, index.releaseSource.commit, index.releaseSource.tree, `${label} release source`);
  assertGitTree(root, index.releaseSource.candidateCommit, index.releaseSource.candidateTree, `${label} candidate source`);
  assertGitTree(root, index.documentationReceipt.commit, index.documentationReceipt.tree, `${label} documentation receipt`);
  assertAncestor(root, index.releaseSource.candidateCommit, index.releaseSource.commit, `${label} candidate is not in the release history.`);
  assertAncestor(root, index.releaseSource.commit, index.documentationReceipt.commit, `${label} documentation receipt does not descend from the release.`);

  const history = git(root, ['log', '--follow', '--format=%H', '--', normalizedPath], label)
    .split(/\r?\n/)
    .filter(Boolean);
  if (history.length !== 1) {
    throw new Error(`${label} is not immutable: its tracked file has ${history.length} content-changing commits.`);
  }
  const indexCommit = history[0];
  assertAncestor(root, index.documentationReceipt.commit, indexCommit, `${label} was recorded before its documentation receipt.`);
  assertAncestor(root, indexCommit, 'HEAD', `${label} introduction commit is not in the current checkout history.`);
  const introduced = git(root, ['show', `${indexCommit}:${normalizedPath}`], label, false);
  const current = readFileSync(absoluteIndexPath, 'utf8').trimEnd();
  if (introduced.trimEnd() !== current) {
    throw new Error(`${label} changed after its immutable index commit.`);
  }
  return index;
}

function assertGitTree(root, commit, expectedTree, label) {
  const actual = git(root, ['rev-parse', '--verify', `${commit}^{tree}`], label);
  if (actual !== expectedTree) throw new Error(`${label} tree does not match its recorded Git tree.`);
}

function assertAncestor(root, ancestor, descendant, message) {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
    cwd: root,
    encoding: 'utf8'
  });
  if (result.status !== 0) throw new Error(message);
}

function git(root, args, label, trim = true) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(`${label} Git binding failed${detail ? `: ${detail}` : '.'}`);
  }
  return trim ? result.stdout.trim() : result.stdout;
}

function assertNamedRecords(records, label, validate) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error(`${label} are missing.`);
  }
  const names = new Set();
  for (const record of records) {
    if (!record || typeof record.name !== 'string' || record.name.length === 0 || names.has(record.name)) {
      throw new Error(`${label} contain an invalid or duplicate name.`);
    }
    names.add(record.name);
    validate(record);
  }
}

function assertArtifact(artifact, label) {
  if (!Number.isSafeInteger(artifact?.sizeBytes) || artifact.sizeBytes < 0) {
    throw new Error(`${label} contains an invalid artifact size.`);
  }
  if (!/^sha256:[a-f0-9]{64}$/i.test(String(artifact?.digest ?? ''))) {
    throw new Error(`${label} contains an invalid artifact digest.`);
  }
}

function assertGitObjectId(value, label) {
  if (!/^[a-f0-9]{40}$/i.test(String(value ?? ''))) {
    throw new Error(`${label} is not an exact 40-character Git object ID.`);
  }
}

function assertTimestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} is invalid.`);
  }
}

function assertUrl(value, label) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') throw new Error('not HTTPS');
  } catch {
    throw new Error(`${label} is invalid.`);
  }
}
