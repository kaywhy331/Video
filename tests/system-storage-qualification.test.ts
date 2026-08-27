import { describe, expect, it } from 'vitest';
import { classifySystemStorageProbe } from '@main/system-storage-qualification';

const minimumFreeBytes = 25 * 1024 ** 3;

describe('Windows system storage qualification', () => {
  it('classifies the exact four external path failures without retaining paths', () => {
    const missing = classifySystemStorageProbe({ kind: 'missing', path: 'C:\\missing\\target' }, {
      exists: false, directory: false, writable: false, freeBytes: null,
      statErrorCode: 'ENOENT', writeErrorCode: null, timedOut: false
    }, minimumFreeBytes);
    const offline = classifySystemStorageProbe({ kind: 'offline_nas', path: '\\\\offline-host\\media' }, {
      exists: false, directory: false, writable: false, freeBytes: null,
      statErrorCode: 'TIMEOUT', writeErrorCode: null, timedOut: true
    }, minimumFreeBytes);
    const readOnly = classifySystemStorageProbe({ kind: 'read_only', path: 'R:\\media' }, {
      exists: true, directory: true, writable: false, freeBytes: 100 * 1024 ** 3,
      statErrorCode: null, writeErrorCode: 'EACCES', timedOut: false
    }, minimumFreeBytes);
    const lowSpace = classifySystemStorageProbe({ kind: 'insufficient_space', path: 'S:\\media' }, {
      exists: true, directory: true, writable: true, freeBytes: minimumFreeBytes - 1,
      statErrorCode: null, writeErrorCode: null, timedOut: false
    }, minimumFreeBytes);

    expect([missing, offline, readOnly, lowSpace].map(value => [value.observed, value.matched])).toEqual([
      ['missing', true],
      ['offline_nas', true],
      ['read_only', true],
      ['insufficient_space', true]
    ]);
    expect(missing.pathSha256).toMatch(/^[a-f0-9]{64}$/);
    expect([missing.pathType, offline.pathType]).toEqual(['local', 'unc']);
    expect(JSON.stringify([missing, offline, readOnly, lowSpace])).not.toContain('offline-host');
  });

  it('fails closed when a declared failure condition is not actually observed', () => {
    const observation = classifySystemStorageProbe({ kind: 'read_only', path: 'C:\\writable' }, {
      exists: true, directory: true, writable: true, freeBytes: 100 * 1024 ** 3,
      statErrorCode: null, writeErrorCode: null, timedOut: false
    }, minimumFreeBytes);
    expect(observation.observed).toBe('unexpected');
    expect(observation.matched).toBe(false);
  });
});
