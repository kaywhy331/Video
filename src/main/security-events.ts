import type { AppDatabase } from './database/database';
import { redactSecrets } from './logger';

export const SECURITY_EVENT_SCHEMA_VERSION = 1;

export type SecurityEventFlow =
  | 'oauth'
  | 'provider'
  | 'publication'
  | 'retry'
  | 'media_tool';

export type SecurityEventContext = Record<string, unknown>;

export interface SecurityRejectionInput {
  flow: SecurityEventFlow;
  operation: string;
  code: string;
  recovery: string;
  entityType: string;
  entityId: string;
  context?: SecurityEventContext;
  actor?: 'system' | 'human';
}

const STABLE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const SAFE_LABEL = /^[a-z][a-z0-9_.-]{1,63}$/;
const SAFE_ENTITY_ID = /^[A-Za-z0-9_.:@-]{1,128}$/;
const MAX_CONTEXT_DEPTH = 3;
const MAX_CONTEXT_ENTRIES = 32;
const MAX_STRING_LENGTH = 512;

function sensitiveContextKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return normalized === 'state'
    || normalized === 'code'
    || normalized === 'authorization'
    || normalized === 'query'
    || normalized === 'request'
    || normalized === 'response'
    || normalized.includes('token')
    || normalized.includes('secret')
    || normalized.includes('password')
    || normalized.includes('verifier')
    || normalized.includes('challenge')
    || normalized.includes('apikey')
    || normalized.includes('credential')
    || normalized.endsWith('path')
    || normalized.includes('requestbody')
    || normalized.includes('responsebody')
    || normalized.includes('operatorreason')
    || normalized.includes('priorerror')
    || normalized.includes('errormessage')
    || normalized.includes('prompt')
    || normalized.includes('script')
    || normalized.includes('contactsheet')
    || normalized.includes('narrationtext')
    || normalized.includes('mediabytes');
}

function redactString(value: string): string {
  return redactSecrets(value).slice(0, MAX_STRING_LENGTH);
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'bigint') return value.toString();
  if (depth >= MAX_CONTEXT_DEPTH) return '[TRUNCATED]';
  if (Array.isArray(value)) {
    return value.slice(0, MAX_CONTEXT_ENTRIES).map(item => sanitizeValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, MAX_CONTEXT_ENTRIES)) {
      result[key] = sensitiveContextKey(key) ? '[REDACTED]' : sanitizeValue(item, depth + 1);
    }
    return result;
  }
  return '[UNSUPPORTED]';
}

function requireStableCode(code: string): string {
  if (!STABLE_CODE.test(code)) throw new Error('Security rejection codes must be stable uppercase identifiers.');
  return code;
}

function requireSafeLabel(value: string, label: string): string {
  if (!SAFE_LABEL.test(value)) throw new Error(`Security event ${label} must be a stable lowercase identifier.`);
  return value;
}

function requireRecovery(recovery: string): string {
  const value = recovery.trim();
  if (value.length < 10 || value.length > MAX_STRING_LENGTH) {
    throw new Error('Security rejection recovery guidance must be between 10 and 512 characters.');
  }
  return redactString(value);
}

export function formatSecurityError(code: string, message: string, recovery: string): string {
  return `[${requireStableCode(code)}] ${redactString(message)} Recovery: ${requireRecovery(recovery)}`;
}

export class PrivilegedOperationError extends Error {
  readonly recovery: string;

  constructor(
    readonly code: string,
    message: string,
    recovery: string
  ) {
    const safeRecovery = requireRecovery(recovery);
    super(formatSecurityError(code, message, safeRecovery));
    this.name = 'PrivilegedOperationError';
    this.recovery = safeRecovery;
  }
}

export function securityRejectionMetadata(input: SecurityRejectionInput): Record<string, unknown> {
  return {
    schemaVersion: SECURITY_EVENT_SCHEMA_VERSION,
    event: 'privileged_rejection',
    outcome: 'rejected',
    flow: input.flow,
    operation: requireSafeLabel(input.operation, 'operation'),
    code: requireStableCode(input.code),
    recovery: requireRecovery(input.recovery),
    context: sanitizeValue(input.context ?? {}, 0)
  };
}

export function recordSecurityRejection(db: AppDatabase, input: SecurityRejectionInput): void {
  const entityType = requireSafeLabel(input.entityType, 'entity type');
  const entityId = SAFE_ENTITY_ID.test(input.entityId) ? input.entityId : '[REDACTED]';
  const metadata = securityRejectionMetadata(input);
  db.raw.prepare(`
    INSERT INTO audit_log(action, actor, entity_type, entity_id, metadata_json, created_at)
    VALUES('security.privileged_rejected', ?, ?, ?, ?, ?)
  `).run(
    input.actor ?? 'system',
    entityType,
    entityId,
    JSON.stringify(metadata),
    new Date().toISOString()
  );
}

export function rejectPrivilegedOperation(db: AppDatabase, input: SecurityRejectionInput, message: string): never {
  recordSecurityRejection(db, input);
  throw new PrivilegedOperationError(input.code, message, input.recovery);
}
