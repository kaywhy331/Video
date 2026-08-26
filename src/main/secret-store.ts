import { safeStorage } from 'electron';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SecretStatus } from '@shared/types';

export interface Secrets {
  llmApiKey?: string;
  visionApiKey?: string;
  researchApiKey?: string;
  httpTtsApiKey?: string;
  youtubeClientId?: string;
  youtubeClientSecret?: string;
  youtubeApiKey?: string;
  youtubeRefreshToken?: string;
  youtubeAccessToken?: string;
  youtubeTokenExpiry?: number;
}

export interface YouTubeStoredCredentials {
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
    this.write(next);
    return this.status(next);
  }

  replaceYouTubeCredentials(credentials: YouTubeStoredCredentials | null): SecretStatus {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Operating-system encryption is unavailable. Secrets were not saved.');
    }
    const next = this.getAll();
    delete next.youtubeRefreshToken;
    delete next.youtubeAccessToken;
    delete next.youtubeTokenExpiry;
    if (credentials?.youtubeRefreshToken) next.youtubeRefreshToken = credentials.youtubeRefreshToken;
    if (credentials?.youtubeAccessToken) next.youtubeAccessToken = credentials.youtubeAccessToken;
    if (credentials?.youtubeTokenExpiry !== undefined) next.youtubeTokenExpiry = credentials.youtubeTokenExpiry;
    this.write(next);
    return this.status(next);
  }

  private write(secrets: Secrets): void {
    const encrypted = safeStorage.encryptString(JSON.stringify(secrets));
    writeFileSync(this.filePath, encrypted.toString('base64'), { encoding: 'utf8', mode: 0o600 });
  }

  status(secrets = this.getAll()): SecretStatus {
    return {
      llmApiKeyConfigured: Boolean(secrets.llmApiKey),
      visionApiKeyConfigured: Boolean(secrets.visionApiKey),
      researchApiKeyConfigured: Boolean(secrets.researchApiKey),
      httpTtsApiKeyConfigured: Boolean(secrets.httpTtsApiKey),
      youtubeClientConfigured: Boolean(secrets.youtubeClientId && secrets.youtubeClientSecret),
      youtubeAuthorized: Boolean(secrets.youtubeRefreshToken),
      youtubeApiKeyConfigured: Boolean(secrets.youtubeApiKey)
    };
  }
}
