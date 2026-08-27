import { createHash, randomUUID } from 'node:crypto';
import { constants, readFileSync } from 'node:fs';
import { access, open, stat, statfs, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export const SYSTEM_STORAGE_MATRIX_SCHEMA_VERSION = 1;
export const SYSTEM_STORAGE_CASE_KINDS = Object.freeze([
  'read_only',
  'missing',
  'offline_nas',
  'insufficient_space'
] as const);

export type SystemStorageCaseKind = typeof SYSTEM_STORAGE_CASE_KINDS[number];

export interface SystemStorageCaseInput {
  kind: SystemStorageCaseKind;
  path: string;
}

export interface RawSystemStorageProbe {
  exists: boolean;
  directory: boolean;
  writable: boolean;
  freeBytes: number | null;
  statErrorCode: string | null;
  writeErrorCode: string | null;
  timedOut: boolean;
}

export interface SystemStorageProbeObservation extends RawSystemStorageProbe {
  kind: SystemStorageCaseKind;
  pathType: 'local' | 'unc';
  pathSha256: string;
  observed: SystemStorageCaseKind | 'unexpected';
  matched: boolean;
}

export function readSystemStorageMatrix(path: string | undefined): SystemStorageCaseInput[] {
  if (!path?.trim()) return [];
  const document = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  if (
    !document
    || typeof document !== 'object'
    || Array.isArray(document)
    || Object.keys(document).sort().join(',') !== 'cases,schemaVersion'
    || document.schemaVersion !== SYSTEM_STORAGE_MATRIX_SCHEMA_VERSION
    || !Array.isArray(document.cases)
    || document.cases.length === 0
    || document.cases.length > SYSTEM_STORAGE_CASE_KINDS.length
  ) {
    throw new Error('System storage matrix must contain schemaVersion 1 and one to four bounded cases.');
  }
  const seen = new Set<string>();
  return document.cases.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`System storage matrix case ${index + 1} must be an object.`);
    }
    const item = value as Record<string, unknown>;
    if (Object.keys(item).sort().join(',') !== 'kind,path') {
      throw new Error(`System storage matrix case ${index + 1} has unknown or missing fields.`);
    }
    if (!SYSTEM_STORAGE_CASE_KINDS.includes(item.kind as SystemStorageCaseKind)) {
      throw new Error(`System storage matrix case ${index + 1} has an unsupported kind.`);
    }
    if (typeof item.path !== 'string' || !item.path.trim() || item.path !== item.path.trim() || !isAbsolute(item.path)) {
      throw new Error(`System storage matrix case ${index + 1} requires an absolute trimmed path.`);
    }
    const absolutePath = item.path;
    const kind = item.kind as SystemStorageCaseKind;
    if (seen.has(kind)) throw new Error(`System storage matrix repeats ${kind}.`);
    seen.add(kind);
    return { kind, path: absolutePath };
  });
}

export async function probeSystemStorageMatrix(
  cases: SystemStorageCaseInput[],
  minimumFreeBytes: number,
  timeoutMs = 10_000
): Promise<SystemStorageProbeObservation[]> {
  if (!Number.isSafeInteger(minimumFreeBytes) || minimumFreeBytes <= 0) {
    throw new Error('System storage qualification requires a positive integer minimum free byte count.');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new Error('System storage qualification timeout must be between 100 and 60000 milliseconds.');
  }
  const observations: SystemStorageProbeObservation[] = [];
  for (const item of cases) {
    const raw = await collectRawProbe(item.path, timeoutMs);
    observations.push(classifySystemStorageProbe(item, raw, minimumFreeBytes));
  }
  return observations;
}

export function classifySystemStorageProbe(
  input: SystemStorageCaseInput,
  raw: RawSystemStorageProbe,
  minimumFreeBytes: number
): SystemStorageProbeObservation {
  const offlinePath = /^\\\\[^\\]+\\[^\\]+/u.test(input.path);
  const observed: SystemStorageProbeObservation['observed'] = !raw.exists && input.kind === 'missing'
    ? 'missing'
    : offlinePath && (!raw.exists || raw.timedOut || raw.statErrorCode !== null)
      ? 'offline_nas'
      : raw.exists && raw.directory && !raw.writable && raw.writeErrorCode !== null
        ? 'read_only'
        : raw.exists
          && raw.directory
          && raw.writable
          && raw.freeBytes !== null
          && raw.freeBytes < minimumFreeBytes
          ? 'insufficient_space'
          : 'unexpected';
  return {
    kind: input.kind,
    pathType: offlinePath ? 'unc' : 'local',
    pathSha256: createHash('sha256').update(input.path.toLowerCase()).digest('hex'),
    ...raw,
    observed,
    matched: observed === input.kind
  };
}

async function collectRawProbe(path: string, timeoutMs: number): Promise<RawSystemStorageProbe> {
  let exists = false;
  let directory = false;
  let writable = false;
  let freeBytes: number | null = null;
  let statErrorCode: string | null = null;
  let writeErrorCode: string | null = null;
  let timedOut = false;

  try {
    const value = await bounded(stat(path), timeoutMs);
    exists = true;
    directory = value.isDirectory();
  } catch (error) {
    statErrorCode = errorCode(error);
    timedOut ||= statErrorCode === 'TIMEOUT';
  }

  if (exists && directory) {
    try {
      await bounded(access(path, constants.W_OK), timeoutMs);
      const probePath = join(path, `.videofactory-write-probe-${randomUUID()}.tmp`);
      let handle: Awaited<ReturnType<typeof open>> | null = null;
      try {
        handle = await bounded(open(probePath, 'wx'), timeoutMs);
        await bounded(handle.writeFile('VideoFactory storage qualification probe\n'), timeoutMs);
        await bounded(handle.sync(), timeoutMs);
        writable = true;
      } finally {
        await handle?.close().catch(() => undefined);
        await unlink(probePath).catch(() => undefined);
      }
    } catch (error) {
      writeErrorCode = errorCode(error);
      timedOut ||= writeErrorCode === 'TIMEOUT';
    }
    try {
      const value = await bounded(statfs(path), timeoutMs);
      freeBytes = value.bavail * value.bsize;
    } catch (error) {
      statErrorCode ??= errorCode(error);
      timedOut ||= statErrorCode === 'TIMEOUT';
    }
  }

  return { exists, directory, writable, freeBytes, statErrorCode, writeErrorCode, timedOut };
}

async function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(Object.assign(new Error('Storage probe timed out.'), { code: 'TIMEOUT' })), timeoutMs);
        timeout.unref();
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function errorCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'ERROR';
  return /^[A-Z0-9_]{1,40}$/u.test(code) ? code : 'ERROR';
}
