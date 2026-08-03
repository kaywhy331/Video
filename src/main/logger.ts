import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SECRET_PATTERNS = [
  /(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi,
  /(api[-_ ]?key\s*[:=]\s*)[^\s,"']+/gi,
  /(refresh[-_ ]?token\s*[:=]\s*)[^\s,"']+/gi,
  /(client[-_ ]?secret\s*[:=]\s*)[^\s,"']+/gi
];

export class Logger {
  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  private redact(input: unknown): string {
    let text: string;
    try {
      text = typeof input === 'string' ? input : JSON.stringify(input);
    } catch {
      text = String(input);
    }
    for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '$1[REDACTED]');
    return text;
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
