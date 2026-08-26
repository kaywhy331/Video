import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { validationInputDigests } from './validation-input.mjs';
import { admitExternalQualificationEvidence } from './external-qualification-evidence.mjs';
import {
  assertCompletedValidationPipeline,
  assertInputManifest,
  assertMatchingValidationEvidence,
  assertValidationEvidenceDocument
} from './validation-evidence.mjs';
import { captureValidationSource } from './validation-source.mjs';

const root = process.cwd();
const acceptancePath = resolve(root, 'docs/prd/06-ACCEPTANCE-TESTS.md');
const mapPath = resolve(root, 'validation/acceptance-map.json');
const bindingsPath = resolve(root, 'validation/acceptance-bindings.json');
const resultsRoot = resolve(root, 'validation/results');
const vitestPath = resolve(resultsRoot, 'vitest.json');
const playwrightPath = resolve(resultsRoot, 'playwright.json');
const pipelinePath = resolve(resultsRoot, 'pipeline.json');
const runtimeInputPath = resolve(resultsRoot, 'runtime-input.json');
const claimsInputPath = resolve(resultsRoot, 'claims-input.json');
const receiptPath = resolve(root, 'VALIDATION_ACCEPTANCE_RECEIPT.json');
const statusPath = resolve(root, 'VALIDATION_STATUS.json');
const sbomPath = resolve(root, 'release', 'videofactory-sbom.cdx.json');
const recordValidated = process.argv.includes('--record-validated');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fail(messages) {
  for (const message of messages) console.error(`ACCEPTANCE TRACEABILITY FAILED: ${message}`);
  process.exit(1);
}

function normalizedFile(path) {
  return relative(root, resolve(path)).replaceAll('\\', '/');
}

function fileEvidence(path) {
  return {
    path: normalizedFile(path),
    sha256: sha256(readFileSync(path)),
    sizeBytes: statSync(path).size
  };
}

function writeJsonAtomic(path, value) {
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporaryPath, path);
}

const acceptanceText = readFileSync(acceptancePath, 'utf8');
const acceptanceMatches = [...acceptanceText.matchAll(/^### ([A-Z0-9]+-\d{3}) - (.+)$/gm)];
const acceptance = acceptanceMatches.map(match => ({ id: match[1], title: match[2].trim() }));
const mapText = readFileSync(mapPath, 'utf8');
const map = JSON.parse(mapText);
const bindingsText = readFileSync(bindingsPath, 'utf8');
const bindingsDocument = JSON.parse(bindingsText);
const errors = [];

if (!map.fixtureVersion || typeof map.fixtureVersion !== 'string') {
  errors.push('fixtureVersion must be a non-empty string.');
}
if (bindingsDocument.version !== 1 || !Array.isArray(bindingsDocument.bindings)) {
  errors.push('acceptance-bindings.json must contain version 1 and a bindings array.');
}

const documentIds = new Set();
for (const entry of acceptance) {
  if (documentIds.has(entry.id)) errors.push(`duplicate acceptance ID in PRD: ${entry.id}`);
  documentIds.add(entry.id);
}

const mapped = new Map();
for (const [classification, groups] of [['automated', map.automated], ['external', map.external]]) {
  if (!Array.isArray(groups)) {
    errors.push(`${classification} must be an array.`);
    continue;
  }
  for (const group of groups) {
    if (!Array.isArray(group.ids) || group.ids.length === 0) {
      errors.push(`${classification} coverage group has no IDs.`);
      continue;
    }
    if (!Array.isArray(group.evidence) || group.evidence.length === 0) {
      errors.push(`${classification} coverage group for ${group.ids.join(', ')} has no evidence.`);
    }
    if (classification === 'external' && (!group.reason || typeof group.reason !== 'string')) {
      errors.push(`external coverage group for ${group.ids.join(', ')} has no reason.`);
    }
    for (const evidence of group.evidence ?? []) {
      if (typeof evidence !== 'string' || !evidence.trim()) {
        errors.push(`invalid evidence reference in ${classification} group ${group.ids.join(', ')}.`);
      } else if (!existsSync(resolve(root, evidence))) {
        errors.push(`missing evidence path: ${evidence}`);
      }
    }
    for (const id of group.ids) {
      if (mapped.has(id)) errors.push(`acceptance ID mapped more than once: ${id}`);
      mapped.set(id, {
        classification,
        evidence: group.evidence ?? [],
        ...(classification === 'external' ? { reason: group.reason } : {})
      });
    }
  }
}

for (const { id } of acceptance) {
  if (!mapped.has(id)) errors.push(`acceptance ID has no mapping: ${id}`);
}
for (const id of mapped.keys()) {
  if (!documentIds.has(id)) errors.push(`mapping contains unknown acceptance ID: ${id}`);
}

const bindingsById = new Map();
const bindingKeys = new Set();
for (const [index, binding] of (bindingsDocument.bindings ?? []).entries()) {
  const label = `binding ${index + 1}`;
  if (!Array.isArray(binding.ids) || binding.ids.length === 0) {
    errors.push(`${label} has no acceptance IDs.`);
    continue;
  }
  if (!['vitest', 'playwright'].includes(binding.runner)) {
    errors.push(`${label} has unsupported runner ${String(binding.runner)}.`);
  }
  if (typeof binding.file !== 'string' || !binding.file.trim()) {
    errors.push(`${label} has no test file.`);
  } else if (!existsSync(resolve(root, binding.file))) {
    errors.push(`${label} references missing test file ${binding.file}.`);
  }
  if (typeof binding.title !== 'string' || !binding.title.trim()) {
    errors.push(`${label} has no exact assertion title.`);
  } else if (typeof binding.file === 'string' && existsSync(resolve(root, binding.file))) {
    const source = readFileSync(resolve(root, binding.file), 'utf8');
    if (!source.includes(binding.title)) {
      errors.push(`${label} assertion title is not present in ${binding.file}: ${binding.title}`);
    }
  }
  const key = `${binding.runner}|${binding.file}|${binding.title}|${[...binding.ids].sort().join(',')}`;
  if (bindingKeys.has(key)) errors.push(`${label} duplicates an earlier exact binding.`);
  bindingKeys.add(key);
  for (const id of binding.ids) {
    const coverage = mapped.get(id);
    if (!documentIds.has(id)) errors.push(`${label} contains unknown acceptance ID ${id}.`);
    else if (coverage?.classification !== 'automated') {
      errors.push(`${label} attaches an executable assertion to non-automated ID ${id}.`);
    }
    const values = bindingsById.get(id) ?? [];
    values.push(binding);
    bindingsById.set(id, values);
  }
}

for (const { id } of acceptance) {
  if (mapped.get(id)?.classification === 'automated' && !(bindingsById.get(id)?.length)) {
    errors.push(`automated acceptance ID has no exact assertion binding: ${id}`);
  }
}

const migrationVersions = readdirSync(resolve(root, 'src/main/database'))
  .map(name => /^(\d{3})_.+\.sql$/.exec(name))
  .filter(Boolean)
  .map(match => Number(match[1]));
const schemaVersion = Math.max(...migrationVersions);
if (!Number.isSafeInteger(schemaVersion)) errors.push('could not derive the database schema version.');

const packagedVersions = readdirSync(resolve(root, 'resources'))
  .map(name => /^(\d{3})_.+\.sql$/.exec(name))
  .filter(Boolean)
  .map(match => Number(match[1]));
if (Math.max(...packagedVersions) !== schemaVersion) {
  errors.push('source and packaged migration versions do not match.');
}

if (errors.length > 0) fail(errors);

const packageJson = readJson(resolve(root, 'package.json'));
const automatedCount = acceptance.filter(({ id }) => mapped.get(id).classification === 'automated').length;
const externalCount = acceptance.length - automatedCount;
const externalIds = acceptance
  .filter(({ id }) => mapped.get(id).classification === 'external')
  .map(({ id }) => id);

if (!recordValidated) {
  console.log(
    `Acceptance traceability passed: ${acceptance.length} IDs mapped `
    + `(${automatedCount} automated with exact bindings, ${externalCount} external).`
  );
  process.exit(0);
}

const reportErrors = [];
for (const path of [vitestPath, playwrightPath, pipelinePath, runtimeInputPath, claimsInputPath, sbomPath]) {
  if (!existsSync(path)) reportErrors.push(`required validation result is missing: ${normalizedFile(path)}`);
}
if (reportErrors.length > 0) fail(reportErrors);

let vitestReport;
let playwrightReport;
let pipeline;
let runtimeInputManifest;
let claimsInputManifest;
let externalAdmission;
try {
  vitestReport = readJson(vitestPath);
  playwrightReport = readJson(playwrightPath);
  pipeline = readJson(pipelinePath);
  runtimeInputManifest = readJson(runtimeInputPath);
  claimsInputManifest = readJson(claimsInputPath);
} catch (error) {
  fail([`validation result JSON could not be parsed: ${error instanceof Error ? error.message : String(error)}`]);
}

const currentInput = validationInputDigests(root);
try {
  assertValidationEvidenceDocument(pipeline, 'Validation pipeline');
  assertCompletedValidationPipeline(pipeline);
  assertInputManifest(runtimeInputManifest, 'runtime', pipeline, 'Runtime input manifest');
  assertInputManifest(claimsInputManifest, 'claims', pipeline, 'Claims input manifest');
  const currentSource = captureValidationSource(root);
  const currentEvidence = {
    qualification: pipeline.qualification,
    source: currentSource,
    runtimeInputSha256: currentInput.runtime.sha256,
    runtimeInputFileCount: currentInput.runtime.fileCount,
    claimsInputSha256: currentInput.claims.sha256,
    claimsInputFileCount: currentInput.claims.fileCount
  };
  assertValidationEvidenceDocument(currentEvidence, 'Current validation checkout');
  assertMatchingValidationEvidence(pipeline, currentEvidence, 'Validation pipeline', 'current checkout');
  if (JSON.stringify(runtimeInputManifest.files) !== JSON.stringify(currentInput.runtime.files)) {
    throw new Error('Runtime input manifest does not match the current checkout files.');
  }
  if (JSON.stringify(claimsInputManifest.files) !== JSON.stringify(currentInput.claims.files)) {
    throw new Error('Claims input manifest does not match the current checkout files.');
  }
  for (const [kind, path, manifest] of [
    ['runtime', runtimeInputPath, runtimeInputManifest],
    ['claims', claimsInputPath, claimsInputManifest]
  ]) {
    const recorded = pipeline.inputManifests?.[kind];
    const actual = fileEvidence(path);
    if (recorded?.sha256 !== actual.sha256 || recorded?.sizeBytes !== actual.sizeBytes) {
      throw new Error(`Validation pipeline ${kind} input-manifest evidence is stale.`);
    }
    if (manifest.qualification !== pipeline.qualification) {
      throw new Error(`Validation pipeline ${kind} input manifest has a different qualification.`);
    }
  }
  externalAdmission = admitExternalQualificationEvidence({
    root,
    source: pipeline.source,
    allowedIds: externalIds
  });
} catch (error) {
  reportErrors.push(error instanceof Error ? error.message : String(error));
}
if (vitestReport.success !== true) reportErrors.push('Vitest JSON report is not globally successful.');

const resultIndex = new Map();
for (const fileResult of vitestReport.testResults ?? []) {
  const file = normalizedFile(fileResult.name);
  for (const assertion of fileResult.assertionResults ?? []) {
    const key = `vitest|${file}|${assertion.title}`;
    const values = resultIndex.get(key) ?? [];
    values.push({
      runner: 'vitest',
      file,
      title: assertion.title,
      status: assertion.status,
      passed: assertion.status === 'passed'
    });
    resultIndex.set(key, values);
  }
}

const playwrightSpecs = [];
function collectPlaywright(suite) {
  for (const spec of suite.specs ?? []) {
    const attempts = (spec.tests ?? []).flatMap(test => test.results ?? []);
    const reportFile = spec.file ?? suite.file ?? '';
    const reportRoot = playwrightReport.config?.rootDir ?? root;
    playwrightSpecs.push({
      runner: 'playwright',
      file: normalizedFile(resolve(reportRoot, reportFile)),
      title: spec.title,
      status: spec.ok === true ? 'passed' : attempts.map(result => result.status).join(',') || 'failed',
      passed: spec.ok === true
    });
  }
  for (const child of suite.suites ?? []) collectPlaywright(child);
}
for (const suite of playwrightReport.suites ?? []) collectPlaywright(suite);
for (const spec of playwrightSpecs) {
  const key = `playwright|${spec.file}|${spec.title}`;
  const values = resultIndex.get(key) ?? [];
  values.push(spec);
  resultIndex.set(key, values);
}
if (!playwrightSpecs.length || playwrightSpecs.some(spec => !spec.passed)) {
  reportErrors.push('Playwright JSON report is empty or contains a failed specification.');
}

for (const binding of bindingsDocument.bindings) {
  const key = `${binding.runner}|${binding.file}|${binding.title}`;
  const matches = resultIndex.get(key) ?? [];
  if (!matches.length) {
    reportErrors.push(`exact assertion is absent from ${binding.runner} results: ${binding.file} :: ${binding.title}`);
  } else if (matches.some(match => !match.passed)) {
    reportErrors.push(`exact assertion did not pass: ${binding.file} :: ${binding.title}`);
  }
}
if (reportErrors.length > 0) fail(reportErrors);

const cases = acceptance.map(({ id, title }) => {
  const coverage = mapped.get(id);
  const caseBindings = bindingsById.get(id) ?? [];
  const externalEvidence = externalAdmission.qualifiedById[id];
  const assertions = caseBindings.map(binding => ({
    runner: binding.runner,
    file: binding.file,
    title: binding.title,
    status: 'passed'
  }));
  return {
    id,
    title,
    appVersion: packageJson.version,
    databaseSchemaVersion: schemaVersion,
    fixtureVersion: map.fixtureVersion,
    classification: coverage.classification,
    result: coverage.classification === 'automated'
      ? 'passed_local_validation'
      : externalEvidence
        ? 'passed_external_qualification'
        : 'external_pending',
    artifacts: [...new Set([
      ...coverage.evidence,
      ...caseBindings.map(binding => binding.file),
      ...(externalEvidence ? [externalAdmission.index.path, externalEvidence.evidence.path] : [])
    ])],
    ...(assertions.length ? { assertions } : {}),
    ...(externalEvidence ? {
      externalEvidence: {
        kind: externalEvidence.kind,
        index: externalAdmission.index,
        receipt: externalEvidence.evidence
      }
    } : {}),
    ...(coverage.reason && !externalEvidence ? { pendingReason: coverage.reason } : {})
  };
});

const generatedAt = new Date().toISOString();
const qualifiedExternal = externalAdmission.qualifiedIds.length;
const externalPending = externalCount - qualifiedExternal;
const productionQualified = externalPending === 0;
const externalQualificationEvidence = {
  index: externalAdmission.index,
  receipts: externalAdmission.receipts.map(item => ({
    kind: item.kind,
    evidence: item.evidence,
    qualifiedIds: item.qualifiedIds
  })),
  qualifiedIds: externalAdmission.qualifiedIds
};
const receipt = {
  generatedAt,
  admittedAt: pipeline.admittedAt,
  appVersion: packageJson.version,
  databaseSchemaVersion: schemaVersion,
  fixtureVersion: map.fixtureVersion,
  qualification: pipeline.qualification,
  runtimeInputSha256: currentInput.runtime.sha256,
  runtimeInputFileCount: currentInput.runtime.fileCount,
  claimsInputSha256: currentInput.claims.sha256,
  claimsInputFileCount: currentInput.claims.fileCount,
  inputManifests: pipeline.inputManifests,
  source: pipeline.source,
  environment: pipeline.environment,
  acceptancePlan: 'docs/prd/06-ACCEPTANCE-TESTS.md',
  acceptancePlanSha256: sha256(acceptanceText),
  acceptanceMap: 'validation/acceptance-map.json',
  acceptanceMapSha256: sha256(mapText),
  acceptanceBindings: 'validation/acceptance-bindings.json',
  acceptanceBindingsSha256: sha256(bindingsText),
  validationPipeline: 'validation/results/pipeline.json',
  validationCommands: [
    'npm run validate:release-evidence',
    'npm run typecheck',
    'npm run test',
    'npm run build',
    'node scripts/run-electron-e2e.mjs',
    'npm run security:audit',
    'npm run security:sbom',
    'node scripts/validate-acceptance.mjs --record-validated'
  ],
  testReports: {
    vitest: {
      ...fileEvidence(vitestPath),
      files: Number(vitestReport.testResults?.length ?? 0),
      total: Number(vitestReport.numTotalTests ?? 0),
      passed: Number(vitestReport.numPassedTests ?? 0),
      failed: Number(vitestReport.numFailedTests ?? 0),
      pending: Number(vitestReport.numPendingTests ?? 0)
    },
    playwright: {
      ...fileEvidence(playwrightPath),
      total: playwrightSpecs.length,
      passed: playwrightSpecs.filter(spec => spec.passed).length,
      failed: playwrightSpecs.filter(spec => !spec.passed).length
    }
  },
  evidence: {
    pipeline: fileEvidence(pipelinePath),
    sbom: fileEvidence(sbomPath),
    runtimeInput: fileEvidence(runtimeInputPath),
    claimsInput: fileEvidence(claimsInputPath)
  },
  externalQualificationEvidence,
  summary: {
    total: acceptance.length,
    passedLocalValidation: automatedCount,
    qualifiedExternal,
    externalPending,
    productionQualified
  },
  cases
};
writeJsonAtomic(receiptPath, receipt);

const status = {
  generatedAt,
  admittedAt: pipeline.admittedAt,
  release: packageJson.version,
  databaseSchemaVersion: schemaVersion,
  fixtureVersion: map.fixtureVersion,
  qualification: pipeline.qualification,
  runtimeInputSha256: currentInput.runtime.sha256,
  runtimeInputFileCount: currentInput.runtime.fileCount,
  claimsInputSha256: currentInput.claims.sha256,
  claimsInputFileCount: currentInput.claims.fileCount,
  inputManifests: pipeline.inputManifests,
  source: pipeline.source,
  environment: pipeline.environment,
  evidence: {
    pipeline: fileEvidence(pipelinePath),
    sbom: fileEvidence(sbomPath),
    runtimeInput: fileEvidence(runtimeInputPath),
    claimsInput: fileEvidence(claimsInputPath)
  },
  externalQualificationEvidence,
  pipeline: {
    status: 'passed',
    report: 'validation/results/pipeline.json',
    stages: pipeline.stages.map(stage => ({
      name: stage.name,
      status: stage.status,
      exitCode: stage.exitCode,
      completedAt: stage.completedAt
    }))
  },
  tests: receipt.testReports,
  acceptance: {
    receipt: 'VALIDATION_ACCEPTANCE_RECEIPT.json',
    ...receipt.summary
  },
  externalQualification: cases
    .filter(item => item.classification === 'external')
    .map(item => ({
      id: item.id,
      status: item.result === 'passed_external_qualification' ? 'qualified' : 'pending',
      ...(item.pendingReason ? { reason: item.pendingReason } : {}),
      artifacts: item.artifacts,
      ...(item.externalEvidence ? { evidence: item.externalEvidence } : {})
    })),
  production_ready: productionQualified
};
writeJsonAtomic(statusPath, status);
console.log(
  `Acceptance receipt written from exact reports: ${automatedCount} locally validated, `
  + `${qualifiedExternal} externally qualified, ${externalPending} external pending.`
);
