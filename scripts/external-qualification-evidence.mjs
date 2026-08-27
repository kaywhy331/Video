import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { dirname, isAbsolute, posix, relative, resolve, sep } from 'node:path';
import {
  ELECTRON_PERFORMANCE_GATE_IDS,
  assessElectronPerformanceEvidence
} from './electron-performance-evidence.mjs';
import {
  WINDOWS_PACKAGE_RUNTIME_GATE_IDS,
  assessWindowsPackageRuntimeEvidence
} from './windows-package-runtime-evidence.mjs';
import {
  PRODUCTION_PILOT_GATE_IDS,
  assessProductionPilotEvidence
} from './production-pilot-evidence.mjs';
import {
  PRODUCTION_RECOVERY_GATE_IDS,
  assessProductionRecoveryEvidence
} from './production-recovery-evidence.mjs';
import {
  WINDOWS_SYSTEM_GATE_IDS,
  assessWindowsSystemEvidence
} from './windows-system-evidence.mjs';
import { assertValidationSource, captureValidationSource } from './validation-source.mjs';

export const EXTERNAL_QUALIFICATION_INDEX_SCHEMA_VERSION = 1;
export const EXTERNAL_QUALIFICATION_INDEX_KIND = 'videofactory-external-qualification-index';
export const EXTERNAL_QUALIFICATION_INDEX_PATH = 'validation/external-qualification/index.json';
export const ELECTRON_PERFORMANCE_RECEIPT_KIND = 'electron_performance';
export const ELECTRON_PERFORMANCE_RECEIPT_PATH = 'validation/results/electron-performance.json';
export const WINDOWS_PACKAGE_RUNTIME_RECEIPT_KIND = 'windows_package_runtime';
export const WINDOWS_PACKAGE_RUNTIME_RECEIPT_PATH = 'release/WINDOWS_PACKAGE_SMOKE.json';
export const PRODUCTION_PILOT_RECEIPT_KIND = 'production_pilot';
export const PRODUCTION_PILOT_RECEIPT_PATH = 'validation/results/production-pilot.json';
export const PRODUCTION_RECOVERY_RECEIPT_KIND = 'production_recovery';
export const PRODUCTION_RECOVERY_RECEIPT_PATH = 'validation/results/production-recovery.json';
export const WINDOWS_SYSTEM_RECEIPT_KIND = 'windows_system';
export const WINDOWS_SYSTEM_RECEIPT_PATH = 'validation/results/windows-system.json';

const canonicalReceiptPaths = Object.freeze({
  [PRODUCTION_PILOT_RECEIPT_KIND]: PRODUCTION_PILOT_RECEIPT_PATH,
  [PRODUCTION_RECOVERY_RECEIPT_KIND]: PRODUCTION_RECOVERY_RECEIPT_PATH,
  [ELECTRON_PERFORMANCE_RECEIPT_KIND]: ELECTRON_PERFORMANCE_RECEIPT_PATH,
  [WINDOWS_PACKAGE_RUNTIME_RECEIPT_KIND]: WINDOWS_PACKAGE_RUNTIME_RECEIPT_PATH,
  [WINDOWS_SYSTEM_RECEIPT_KIND]: WINDOWS_SYSTEM_RECEIPT_PATH
});

export const EXTERNAL_QUALIFICATION_GATE_IDS = Object.freeze([
  ...PRODUCTION_PILOT_GATE_IDS,
  ...PRODUCTION_RECOVERY_GATE_IDS,
  ...ELECTRON_PERFORMANCE_GATE_IDS,
  ...WINDOWS_PACKAGE_RUNTIME_GATE_IDS,
  ...WINDOWS_SYSTEM_GATE_IDS
]);

const MAXIMUM_RECEIPTS = 20;

export function writeElectronPerformanceQualificationIndex({
  root = process.cwd(),
  source,
  receiptPath = ELECTRON_PERFORMANCE_RECEIPT_PATH,
  indexPath = EXTERNAL_QUALIFICATION_INDEX_PATH,
  now = new Date()
} = {}) {
  return writeQualificationIndex({
    root,
    source,
    receiptPath,
    indexPath,
    now,
    kind: ELECTRON_PERFORMANCE_RECEIPT_KIND,
    canonicalReceiptPath: ELECTRON_PERFORMANCE_RECEIPT_PATH,
    label: 'Electron performance'
  });
}

export function writeWindowsPackageRuntimeQualificationIndex({
  root = process.cwd(),
  source,
  receiptPath = WINDOWS_PACKAGE_RUNTIME_RECEIPT_PATH,
  indexPath = EXTERNAL_QUALIFICATION_INDEX_PATH,
  now = new Date()
} = {}) {
  return writeQualificationIndex({
    root,
    source,
    receiptPath,
    indexPath,
    now,
    kind: WINDOWS_PACKAGE_RUNTIME_RECEIPT_KIND,
    canonicalReceiptPath: WINDOWS_PACKAGE_RUNTIME_RECEIPT_PATH,
    label: 'Windows package runtime'
  });
}

export function writeProductionPilotQualificationIndex({
  root = process.cwd(),
  source,
  receiptPath = PRODUCTION_PILOT_RECEIPT_PATH,
  indexPath = EXTERNAL_QUALIFICATION_INDEX_PATH,
  now = new Date()
} = {}) {
  return writeQualificationIndex({
    root,
    source,
    receiptPath,
    indexPath,
    now,
    kind: PRODUCTION_PILOT_RECEIPT_KIND,
    canonicalReceiptPath: PRODUCTION_PILOT_RECEIPT_PATH,
    label: 'Production pilot'
  });
}

export function writeProductionRecoveryQualificationIndex({
  root = process.cwd(),
  source,
  receiptPath = PRODUCTION_RECOVERY_RECEIPT_PATH,
  indexPath = EXTERNAL_QUALIFICATION_INDEX_PATH,
  now = new Date()
} = {}) {
  return writeQualificationIndex({
    root,
    source,
    receiptPath,
    indexPath,
    now,
    kind: PRODUCTION_RECOVERY_RECEIPT_KIND,
    canonicalReceiptPath: PRODUCTION_RECOVERY_RECEIPT_PATH,
    label: 'Production recovery'
  });
}

export function writeWindowsSystemQualificationIndex({
  root = process.cwd(),
  source,
  receiptPath = WINDOWS_SYSTEM_RECEIPT_PATH,
  indexPath = EXTERNAL_QUALIFICATION_INDEX_PATH,
  now = new Date()
} = {}) {
  return writeQualificationIndex({
    root,
    source,
    receiptPath,
    indexPath,
    now,
    kind: WINDOWS_SYSTEM_RECEIPT_KIND,
    canonicalReceiptPath: WINDOWS_SYSTEM_RECEIPT_PATH,
    label: 'Windows system matrix'
  });
}

export function admitExternalQualificationEvidence({
  root = process.cwd(),
  indexPath = EXTERNAL_QUALIFICATION_INDEX_PATH,
  source,
  allowedIds = EXTERNAL_QUALIFICATION_GATE_IDS
} = {}) {
  return admitExternalQualificationEvidenceInternal({ root, indexPath, source, allowedIds });
}

function admitExternalQualificationEvidenceInternal({
  root,
  indexPath,
  source,
  allowedIds
}, replacingKind = null) {
  const normalizedRoot = resolve(root);
  const normalizedIndexPath = evidencePath(indexPath, 'External qualification index path');
  const resolvedIndexPath = resolveInside(normalizedRoot, normalizedIndexPath, 'External qualification index path');
  if (!existsSync(resolvedIndexPath)) return emptyAdmission(normalizedIndexPath);

  const admittedSource = source ?? captureValidationSource(normalizedRoot);
  assertValidationSource(admittedSource, 'release', 'External qualification admission source');
  const allowed = idSet(allowedIds, 'Allowed external qualification IDs');
  const indexBytes = readFileSync(resolvedIndexPath);
  const index = parseJson(indexBytes, 'External qualification index');
  exactKeys(index, [
    'schemaVersion',
    'evidenceKind',
    'generatedAt',
    'qualification',
    'source',
    'receipts'
  ], 'External qualification index');
  if (index.schemaVersion !== EXTERNAL_QUALIFICATION_INDEX_SCHEMA_VERSION) {
    throw new Error(
      `External qualification index must use schema version ${EXTERNAL_QUALIFICATION_INDEX_SCHEMA_VERSION}.`
    );
  }
  if (index.evidenceKind !== EXTERNAL_QUALIFICATION_INDEX_KIND) {
    throw new Error('External qualification index has an unknown evidence identity.');
  }
  if (index.qualification !== 'release') {
    throw new Error('External qualification evidence may only be admitted for release validation.');
  }
  isoTimestamp(index.generatedAt, 'External qualification index generatedAt');
  assertValidationSource(index.source, 'release', 'External qualification index source');
  assertSameExactSource(index.source, admittedSource, 'External qualification index');
  if (!Array.isArray(index.receipts) || index.receipts.length === 0) {
    throw new Error('External qualification index must contain at least one receipt.');
  }
  if (index.receipts.length > MAXIMUM_RECEIPTS) {
    throw new Error(`External qualification index cannot contain more than ${MAXIMUM_RECEIPTS} receipts.`);
  }

  const seenKinds = new Set();
  const seenPaths = new Set();
  const qualifiedIds = new Set();
  const qualifiedById = {};
  const receipts = [];
  for (const [position, descriptor] of index.receipts.entries()) {
    const label = `External qualification receipt ${position + 1}`;
    exactKeys(descriptor, ['kind', 'path', 'sha256', 'sizeBytes'], label);
    const kind = nonEmptyString(descriptor.kind, `${label} kind`);
    const path = evidencePath(descriptor.path, `${label} path`);
    if (seenKinds.has(kind)) throw new Error(`External qualification index repeats receipt kind: ${kind}.`);
    if (seenPaths.has(path)) throw new Error(`External qualification index repeats receipt path: ${path}.`);
    seenKinds.add(kind);
    seenPaths.add(path);
    if (!/^[a-f0-9]{64}$/.test(String(descriptor.sha256 ?? ''))) {
      throw new Error(`${label} must contain a lowercase SHA-256 digest.`);
    }
    if (!Number.isSafeInteger(descriptor.sizeBytes) || descriptor.sizeBytes <= 0) {
      throw new Error(`${label} must contain a positive integer byte size.`);
    }
    if (kind === replacingKind) {
      if (path !== canonicalReceiptPaths[kind]) {
        throw new Error(`Replacement qualification evidence has a non-canonical path: ${path}.`);
      }
      continue;
    }

    const resolvedReceiptPath = resolveInside(normalizedRoot, path, `${label} path`);
    if (!existsSync(resolvedReceiptPath)) throw new Error(`${label} is missing: ${path}.`);
    const receiptBytes = readFileSync(resolvedReceiptPath);
    const actualSizeBytes = statSync(resolvedReceiptPath).size;
    const actualSha256 = sha256(receiptBytes);
    if (descriptor.sizeBytes !== actualSizeBytes || descriptor.sha256 !== actualSha256) {
      throw new Error(`${label} failed byte-size or SHA-256 integrity verification.`);
    }

    let assessed;
    let gateIds;
    if (kind === ELECTRON_PERFORMANCE_RECEIPT_KIND) {
      if (path !== ELECTRON_PERFORMANCE_RECEIPT_PATH) {
        throw new Error(
          `Electron performance qualification evidence must use ${ELECTRON_PERFORMANCE_RECEIPT_PATH}.`
        );
      }
      assessed = assessElectronPerformanceEvidence(parseJson(receiptBytes, 'Electron performance receipt'));
      assertValidationSource(assessed.source, 'release', 'Electron performance receipt source');
      assertSameExactSource(assessed.source, index.source, 'Electron performance receipt');
      if (assessed.externalQualificationPassed !== true) {
        throw new Error('Electron performance receipt is not eligible external qualification evidence.');
      }
      gateIds = ELECTRON_PERFORMANCE_GATE_IDS;
      for (const id of gateIds) {
        if (assessed.acceptance[id] !== 'qualified') {
          throw new Error(`Electron performance receipt did not qualify ${id}.`);
        }
      }
    } else if (kind === WINDOWS_PACKAGE_RUNTIME_RECEIPT_KIND) {
      if (path !== WINDOWS_PACKAGE_RUNTIME_RECEIPT_PATH) {
        throw new Error(
          `Windows package runtime qualification evidence must use ${WINDOWS_PACKAGE_RUNTIME_RECEIPT_PATH}.`
        );
      }
      assessed = assessWindowsPackageRuntimeEvidence(parseJson(receiptBytes, 'Windows package runtime receipt'));
      assertValidationSource(assessed.source, 'release', 'Windows package runtime receipt source');
      assertSameExactSource(assessed.source, index.source, 'Windows package runtime receipt');
      if (assessed.externalQualificationPassed !== true) {
        throw new Error('Windows package runtime receipt is not eligible external qualification evidence.');
      }
      gateIds = WINDOWS_PACKAGE_RUNTIME_GATE_IDS;
      for (const id of gateIds) {
        if (assessed.acceptance[id] !== 'qualified') {
          throw new Error(`Windows package runtime receipt did not qualify ${id}.`);
        }
      }
    } else if (kind === PRODUCTION_PILOT_RECEIPT_KIND) {
      if (path !== PRODUCTION_PILOT_RECEIPT_PATH) {
        throw new Error(
          `Production pilot qualification evidence must use ${PRODUCTION_PILOT_RECEIPT_PATH}.`
        );
      }
      assessed = assessProductionPilotEvidence(parseJson(receiptBytes, 'Production pilot receipt'));
      assertValidationSource(assessed.source, 'release', 'Production pilot receipt source');
      assertSameExactSource(assessed.source, index.source, 'Production pilot receipt');
      if (assessed.externalQualificationPassed !== true) {
        throw new Error('Production pilot receipt is not eligible external qualification evidence.');
      }
      gateIds = PRODUCTION_PILOT_GATE_IDS;
      for (const id of gateIds) {
        if (assessed.acceptance[id] !== 'qualified') {
          throw new Error(`Production pilot receipt did not qualify ${id}.`);
        }
      }
    } else if (kind === PRODUCTION_RECOVERY_RECEIPT_KIND) {
      if (path !== PRODUCTION_RECOVERY_RECEIPT_PATH) {
        throw new Error(
          `Production recovery qualification evidence must use ${PRODUCTION_RECOVERY_RECEIPT_PATH}.`
        );
      }
      assessed = assessProductionRecoveryEvidence(parseJson(receiptBytes, 'Production recovery receipt'));
      assertValidationSource(assessed.source, 'release', 'Production recovery receipt source');
      assertSameExactSource(assessed.source, index.source, 'Production recovery receipt');
      if (assessed.externalQualificationPassed !== true) {
        throw new Error('Production recovery receipt is not eligible external qualification evidence.');
      }
      gateIds = PRODUCTION_RECOVERY_GATE_IDS;
      for (const id of gateIds) {
        if (assessed.acceptance[id] !== 'qualified') {
          throw new Error(`Production recovery receipt did not qualify ${id}.`);
        }
      }
    } else if (kind === WINDOWS_SYSTEM_RECEIPT_KIND) {
      if (path !== WINDOWS_SYSTEM_RECEIPT_PATH) {
        throw new Error(
          `Windows system qualification evidence must use ${WINDOWS_SYSTEM_RECEIPT_PATH}.`
        );
      }
      assessed = assessWindowsSystemEvidence(parseJson(receiptBytes, 'Windows system receipt'));
      assertValidationSource(assessed.source, 'release', 'Windows system receipt source');
      assertSameExactSource(assessed.source, index.source, 'Windows system receipt');
      if (assessed.externalQualificationPassed !== true) {
        throw new Error('Windows system receipt is not eligible external qualification evidence.');
      }
      gateIds = WINDOWS_SYSTEM_GATE_IDS;
      for (const id of gateIds) {
        if (assessed.acceptance[id] !== 'qualified') {
          throw new Error(`Windows system receipt did not qualify ${id}.`);
        }
      }
    } else {
      throw new Error(`External qualification index contains unknown receipt kind: ${kind}.`);
    }

    const evidence = { path, sha256: actualSha256, sizeBytes: actualSizeBytes };
    for (const id of gateIds) {
      if (!allowed.has(id)) throw new Error(`External qualification receipt contains disallowed gate ID: ${id}.`);
      if (qualifiedIds.has(id)) throw new Error(`External qualification evidence covers ${id} more than once.`);
      qualifiedIds.add(id);
      qualifiedById[id] = { kind, evidence };
    }
    receipts.push({ kind, evidence, qualifiedIds: [...gateIds], assessment: assessed });
  }

  return {
    present: true,
    index: {
      path: normalizedIndexPath,
      sha256: sha256(indexBytes),
      sizeBytes: statSync(resolvedIndexPath).size
    },
    receipts,
    qualifiedIds: [...qualifiedIds].sort(),
    qualifiedById
  };
}

function writeQualificationIndex({
  root,
  source,
  receiptPath,
  indexPath,
  now,
  kind,
  canonicalReceiptPath,
  label
}) {
  const normalizedRoot = resolve(root);
  const admittedSource = source ?? captureValidationSource(normalizedRoot);
  assertValidationSource(admittedSource, 'release', 'External qualification index source');
  const normalizedReceiptPath = evidencePath(receiptPath, `${label} receipt path`);
  if (normalizedReceiptPath !== canonicalReceiptPath) {
    throw new Error(`${label} qualification evidence must use ${canonicalReceiptPath}.`);
  }
  const normalizedIndexPath = evidencePath(indexPath, 'External qualification index path');
  const resolvedReceiptPath = resolveInside(normalizedRoot, normalizedReceiptPath, `${label} receipt path`);
  if (!existsSync(resolvedReceiptPath)) {
    throw new Error(`${label} qualification receipt is missing: ${normalizedReceiptPath}.`);
  }
  const receiptBytes = readFileSync(resolvedReceiptPath);
  const descriptor = {
    kind,
    path: normalizedReceiptPath,
    sha256: sha256(receiptBytes),
    sizeBytes: receiptBytes.length
  };
  const resolvedIndexPath = resolveInside(normalizedRoot, normalizedIndexPath, 'External qualification index path');
  let receipts = [];
  if (existsSync(resolvedIndexPath)) {
    admitExternalQualificationEvidenceInternal({
      root: normalizedRoot,
      indexPath: normalizedIndexPath,
      source: admittedSource,
      allowedIds: EXTERNAL_QUALIFICATION_GATE_IDS
    }, kind);
    const existing = parseJson(readFileSync(resolvedIndexPath), 'External qualification index');
    receipts = existing.receipts.filter(item => item.kind !== kind);
  }
  receipts.push(descriptor);
  const kindOrder = [
    PRODUCTION_PILOT_RECEIPT_KIND,
    PRODUCTION_RECOVERY_RECEIPT_KIND,
    ELECTRON_PERFORMANCE_RECEIPT_KIND,
    WINDOWS_PACKAGE_RUNTIME_RECEIPT_KIND,
    WINDOWS_SYSTEM_RECEIPT_KIND
  ];
  receipts.sort((left, right) => kindOrder.indexOf(left.kind) - kindOrder.indexOf(right.kind));

  const generatedAt = now instanceof Date ? now.toISOString() : String(now);
  isoTimestamp(generatedAt, 'External qualification index generatedAt');
  const index = {
    schemaVersion: EXTERNAL_QUALIFICATION_INDEX_SCHEMA_VERSION,
    evidenceKind: EXTERNAL_QUALIFICATION_INDEX_KIND,
    generatedAt,
    qualification: 'release',
    source: admittedSource,
    receipts
  };
  const temporaryPath = `${resolvedIndexPath}.tmp`;
  mkdirSync(dirname(resolvedIndexPath), { recursive: true });
  writeFileSync(temporaryPath, `${JSON.stringify(index, null, 2)}\n`);
  renameSync(temporaryPath, resolvedIndexPath);
  return admitExternalQualificationEvidence({
    root: normalizedRoot,
    indexPath: normalizedIndexPath,
    source: admittedSource,
    allowedIds: EXTERNAL_QUALIFICATION_GATE_IDS
  });
}

function emptyAdmission(indexPath) {
  return {
    present: false,
    indexPath,
    index: null,
    receipts: [],
    qualifiedIds: [],
    qualifiedById: {}
  };
}

function assertSameExactSource(evidenceSource, admittedSource, label) {
  if (
    evidenceSource.commit !== admittedSource.commit
    || evidenceSource.tree !== admittedSource.tree
    || evidenceSource.dirty !== false
    || admittedSource.dirty !== false
  ) {
    throw new Error(`${label} does not match the clean exact admitted source commit and tree.`);
  }
}

function idSet(values, label) {
  if (!Array.isArray(values) && !(values instanceof Set)) {
    throw new Error(`${label} must be an array or set.`);
  }
  const result = new Set();
  for (const value of values) {
    const id = nonEmptyString(value, `${label} entry`);
    if (result.has(id)) throw new Error(`${label} contains duplicate ID: ${id}.`);
    result.add(id);
  }
  return result;
}

function evidencePath(value, label) {
  const path = nonEmptyString(value, label);
  if (
    isAbsolute(path)
    || path.includes('\\')
    || /^[A-Za-z]:/.test(path)
    || path !== posix.normalize(path)
    || path === '..'
    || path.startsWith('../')
    || path.startsWith('/')
  ) {
    throw new Error(`${label} must be a normalized repository-relative POSIX path.`);
  }
  return path;
}

function resolveInside(root, path, label) {
  const resolved = resolve(root, path);
  const fromRoot = relative(root, resolved);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`${label} resolves outside the repository root.`);
  }
  return resolved;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const keys = Object.keys(value).sort();
  const required = [...expected].sort();
  if (keys.join('\n') !== required.join('\n')) {
    throw new Error(`${label} fields must be exactly: ${required.join(', ')}.`);
  }
  return value;
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty trimmed string.`);
  }
  return value;
}

function isoTimestamp(value, label) {
  const timestamp = nonEmptyString(value, label);
  if (!Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) {
    throw new Error(`${label} must be a canonical ISO timestamp.`);
  }
  return timestamp;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
