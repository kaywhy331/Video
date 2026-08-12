import { safeStorage } from 'electron';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SecretStatus } from '@shared/types';

export interface Secrets {
  llmApiKey?: string;
  visionApiKey?: string;
  httpTtsApiKey?: string;
  youtubeClientId?: string;
  youtubeClientSecret?: string;
  youtubeApiKey?: string;
  youtubeRefreshToken?: string;
  youtubeAccessToken?: string;
  youtubeTokenExpiry?: number;
}

export class SecretStore {
  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  getAll(): Secrets {
    if (!existsSync(this.filePath)) return {};
    const encoded = readFileSync(this.filePath, 'utf8');
    if (!encoded.trim()) return {};
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Operating-system encryption is unavailable. Secret access is blocked.');
    }
    const decrypted = safeStorage.decryptString(Buffer.from(encoded, 'base64'));
    return JSON.parse(decrypted) as Secrets;
  }

  update(patch: Partial<Secrets>): SecretStatus {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Operating-system encryption is unavailable. Secrets were not saved.');
    }
    const current = this.getAll();
    const next: Secrets = { ...current };
    for (const [key, value] of Object.entries(patch)) {
      if (value === '') delete (next as Record<string, unknown>)[key];
      else if (value !== undefined) (next as Record<string, unknown>)[key] = value;
    }
    const encrypted = safeStorage.encryptString(JSON.stringify(next));
    writeFileSync(this.filePath, encrypted.toString('base64'), { encoding: 'utf8', mode: 0o600 });
    return this.status(next);
  }

  status(secrets = this.getAll()): SecretStatus {
    return {
      llmApiKeyConfigured: Boolean(secrets.llmApiKey),
      visionApiKeyConfigured: Boolean(secrets.visionApiKey),
      httpTtsApiKeyConfigured: Boolean(secrets.httpTtsApiKey),
      youtubeClientConfigured: Boolean(secrets.youtubeClientId && secrets.youtubeClientSecret),
      youtubeAuthorized: Boolean(secrets.youtubeRefreshToken),
      youtubeApiKeyConfigured: Boolean(secrets.youtubeApiKey)
    };
  }
}
