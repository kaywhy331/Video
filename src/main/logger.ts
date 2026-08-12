import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /("?authorization"?\s*[:=]\s*"?bearer\s+)[^\s,"'}]+/gi, replacement: '$1[REDACTED]' },
  { pattern: /("?(?:api[-_ ]?key|llmApiKey|youtubeApiKey)"?\s*[:=]\s*"?)[^\s,"'}]+/gi, replacement: '$1[REDACTED]' },
  { pattern: /("?(?:refresh[-_ ]?token|youtubeRefreshToken)"?\s*[:=]\s*"?)[^\s,"'}]+/gi, replacement: '$1[REDACTED]' },
  { pattern: /("?(?:access[-_ ]?token|youtubeAccessToken)"?\s*[:=]\s*"?)[^\s,"'}]+/gi, replacement: '$1[REDACTED]' },
  { pattern: /("?(?:client[-_ ]?secret|youtubeClientSecret)"?\s*[:=]\s*"?)[^\s,"'}]+/gi, replacement: '$1[REDACTED]' },
  { pattern: /(https?:\/\/[^\s/:@]+:)[^\s/@]+(@)/gi, replacement: '$1[REDACTED]$2' }
];

export function redactSecrets(input: unknown): string {
  let text: string;
  try {
    text = typeof input === 'string' ? input : JSON.stringify(input);
  } catch {
    text = String(input);
  }
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, replacement);
  }
  return text;
}

export class Logger {
  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  private redact(input: unknown): string {
    return redactSecrets(input);
  }

  private write(level: string, message: string, metadata?: unknown): void {
    const row = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(metadata === undefined ? {} : { metadata: this.redact(metadata) })
    };
    appendFileSync(this.filePath, `${JSON.stringify(row)}\n`, 'utf8');
  }

  info(message: string, metadata?: unknown): void {
    this.write('info', message, metadata);
  }

  warn(message: string, metadata?: unknown): void {
    this.write('warn', message, metadata);
  }

  error(message: string, metadata?: unknown): void {
    this.write('error', message, metadata);
  }
}
