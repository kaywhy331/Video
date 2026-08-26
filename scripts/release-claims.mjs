import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  RELEASE_CLAIM_DOCUMENTS,
  claimsInputDigest
} from './validation-input.mjs';
import { assertReleaseEvidenceIndex } from './release-evidence.mjs';

export const RELEASE_EVIDENCE_README = 'docs/release-evidence/README.md';

export function loadReleaseClaimDocuments(root = process.cwd()) {
  const documents = {};
  for (const path of [...RELEASE_CLAIM_DOCUMENTS, RELEASE_EVIDENCE_README]) {
    const absolute = resolve(root, path);
    if (!existsSync(absolute)) throw new Error(`Release claim document is missing: ${path}.`);
    documents[path] = readFileSync(absolute, 'utf8');
  }
  return documents;
}

export function assertReleaseClaims(
  { indexes, documents },
  label = 'Release claims'
) {
  if (!Array.isArray(indexes) || indexes.length === 0) {
    throw new Error(`${label} have no historical release evidence.`);
  }
  if (!documents || typeof documents !== 'object' || Array.isArray(documents)) {
    throw new Error(`${label} documents are missing.`);
  }

  const byTag = new Map();
  const byReleaseUrl = new Map();
  const byEvidencePath = new Map();
  const byRunId = new Map();
  const commits = new Set();
  const observedIndexes = new Set();
  for (const entry of indexes) {
    const index = assertReleaseEvidenceIndex(entry?.index, `${label} evidence ${entry?.path ?? 'unknown'}`);
    if (typeof entry?.path !== 'string' || !entry.path.endsWith('.json')) {
      throw new Error(`${label} contain an invalid evidence-index path.`);
    }
    addUnique(byTag, index.releaseSource.tag, entry, `${label} release tag`);
    addUnique(byReleaseUrl, index.publication.url, entry, `${label} publication URL`);
    addUnique(byEvidencePath, entry.path, entry, `${label} evidence path`);
    for (const run of index.workflowRuns) addUnique(byRunId, String(run.id), entry, `${label} workflow run`);
    for (const value of [
      index.releaseSource.commit,
      index.releaseSource.candidateCommit,
      index.documentationReceipt.commit,
      ...index.workflowRuns.flatMap(run => [run.eventHeadCommit, run.artifactHandoffCommit])
    ]) commits.add(value);
  }

  const observed = {
    tags: 0,
    commits: 0,
    runs: 0,
    assetCounts: 0,
    signatureStates: 0,
    readinessStates: 0,
    gateCounts: 0,
    laterReceipt: false,
    immutableTag: false
  };

  for (const [path, value] of Object.entries(documents)) {
    if (typeof value !== 'string') throw new Error(`${label} document ${path} is not text.`);
    const scopes = new Set();

    for (const match of value.matchAll(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases\/tag\/[^)\s]+/g)) {
      const entry = byReleaseUrl.get(match[0]);
      if (!entry) throw new Error(`${path} claims an unknown release URL or tag: ${match[0]}.`);
      scopes.add(entry);
      observedIndexes.add(entry);
      observed.tags += 1;
    }
    for (const match of value.matchAll(/\[(v\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?)\]\(/g)) {
      const entry = byTag.get(match[1]);
      if (!entry) throw new Error(`${path} claims an unindexed release tag: ${match[1]}.`);
      scopes.add(entry);
      observedIndexes.add(entry);
      observed.tags += 1;
    }
    for (const match of value.matchAll(/`(v\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?)`/g)) {
      const entry = byTag.get(match[1]);
      if (!entry) throw new Error(`${path} claims an unindexed release tag: ${match[1]}.`);
      scopes.add(entry);
      observedIndexes.add(entry);
      observed.tags += 1;
    }
    for (const match of value.matchAll(/release-evidence\/(v[^)\s]+\.json)/g)) {
      const evidencePath = `docs/release-evidence/${match[1]}`;
      const entry = byEvidencePath.get(evidencePath);
      if (!entry) throw new Error(`${path} cites an unknown release-evidence index: ${evidencePath}.`);
      scopes.add(entry);
      observedIndexes.add(entry);
    }
    for (const match of value.matchAll(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/(\d+)/g)) {
      const entry = byRunId.get(match[1]);
      if (!entry || entry.index.workflowRuns.every(run => run.url !== match[0])) {
        throw new Error(`${path} claims an unknown workflow run ID: ${match[1]}.`);
      }
      scopes.add(entry);
      observedIndexes.add(entry);
      observed.runs += 1;
    }
    for (const match of value.matchAll(/`([a-f0-9]{7,40})`/gi)) {
      const matches = [...commits].filter(commit => commit.startsWith(match[1].toLowerCase()));
      if (matches.length !== 1) throw new Error(`${path} claims an unknown or ambiguous release commit: ${match[1]}.`);
      observed.commits += 1;
      const entry = indexes.find(candidate => releaseCommits(candidate.index).has(matches[0]));
      if (entry) {
        scopes.add(entry);
        observedIndexes.add(entry);
      }
    }

    const scoped = scopes.size ? [...scopes] : indexes;
    const assetClaims = [];
    for (const pattern of [
      /\b(\d+)\s+(?:published|uploaded)\s+assets\b/gi,
      /\b(\d+)-file\s+prerelease\b/gi
    ]) {
      assetClaims.push(...value.matchAll(pattern));
    }
    if (assetClaims.length > 0) {
      const expectedAssetCount = uniqueExpected(scoped, entry => entry.index.publication.assetCount, `${path} asset count`);
      for (const match of assetClaims) {
        if (Number(match[1]) !== expectedAssetCount) {
          throw new Error(`${path} claims stale release asset count ${match[1]}; evidence records ${expectedAssetCount}.`);
        }
        observed.assetCounts += 1;
      }
    }

    const unsigned = [...value.matchAll(/\bunsigned\b/gi)].length;
    const signed = [...value.matchAll(/\bsigned\b/gi)].length;
    if (unsigned + signed > 0) {
      const expectedSigned = uniqueExpected(scoped, entry => entry.index.qualification.authenticodeSigned, `${path} signing state`);
      if (unsigned && expectedSigned) throw new Error(`${path} claims an unsigned release, but evidence records Authenticode signing.`);
      if (signed && !expectedSigned) throw new Error(`${path} claims a signed release, but evidence records it as unsigned.`);
      observed.signatureStates += unsigned + signed;
    }

    const normalized = value.replaceAll('`', '');
    const readinessClaims = [];
    for (const match of normalized.matchAll(/production_ready[^.\n]{0,100}\b(true|false)\b/gi)) {
      const claimed = match[1].toLowerCase() === 'true';
      const sentenceStart = Math.max(normalized.lastIndexOf('.', match.index), normalized.lastIndexOf('\n', match.index));
      const context = normalized.slice(sentenceStart + 1, (match.index ?? 0) + match[0].length);
      const negated = /\b(?:cannot|can't|do not|does not|never|not)\b/i.test(context);
      if (!negated) readinessClaims.push(claimed);
    }
    if (readinessClaims.length > 0) {
      const expectedReady = uniqueExpected(scoped, entry => entry.index.qualification.productionReady, `${path} production readiness`);
      for (const claimed of readinessClaims) {
        if (claimed !== expectedReady) {
          throw new Error(`${path} production_ready claim conflicts with immutable release evidence.`);
        }
        observed.readinessStates += 1;
      }
    }

    const gateClaims = [];
    for (const pattern of [
      /\b(\d+)\s+remain(?:s)?(?:\s+explicitly)?\s+external(?:\s+qualification)?(?:\s+gates?)?\b/gi,
      /\bnone of the\s+(\d+)\s+external qualification gates\b/gi,
      /\b(\d+)\s+external pending\b/gi
    ]) {
      gateClaims.push(...value.matchAll(pattern));
    }
    if (gateClaims.length > 0) {
      const expectedGates = uniqueExpected(
        scoped,
        entry => entry.index.qualification.externalQualificationGatesPending,
        `${path} external qualification-gate count`
      );
      for (const match of gateClaims) {
        if (Number(match[1]) !== expectedGates) {
          throw new Error(`${path} claims ${match[1]} external gates; evidence records ${expectedGates}.`);
        }
        observed.gateCounts += 1;
      }
    }

    observed.laterReceipt ||= /later (?:documentation|docs) (?:receipt|commit)/i.test(value);
    observed.immutableTag ||= /does not (?:move|replace|rebuild)[^.\n]{0,80}(?:release )?tag/i.test(value);
  }

  for (const [name, count] of Object.entries({
    tags: observed.tags,
    commits: observed.commits,
    runs: observed.runs,
    assetCounts: observed.assetCounts,
    signatureStates: observed.signatureStates,
    readinessStates: observed.readinessStates,
    gateCounts: observed.gateCounts
  })) {
    if (count === 0) throw new Error(`${label} do not project any ${name} from historical evidence.`);
  }
  for (const entry of indexes) {
    if (!observedIndexes.has(entry)) {
      throw new Error(`${label} do not project historical evidence index ${entry.path}.`);
    }
  }
  if (!observed.laterReceipt || !observed.immutableTag) {
    throw new Error(`${label} do not distinguish the later documentation receipt from the immutable release tag.`);
  }
  return observed;
}

export function assertReleaseClaimDigestCoverage(root = process.cwd(), indexes) {
  const manifest = claimsInputDigest(root);
  const covered = new Set(manifest.files.map(file => file.path));
  for (const path of [...RELEASE_CLAIM_DOCUMENTS, RELEASE_EVIDENCE_README, ...indexes.map(entry => entry.path)]) {
    if (!covered.has(path)) throw new Error(`Claims digest does not cover required release claim input: ${path}.`);
  }
  return manifest;
}

function releaseCommits(index) {
  return new Set([
    index.releaseSource.commit,
    index.releaseSource.candidateCommit,
    index.documentationReceipt.commit,
    ...index.workflowRuns.flatMap(run => [run.eventHeadCommit, run.artifactHandoffCommit])
  ]);
}

function addUnique(map, key, value, label) {
  if (map.has(key)) throw new Error(`${label} is duplicated: ${key}.`);
  map.set(key, value);
}

function uniqueExpected(entries, project, label) {
  const values = [...new Set(entries.map(project))];
  if (values.length !== 1) throw new Error(`${label} is ambiguous across cited releases.`);
  return values[0];
}
