import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const safeStorage = vi.hoisted(() => ({
  available: true,
  isEncryptionAvailable: vi.fn(() => safeStorage.available),
  encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${[...value].reverse().join('')}`, 'utf8')),
  decryptString: vi.fn((value: Buffer) => {
    const encoded = value.toString('utf8');
    if (!encoded.startsWith('encrypted:')) throw new Error('invalid encrypted payload');
    return [...encoded.slice('encrypted:'.length)].reverse().join('');
  })
}));

vi.mock('electron', () => ({ safeStorage }));

import { SecretStore } from '@main/secret-store';

const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  safeStorage.available = true;
  vi.clearAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('encrypted secret storage', () => {
  it('[YT-001] encrypts OAuth refresh tokens at rest and round-trips only through OS storage', () => {
    const root = mkdtempSync(join(tmpdir(), 'videofactory-secrets-'));
    roots.push(root);
    const path = join(root, 'private', 'secrets.vf');
    const store = new SecretStore(path);
    store.update({ youtubeRefreshToken: 'refresh-token-plain', youtubeClientSecret: 'client-secret-plain' });
    const persisted = readFileSync(path, 'utf8');
    expect(persisted).not.toContain('refresh-token-plain');
    expect(persisted).not.toContain('client-secret-plain');
    expect(safeStorage.encryptString).toHaveBeenCalled();
    expect(store.getAll()).toMatchObject({
      youtubeRefreshToken: 'refresh-token-plain', youtubeClientSecret: 'client-secret-plain'
    });
    expect(safeStorage.decryptString).toHaveBeenCalled();
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('fails closed without creating plaintext when OS encryption is unavailable', () => {
    const root = mkdtempSync(join(tmpdir(), 'videofactory-secrets-unavailable-'));
    roots.push(root);
    const path = join(root, 'secrets.vf');
    safeStorage.available = false;
    expect(() => new SecretStore(path).update({ youtubeRefreshToken: 'never-write-me' }))
      .toThrow(/encryption is unavailable/i);
    expect(existsSync(path)).toBe(false);
  });

  it('replaces or clears only the stored YouTube credentials', () => {
    const root = mkdtempSync(join(tmpdir(), 'videofactory-secrets-replace-'));
    roots.push(root);
    const store = new SecretStore(join(root, 'secrets.vf'));
    store.update({ llmApiKey: 'keep-me', youtubeRefreshToken: 'old', youtubeAccessToken: 'old-access' });
    store.replaceYouTubeCredentials({
      youtubeRefreshToken: 'new', youtubeAccessToken: 'new-access', youtubeTokenExpiry: 123
    });
    expect(store.getAll()).toMatchObject({
      llmApiKey: 'keep-me', youtubeRefreshToken: 'new', youtubeAccessToken: 'new-access', youtubeTokenExpiry: 123
    });
    store.replaceYouTubeCredentials(null);
    expect(store.getAll()).toEqual({ llmApiKey: 'keep-me' });
  });
});
