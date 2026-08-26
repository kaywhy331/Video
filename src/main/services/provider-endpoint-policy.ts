import { createHash, timingSafeEqual } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { AppDatabase } from '../database/database';
import type { SecretStore, Secrets } from '../secret-store';
import { formatSecurityError, recordSecurityRejection } from '../security-events';
import type {
  AppSettings,
  ProviderEndpointId,
  ProviderEndpointState,
  ProviderEndpointTrustMode
} from '@shared/types';

interface ProviderDescriptor {
  displayName: string;
  managedBaseUrl: string | null;
  dataCategories: string[];
}

interface ProviderConfiguration {
  provider: ProviderEndpointId;
  baseUrl: string;
  trustMode: ProviderEndpointTrustMode;
  active: boolean;
}

interface BindingRow {
  provider: ProviderEndpointId;
  configured_url: string;
  canonical_origin: string;
  trust_mode: ProviderEndpointTrustMode;
  status: 'confirmed' | 'confirmation_required' | 'blocked';
  credential_fingerprint: string | null;
  trusted_at: string | null;
  updated_at: string;
}

export interface ResolvedProviderAddress {
  address: string;
  family: 4 | 6;
}

export interface ProviderEndpointDependencies {
  resolve?: (hostname: string) => Promise<ResolvedProviderAddress[]>;
  transport?: (
    url: URL,
    init: RequestInit,
    address: ResolvedProviderAddress,
    maxResponseBytes: number
  ) => Promise<Response>;
}

export interface ProviderRequestLimits {
  connectTimeoutMs?: number;
  timeoutMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  maxRedirects?: number;
}

export type ProviderEndpointErrorCode =
  | 'ENDPOINT_INVALID'
  | 'ENDPOINT_UNTRUSTED'
  | 'CREDENTIAL_REQUIRED'
  | 'CREDENTIAL_ORIGIN_MISMATCH'
  | 'LOCAL_CREDENTIAL_FORBIDDEN'
  | 'PRIVATE_ADDRESS_BLOCKED'
  | 'DNS_RESOLUTION_FAILED'
  | 'REDIRECT_BLOCKED'
  | 'REDIRECT_LIMIT'
  | 'REQUEST_TIMEOUT'
  | 'REQUEST_ABORTED'
  | 'REQUEST_TOO_LARGE'
  | 'RESPONSE_TOO_LARGE'
  | 'NETWORK_FAILURE';

function providerEndpointRecovery(code: ProviderEndpointErrorCode): string {
  const recovery: Record<ProviderEndpointErrorCode, string> = {
    ENDPOINT_INVALID: 'Review the provider URL and trust mode, then save a canonical endpoint.',
    ENDPOINT_UNTRUSTED: 'Inspect and explicitly confirm the configured endpoint before retrying.',
    CREDENTIAL_REQUIRED: 'Add the encrypted provider credential, then retry the operation.',
    CREDENTIAL_ORIGIN_MISMATCH: 'Re-enter the credential or reconfirm it for the current endpoint origin.',
    LOCAL_CREDENTIAL_FORBIDDEN: 'Remove the reusable credential before using a loopback provider.',
    PRIVATE_ADDRESS_BLOCKED: 'Use a public remote endpoint or explicitly configure a loopback-only local provider.',
    DNS_RESOLUTION_FAILED: 'Verify DNS and the configured hostname, then confirm the endpoint again.',
    REDIRECT_BLOCKED: 'Use an endpoint that keeps every redirect on the confirmed origin and path.',
    REDIRECT_LIMIT: 'Correct the provider redirect loop or reduce redirects before retrying.',
    REQUEST_TIMEOUT: 'Check provider availability and network connectivity, then retry the operation.',
    REQUEST_ABORTED: 'Retry only if the cancellation was unintended and the provider is still trusted.',
    REQUEST_TOO_LARGE: 'Reduce the request payload or raise the explicit bounded-request limit.',
    RESPONSE_TOO_LARGE: 'Reduce the requested response or raise the explicit bounded-response limit.',
    NETWORK_FAILURE: 'Check provider availability, DNS, and network connectivity before retrying.'
  };
  return recovery[code];
}

export class ProviderEndpointError extends Error {
  readonly recovery: string;

  constructor(
    readonly code: ProviderEndpointErrorCode,
    readonly detail: string,
    recovery = providerEndpointRecovery(code)
  ) {
    super(formatSecurityError(code, detail, recovery));
    this.name = 'ProviderEndpointError';
    this.recovery = recovery;
  }
}

const PROVIDERS: Record<ProviderEndpointId, ProviderDescriptor> = {
  openai_compatible: {
    displayName: 'Language model',
    managedBaseUrl: 'https://api.openai.com/v1',
    dataCategories: ['topic and catalog metadata', 'accepted claims', 'script and editorial constraints']
  },
  openai_compatible_vision: {
    displayName: 'Semantic vision',
    managedBaseUrl: 'https://api.openai.com/v1',
    dataCategories: ['bounded contact-sheet images', 'scene requirements', 'location and visual evidence']
  },
  tavily: {
    displayName: 'Web research',
    managedBaseUrl: 'https://api.tavily.com',
    dataCategories: ['bounded search queries', 'source URLs selected for extraction']
  },
  http_tts: {
    displayName: 'HTTP narration',
    managedBaseUrl: null,
    dataCategories: ['final narration text', 'voice settings', 'pronunciation dictionary']
  }
};

const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderEndpointId[];
const METADATA_HOSTS = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.azure.internal',
  'instance-data',
  'instance-data.ec2.internal'
]);
const METADATA_IPV4 = new Set(['100.100.100.200', '168.63.129.16', '169.254.169.254']);

function configuration(settings: AppSettings, provider: ProviderEndpointId): ProviderConfiguration {
  switch (provider) {
    case 'openai_compatible':
      return {
        provider,
        baseUrl: settings.llmBaseUrl,
        trustMode: settings.llmEndpointTrust ?? inferredTrustMode(provider, settings.llmBaseUrl),
        active: settings.llmProvider === 'openai_compatible'
      };
    case 'openai_compatible_vision':
      return {
        provider,
        baseUrl: settings.visionBaseUrl,
        trustMode: settings.visionEndpointTrust ?? inferredTrustMode(provider, settings.visionBaseUrl),
        active: settings.visionProvider === 'openai_compatible'
      };
    case 'tavily':
      return {
        provider,
        baseUrl: settings.researchBaseUrl,
        trustMode: settings.researchEndpointTrust ?? inferredTrustMode(provider, settings.researchBaseUrl),
        active: settings.researchProvider === 'tavily'
      };
    case 'http_tts':
      return {
        provider,
        baseUrl: settings.narratorBaseUrl,
        trustMode: settings.narratorEndpointTrust ?? inferredTrustMode(provider, settings.narratorBaseUrl),
        active: settings.narratorProvider === 'http_tts'
      };
  }
}

function credential(secrets: Secrets, provider: ProviderEndpointId): string | undefined {
  switch (provider) {
    case 'openai_compatible': return secrets.llmApiKey;
    case 'openai_compatible_vision': return secrets.visionApiKey;
    case 'tavily': return secrets.researchApiKey;
    case 'http_tts': return secrets.httpTtsApiKey;
  }
}

function safeEqual(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function providerCredentialFingerprint(
  provider: ProviderEndpointId,
  canonicalOrigin: string,
  value: string | undefined
): string | null {
  if (!value) return null;
  return createHash('sha256')
    .update('videofactory-provider-credential-v1\0')
    .update(provider)
    .update('\0')
    .update(canonicalOrigin)
    .update('\0')
    .update(value)
    .digest('hex');
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

function parseIpv4(value: string): number[] | null {
  if (isIP(value) !== 4) return null;
  const octets = value.split('.').map(Number);
  return octets.length === 4 && octets.every(octet => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    ? octets
    : null;
}

function parseIpv6(value: string): number[] | null {
  const normalized = stripIpv6Brackets(value).toLowerCase();
  if (isIP(normalized) !== 6) return null;
  let source = normalized;
  const dottedIndex = source.lastIndexOf(':');
  if (source.includes('.') && dottedIndex >= 0) {
    const ipv4 = parseIpv4(source.slice(dottedIndex + 1));
    if (!ipv4) return null;
    source = `${source.slice(0, dottedIndex)}:${((ipv4[0]! << 8) | ipv4[1]!).toString(16)}:${((ipv4[2]! << 8) | ipv4[3]!).toString(16)}`;
  }
  const halves = source.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  const right = halves[1] ? halves[1].split(':').filter(Boolean) : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const words = [...left, ...Array.from({ length: missing }, () => '0'), ...right]
    .map(word => Number.parseInt(word, 16));
  if (words.length !== 8 || words.some(word => !Number.isInteger(word) || word < 0 || word > 0xffff)) return null;
  return words.flatMap(word => [word >> 8, word & 0xff]);
}

function ipv4Category(value: string): 'loopback' | 'blocked' | 'public' | 'invalid' {
  const bytes = parseIpv4(value);
  if (!bytes) return 'invalid';
  const [a, b, c] = bytes as [number, number, number, number];
  if (a === 127) return 'loopback';
  if (METADATA_IPV4.has(value)
    || a === 0
    || a === 10
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224) return 'blocked';
  return 'public';
}

function ipv6Category(value: string): 'loopback' | 'blocked' | 'public' | 'invalid' {
  const bytes = parseIpv6(value);
  if (!bytes) return 'invalid';
  if (bytes.slice(0, 15).every(byte => byte === 0) && bytes[15] === 1) return 'loopback';
  if (bytes.every(byte => byte === 0)
    || (bytes[0]! & 0xfe) === 0xfc
    || (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80)
    || (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0xc0)
    || bytes[0] === 0xff
    || bytes.slice(0, 12).every(byte => byte === 0)
    || (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0 && bytes[3] === 0)
    || (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8)) return 'blocked';
  const mapped = bytes.slice(0, 10).every(byte => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (mapped) return ipv4Category(bytes.slice(12).join('.'));
  const sixToFour = bytes[0] === 0x20 && bytes[1] === 0x02;
  if (sixToFour && ipv4Category(bytes.slice(2, 6).join('.')) !== 'public') return 'blocked';
  const nat64 = bytes.slice(0, 12).every((byte, index) => byte === [0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0][index]);
  if (nat64 && ipv4Category(bytes.slice(12).join('.')) !== 'public') return 'blocked';
  return 'public';
}

export function providerAddressCategory(value: string): 'loopback' | 'blocked' | 'public' | 'invalid' {
  return isIP(stripIpv6Brackets(value)) === 4
    ? ipv4Category(value)
    : ipv6Category(value);
}

function normalizeBaseUrl(value: string): string {
  const raw = value.trim();
  if (!raw || raw.length > 2_000 || raw.includes('\\') || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new ProviderEndpointError('ENDPOINT_INVALID', 'Provider endpoint is malformed. Enter a canonical URL.');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderEndpointError('ENDPOINT_INVALID', 'Provider endpoint is malformed. Enter a canonical URL.');
  }
  const hostname = stripIpv6Brackets(url.hostname).toLowerCase();
  if (!hostname || url.username || url.password || url.hash || url.search
    || hostname.endsWith('.') || hostname.includes('..') || url.host.includes('%')) {
    throw new ProviderEndpointError('ENDPOINT_INVALID', 'Provider endpoint cannot contain credentials, query data, fragments, or an ambiguous host.');
  }
  if (url.port) {
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new ProviderEndpointError('ENDPOINT_INVALID', 'Provider endpoint has an invalid port.');
    }
  }
  url.pathname = url.pathname === '/' ? '/' : url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, url.pathname === '/' ? '/' : '');
}

function staticallyValidate(
  provider: ProviderEndpointId,
  value: string,
  trustMode: ProviderEndpointTrustMode
): { configuredUrl: string; url: URL; canonicalOrigin: string } {
  const configuredUrl = normalizeBaseUrl(value);
  const url = new URL(configuredUrl);
  const hostname = stripIpv6Brackets(url.hostname).toLowerCase();
  const descriptor = PROVIDERS[provider];
  if (METADATA_HOSTS.has(hostname) || hostname.endsWith('.localhost') && trustMode !== 'custom_local') {
    throw new ProviderEndpointError('ENDPOINT_INVALID', 'Remote provider endpoints cannot use local or cloud-metadata hosts.');
  }
  if (trustMode === 'managed') {
    if (!descriptor.managedBaseUrl || normalizeBaseUrl(descriptor.managedBaseUrl) !== configuredUrl) {
      throw new ProviderEndpointError('ENDPOINT_INVALID', `${descriptor.displayName} managed mode requires its fixed vendor endpoint.`);
    }
  }
  if (trustMode === 'custom_local') {
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new ProviderEndpointError('ENDPOINT_INVALID', 'Local provider endpoints must use HTTP or HTTPS.');
    }
    const literalCategory = isIP(hostname) ? providerAddressCategory(hostname) : null;
    if (hostname !== 'localhost' && literalCategory !== 'loopback') {
      throw new ProviderEndpointError('ENDPOINT_INVALID', 'Local provider mode accepts only a loopback endpoint.');
    }
  } else {
    if (url.protocol !== 'https:') {
      throw new ProviderEndpointError('ENDPOINT_INVALID', 'Remote provider endpoints require HTTPS.');
    }
    if (hostname === 'localhost' || METADATA_HOSTS.has(hostname)) {
      throw new ProviderEndpointError('ENDPOINT_INVALID', 'Remote provider endpoints cannot use local or cloud-metadata hosts.');
    }
    if (isIP(hostname) && providerAddressCategory(hostname) !== 'public') {
      throw new ProviderEndpointError('PRIVATE_ADDRESS_BLOCKED', 'Remote provider endpoint resolves to a non-public address.');
    }
  }
  return { configuredUrl, url, canonicalOrigin: url.origin };
}

function inferredTrustMode(provider: ProviderEndpointId, baseUrl: string): ProviderEndpointTrustMode {
  const descriptor = PROVIDERS[provider];
  try {
    if (descriptor.managedBaseUrl && normalizeBaseUrl(descriptor.managedBaseUrl) === normalizeBaseUrl(baseUrl)) return 'managed';
    const hostname = stripIpv6Brackets(new URL(baseUrl).hostname).toLowerCase();
    if (hostname === 'localhost' || providerAddressCategory(hostname) === 'loopback') return 'custom_local';
  } catch {
    // Preserve malformed legacy input for a visible, fail-closed state.
  }
  return 'custom_remote';
}

export function normalizeLegacyProviderEndpointSettings(settings: AppSettings): AppSettings {
  const next = { ...settings };
  for (const provider of PROVIDER_IDS) {
    const current = configuration(next, provider);
    let trustMode = current.trustMode;
    try {
      staticallyValidate(provider, current.baseUrl, trustMode);
    } catch {
      trustMode = inferredTrustMode(provider, current.baseUrl);
    }
    switch (provider) {
      case 'openai_compatible': next.llmEndpointTrust = trustMode; break;
      case 'openai_compatible_vision': next.visionEndpointTrust = trustMode; break;
      case 'tavily': next.researchEndpointTrust = trustMode; break;
      case 'http_tts': next.narratorEndpointTrust = trustMode; break;
    }
  }
  return next;
}

function requestBody(body: BodyInit | null | undefined): Buffer | null {
  if (body === null || body === undefined) return null;
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new ProviderEndpointError('REQUEST_TOO_LARGE', 'Provider request body type is not supported by the bounded transport.');
}

async function boundedResponse(response: Response, maxBytes: number): Promise<Response> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderEndpointError('RESPONSE_TOO_LARGE', 'Provider response exceeded the configured safety limit.');
  }
  if (!response.body) return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ProviderEndpointError('RESPONSE_TOO_LARGE', 'Provider response exceeded the configured safety limit.');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
  return new Response(body.length ? body : null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

function nodeTransport(
  url: URL,
  init: RequestInit,
  address: ResolvedProviderAddress,
  maxResponseBytes: number,
  connectTimeoutMs: number
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const body = requestBody(init.body);
    const headers = new Headers(init.headers);
    headers.delete('host');
    if (body && !headers.has('content-length')) headers.set('content-length', String(body.length));
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
    let settled = false;
    let connectTimer: NodeJS.Timeout | undefined;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      if (connectTimer) clearTimeout(connectTimer);
      operation();
    };
    const req = request(url, {
      method: init.method ?? 'GET',
      headers: Object.fromEntries(headers.entries()),
      signal: init.signal ?? undefined,
      lookup: ((_hostname: string, _options: unknown, callback: (error: Error | null, address: string, family: number) => void) => {
        callback(null, address.address, address.family);
      }) as never
    }, response => {
      if (connectTimer) clearTimeout(connectTimer);
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) value.forEach(item => responseHeaders.append(name, item));
        else if (value !== undefined) responseHeaders.set(name, String(value));
      }
      const declared = Number(responseHeaders.get('content-length'));
      if (Number.isFinite(declared) && declared > maxResponseBytes) {
        response.destroy();
        finish(() => reject(new ProviderEndpointError('RESPONSE_TOO_LARGE', 'Provider response exceeded the configured safety limit.')));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      response.on('data', (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += bytes.length;
        if (total > maxResponseBytes) {
          response.destroy();
          finish(() => reject(new ProviderEndpointError('RESPONSE_TOO_LARGE', 'Provider response exceeded the configured safety limit.')));
          return;
        }
        chunks.push(bytes);
      });
      response.once('end', () => finish(() => resolve(new Response(
        chunks.length ? Buffer.concat(chunks) : null,
        { status: response.statusCode ?? 500, statusText: response.statusMessage, headers: responseHeaders }
      ))));
      response.once('error', error => finish(() => reject(error)));
    });
    connectTimer = setTimeout(() => {
      req.destroy(new ProviderEndpointError('REQUEST_TIMEOUT', 'Provider connection timed out before it was established.'));
    }, connectTimeoutMs);
    connectTimer.unref();
    req.once('socket', socket => {
      if (!socket.connecting) {
        if (connectTimer) clearTimeout(connectTimer);
        return;
      }
      socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
        if (connectTimer) clearTimeout(connectTimer);
      });
    });
    req.once('error', error => finish(() => reject(error)));
    if (body) req.write(body);
    req.end();
  });
}

export class ProviderEndpointPolicy {
  private readonly resolveHost: (hostname: string) => Promise<ResolvedProviderAddress[]>;
  private readonly transport?: ProviderEndpointDependencies['transport'];

  constructor(
    private readonly db: AppDatabase,
    private readonly secrets: SecretStore,
    private readonly settings: () => AppSettings,
    dependencies: ProviderEndpointDependencies = {}
  ) {
    this.resolveHost = dependencies.resolve ?? (async hostname => {
      if (isIP(hostname)) {
        return [{ address: hostname, family: isIP(hostname) as 4 | 6 }];
      }
      const answers = await dnsLookup(hostname, { all: true, verbatim: true });
      return answers.map(answer => ({ address: answer.address, family: answer.family as 4 | 6 }));
    });
    this.transport = dependencies.transport;
    this.reconcileAll();
    this.refreshConfigurationHealth();
  }

  validateSettings(settings: AppSettings): void {
    for (const provider of PROVIDER_IDS) {
      const config = configuration(settings, provider);
      try {
        staticallyValidate(provider, config.baseUrl, config.trustMode);
      } catch (error) {
        this.recordEndpointError(provider, error, 'settings.validation', {
          proposedTrustMode: config.trustMode
        }, false);
        throw error;
      }
    }
  }

  applySettingsChange(previous: AppSettings, next: AppSettings): void {
    this.validateSettings(next);
    const secrets = this.secrets.getAll();
    const now = new Date().toISOString();
    for (const provider of PROVIDER_IDS) {
      const before = configuration(previous, provider);
      const after = configuration(next, provider);
      let prior: { configuredUrl: string; canonicalOrigin: string | null };
      try {
        const validated = staticallyValidate(provider, before.baseUrl, before.trustMode);
        prior = { configuredUrl: validated.configuredUrl, canonicalOrigin: validated.canonicalOrigin };
      } catch {
        prior = { configuredUrl: before.baseUrl, canonicalOrigin: null };
      }
      const current = staticallyValidate(provider, after.baseUrl, after.trustMode);
      const changed = prior.configuredUrl !== current.configuredUrl || before.trustMode !== after.trustMode;
      if (!changed) continue;
      const managed = after.trustMode === 'managed';
      this.upsertBinding({
        provider,
        configuredUrl: current.configuredUrl,
        canonicalOrigin: current.canonicalOrigin,
        trustMode: after.trustMode,
        status: managed ? 'confirmed' : 'confirmation_required',
        credentialFingerprint: managed
          ? providerCredentialFingerprint(provider, current.canonicalOrigin, credential(secrets, provider))
          : null,
        trustedAt: managed ? now : null,
        updatedAt: now
      });
      this.db.raw.prepare('DELETE FROM provider_health WHERE provider = ?').run(provider);
      if (after.active && !managed) {
        this.recordHealth(provider, 'endpoint_untrusted', 'Endpoint confirmation is required before provider data or credentials can be sent.');
      }
      this.audit('provider.endpoint_changed', provider, {
        previousOrigin: prior.canonicalOrigin,
        canonicalOrigin: current.canonicalOrigin,
        trustMode: after.trustMode,
        confirmationRequired: !managed
      });
    }
  }

  reconcileCredentialChanges(providers: ProviderEndpointId[]): void {
    const settings = this.settings();
    const secrets = this.secrets.getAll();
    const now = new Date().toISOString();
    for (const provider of new Set(providers)) {
      const config = configuration(settings, provider);
      let parsed: ReturnType<typeof staticallyValidate>;
      try {
        parsed = staticallyValidate(provider, config.baseUrl, config.trustMode);
      } catch (error) {
        this.recordEndpointError(provider, error, 'credential.reconciliation');
        continue;
      }
      const row = this.binding(provider);
      const matchingConfirmed = row?.status === 'confirmed'
        && row.configured_url === parsed.configuredUrl
        && row.canonical_origin === parsed.canonicalOrigin
        && row.trust_mode === config.trustMode;
      if (config.trustMode === 'managed' || matchingConfirmed) {
        this.upsertBinding({
          provider,
          configuredUrl: parsed.configuredUrl,
          canonicalOrigin: parsed.canonicalOrigin,
          trustMode: config.trustMode,
          status: 'confirmed',
          credentialFingerprint: providerCredentialFingerprint(provider, parsed.canonicalOrigin, credential(secrets, provider)),
          trustedAt: row?.trusted_at ?? now,
          updatedAt: now
        });
        this.db.raw.prepare('DELETE FROM provider_health WHERE provider = ?').run(provider);
        this.audit('provider.credential_binding_updated', provider, {
          canonicalOrigin: parsed.canonicalOrigin,
          trustMode: config.trustMode,
          credentialConfigured: Boolean(credential(secrets, provider))
        });
      }
    }
    this.refreshConfigurationHealth();
  }

  refreshConfigurationHealth(): void {
    const endpointStatuses = [
      'invalid_endpoint',
      'endpoint_untrusted',
      'credential_origin_mismatch'
    ];
    for (const provider of PROVIDER_IDS) {
      const config = configuration(this.settings(), provider);
      const state = this.state(provider);
      if (!config.active || state.ready) {
        this.db.raw.prepare(`
          DELETE FROM provider_health WHERE provider = ?
            AND status IN ('invalid_endpoint','endpoint_untrusted','credential_origin_mismatch')
        `).run(provider);
        continue;
      }
      const status = state.status === 'invalid_endpoint'
        ? 'invalid_endpoint'
        : state.status === 'confirmation_required'
          ? 'endpoint_untrusted'
          : 'credential_origin_mismatch';
      if (endpointStatuses.includes(status)) this.recordHealth(provider, status, state.message);
    }
  }

  states(): ProviderEndpointState[] {
    return PROVIDER_IDS.map(provider => this.state(provider));
  }

  state(provider: ProviderEndpointId): ProviderEndpointState {
    const config = configuration(this.settings(), provider);
    const descriptor = PROVIDERS[provider];
    const secret = credential(this.secrets.getAll(), provider);
    const base = {
      provider,
      displayName: descriptor.displayName,
      configuredUrl: config.baseUrl,
      canonicalOrigin: null,
      trustMode: config.trustMode,
      active: config.active,
      ready: false,
      credentialConfigured: Boolean(secret),
      credentialBound: false,
      dataCategories: [...descriptor.dataCategories],
      trustedAt: null
    };
    let parsed: ReturnType<typeof staticallyValidate>;
    try {
      parsed = staticallyValidate(provider, config.baseUrl, config.trustMode);
    } catch (error) {
      return {
        ...base,
        status: 'invalid_endpoint',
        message: error instanceof ProviderEndpointError ? error.detail : 'Provider endpoint is invalid.'
      };
    }
    const row = this.binding(provider);
    const matching = row
      && row.configured_url === parsed.configuredUrl
      && row.canonical_origin === parsed.canonicalOrigin
      && row.trust_mode === config.trustMode;
    const shared = { ...base, configuredUrl: parsed.configuredUrl, canonicalOrigin: parsed.canonicalOrigin };
    if (!matching || row.status !== 'confirmed') {
      return {
        ...shared,
        status: 'confirmation_required',
        message: 'Confirm this endpoint before any provider request is sent.',
        trustedAt: matching ? row.trusted_at : null
      };
    }
    if (config.trustMode === 'custom_local') {
      if (secret) {
        return {
          ...shared,
          status: 'local_credential_forbidden',
          message: 'Local provider mode cannot use a stored reusable API credential.',
          trustedAt: row.trusted_at
        };
      }
      return {
        ...shared,
        status: 'confirmed',
        ready: true,
        credentialBound: true,
        message: 'Loopback endpoint is confirmed; requests carry no reusable API credential.',
        trustedAt: row.trusted_at
      };
    }
    if (!secret) {
      return {
        ...shared,
        status: 'credential_required',
        message: 'The endpoint is trusted, but its encrypted API credential is not configured.',
        trustedAt: row.trusted_at
      };
    }
    const expected = providerCredentialFingerprint(provider, parsed.canonicalOrigin, secret);
    if (!safeEqual(row.credential_fingerprint, expected)) {
      return {
        ...shared,
        status: 'credential_origin_mismatch',
        message: 'The stored credential is not bound to this confirmed origin; re-enter it or reconfirm the endpoint.',
        trustedAt: row.trusted_at
      };
    }
    return {
      ...shared,
      status: 'confirmed',
      ready: true,
      credentialBound: true,
      message: 'Endpoint and encrypted credential are bound to this canonical origin.',
      trustedAt: row.trusted_at
    };
  }

  isReady(provider: ProviderEndpointId): boolean {
    return this.state(provider).ready;
  }

  async trust(provider: ProviderEndpointId): Promise<ProviderEndpointState> {
    try {
      return await this.trustCandidate(provider);
    } catch (error) {
      const normalized = error instanceof ProviderEndpointError
        ? error
        : new ProviderEndpointError('NETWORK_FAILURE', 'Provider endpoint confirmation failed safely.');
      this.recordEndpointError(provider, normalized, 'endpoint.confirmation');
      throw normalized;
    }
  }

  private async trustCandidate(provider: ProviderEndpointId): Promise<ProviderEndpointState> {
    const config = configuration(this.settings(), provider);
    const parsed = staticallyValidate(provider, config.baseUrl, config.trustMode);
    const secret = credential(this.secrets.getAll(), provider);
    if (config.trustMode === 'custom_local' && secret) {
      throw new ProviderEndpointError('LOCAL_CREDENTIAL_FORBIDDEN', 'Remove the stored API key before confirming a local endpoint.');
    }
    await this.resolveForConfirmation(parsed.url, config.trustMode);
    const now = new Date().toISOString();
    this.upsertBinding({
      provider,
      configuredUrl: parsed.configuredUrl,
      canonicalOrigin: parsed.canonicalOrigin,
      trustMode: config.trustMode,
      status: 'confirmed',
      credentialFingerprint: providerCredentialFingerprint(provider, parsed.canonicalOrigin, secret),
      trustedAt: now,
      updatedAt: now
    });
    this.db.raw.prepare(`
      DELETE FROM provider_health WHERE provider = ?
        AND status IN ('invalid_endpoint','endpoint_untrusted','credential_origin_mismatch')
    `).run(provider);
    this.audit('provider.endpoint_confirmed', provider, {
      canonicalOrigin: parsed.canonicalOrigin,
      trustMode: config.trustMode,
      credentialBound: Boolean(secret),
      dataCategories: PROVIDERS[provider].dataCategories
    });
    this.refreshConfigurationHealth();
    return this.state(provider);
  }

  clearTrust(provider: ProviderEndpointId): ProviderEndpointState {
    const config = configuration(this.settings(), provider);
    const parsed = staticallyValidate(provider, config.baseUrl, config.trustMode);
    const now = new Date().toISOString();
    this.upsertBinding({
      provider,
      configuredUrl: parsed.configuredUrl,
      canonicalOrigin: parsed.canonicalOrigin,
      trustMode: config.trustMode,
      status: config.trustMode === 'managed' ? 'confirmed' : 'confirmation_required',
      credentialFingerprint: config.trustMode === 'managed'
        ? providerCredentialFingerprint(provider, parsed.canonicalOrigin, credential(this.secrets.getAll(), provider))
        : null,
      trustedAt: config.trustMode === 'managed' ? now : null,
      updatedAt: now
    });
    if (config.trustMode !== 'managed') {
      this.recordHealth(provider, 'endpoint_untrusted', 'Endpoint confirmation was cleared; provider calls are blocked.');
    }
    this.audit('provider.endpoint_trust_cleared', provider, {
      canonicalOrigin: parsed.canonicalOrigin,
      trustMode: config.trustMode
    });
    return this.state(provider);
  }

  async request(
    provider: ProviderEndpointId,
    input: string | URL,
    init: RequestInit = {},
    limits: ProviderRequestLimits = {}
  ): Promise<Response> {
    const state = this.state(provider);
    if (!state.ready || !state.canonicalOrigin) {
      const mapping: Record<ProviderEndpointState['status'], ProviderEndpointErrorCode> = {
        confirmed: 'ENDPOINT_UNTRUSTED',
        confirmation_required: 'ENDPOINT_UNTRUSTED',
        invalid_endpoint: 'ENDPOINT_INVALID',
        credential_required: 'CREDENTIAL_REQUIRED',
        credential_origin_mismatch: 'CREDENTIAL_ORIGIN_MISMATCH',
        local_credential_forbidden: 'LOCAL_CREDENTIAL_FORBIDDEN'
      };
      const error = new ProviderEndpointError(mapping[state.status], state.message);
      this.recordEndpointError(provider, error);
      throw error;
    }
    const config = configuration(this.settings(), provider);
    let base: ReturnType<typeof staticallyValidate>;
    try {
      base = staticallyValidate(provider, config.baseUrl, config.trustMode);
    } catch (error) {
      this.recordEndpointError(provider, error);
      throw error;
    }
    let target: URL;
    try {
      target = input instanceof URL ? new URL(input) : new URL(input);
      this.assertRequestTarget(target, base.url, state.canonicalOrigin, config.trustMode);
    } catch (error) {
      const normalized = error instanceof ProviderEndpointError
        ? error
        : new ProviderEndpointError('ENDPOINT_INVALID', 'Provider request target is malformed.');
      this.recordEndpointError(provider, normalized);
      throw normalized;
    }
    const headers = new Headers(init.headers);
    headers.delete('authorization');
    headers.delete('proxy-authorization');
    headers.delete('host');
    const secret = credential(this.secrets.getAll(), provider);
    const credentialSnapshot = providerCredentialFingerprint(provider, state.canonicalOrigin, secret);
    if (config.trustMode !== 'custom_local') {
      if (!secret) {
        const error = new ProviderEndpointError('CREDENTIAL_REQUIRED', 'The provider credential is not configured.');
        this.recordEndpointError(provider, error);
        throw error;
      }
      headers.set('authorization', `Bearer ${secret}`);
    }
    const maxRequestBytes = limits.maxRequestBytes ?? 32 * 1024 * 1024;
    let body: Buffer | null;
    try {
      body = requestBody(init.body);
    } catch (error) {
      this.recordEndpointError(provider, error);
      throw error;
    }
    if (body && body.length > maxRequestBytes) {
      const error = new ProviderEndpointError('REQUEST_TOO_LARGE', 'Provider request exceeded the configured safety limit.');
      this.recordEndpointError(provider, error);
      throw error;
    }
    const timeoutMs = limits.timeoutMs ?? 45_000;
    const connectTimeoutMs = Math.min(limits.connectTimeoutMs ?? 10_000, timeoutMs);
    const maxResponseBytes = limits.maxResponseBytes ?? 8 * 1024 * 1024;
    const maxRedirects = limits.maxRedirects ?? 3;
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    timeout.unref();
    const onExternalAbort = (): void => controller.abort();
    init.signal?.addEventListener('abort', onExternalAbort, { once: true });
    if (init.signal?.aborted) controller.abort();
    const aborted = new Promise<never>((_resolve, reject) => {
      const rejectAbort = (): void => reject(new ProviderEndpointError(
        timedOut ? 'REQUEST_TIMEOUT' : 'REQUEST_ABORTED',
        timedOut ? 'Provider request exceeded its overall timeout.' : 'Provider request was cancelled.'
      ));
      if (controller.signal.aborted) rejectAbort();
      else controller.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    let current = target;
    let method = init.method ?? 'GET';
    let redirects = 0;
    try {
      while (true) {
        const address = await Promise.race([
          this.resolveAndValidate(current, config.trustMode),
          aborted
        ]);
        this.assertRequestSnapshot(provider, base.configuredUrl, config.trustMode, credentialSnapshot);
        const requestInit: RequestInit = {
          ...init,
          method,
          headers,
          body: init.body,
          redirect: 'manual',
          signal: controller.signal
        };
        const responsePromise = this.transport
          ? this.transport(current, requestInit, address, maxResponseBytes)
          : nodeTransport(current, requestInit, address, maxResponseBytes, connectTimeoutMs);
        const response = await Promise.race([
          responsePromise,
          aborted
        ]);
        const bounded = await boundedResponse(response, maxResponseBytes);
        if (![301, 302, 303, 307, 308].includes(bounded.status)) return bounded;
        const location = bounded.headers.get('location');
        if (!location) throw new ProviderEndpointError('REDIRECT_BLOCKED', 'Provider returned a redirect without a valid destination.');
        redirects += 1;
        if (redirects > maxRedirects) throw new ProviderEndpointError('REDIRECT_LIMIT', 'Provider exceeded the redirect safety limit.');
        if (!['GET', 'HEAD'].includes(method.toUpperCase()) && ![307, 308].includes(bounded.status)) {
          throw new ProviderEndpointError('REDIRECT_BLOCKED', 'Provider attempted an unsafe method-changing redirect.');
        }
        const redirected = new URL(location, current);
        this.assertRequestTarget(redirected, base.url, state.canonicalOrigin, config.trustMode);
        current = redirected;
        if (bounded.status === 303) method = 'GET';
      }
    } catch (error) {
      const normalized = error instanceof ProviderEndpointError
        ? error
        : new ProviderEndpointError(
          timedOut ? 'REQUEST_TIMEOUT' : controller.signal.aborted ? 'REQUEST_ABORTED' : 'NETWORK_FAILURE',
          timedOut ? 'Provider request exceeded its overall timeout.' : controller.signal.aborted
            ? 'Provider request was cancelled.'
            : 'Provider request failed before a trusted response was received.'
        );
      this.recordEndpointError(provider, normalized);
      throw normalized;
    } finally {
      clearTimeout(timeout);
      init.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  private reconcileAll(): void {
    const settings = this.settings();
    const secrets = this.secrets.getAll();
    const now = new Date().toISOString();
    for (const provider of PROVIDER_IDS) {
      const config = configuration(settings, provider);
      let parsed: ReturnType<typeof staticallyValidate>;
      try {
        parsed = staticallyValidate(provider, config.baseUrl, config.trustMode);
      } catch (error) {
        this.recordEndpointError(provider, error, 'settings.reconciliation');
        continue;
      }
      const row = this.binding(provider);
      if (config.trustMode === 'managed') {
        this.upsertBinding({
          provider,
          configuredUrl: parsed.configuredUrl,
          canonicalOrigin: parsed.canonicalOrigin,
          trustMode: config.trustMode,
          status: 'confirmed',
          credentialFingerprint: providerCredentialFingerprint(provider, parsed.canonicalOrigin, credential(secrets, provider)),
          trustedAt: row?.trusted_at ?? now,
          updatedAt: now
        });
        continue;
      }
      const matching = row
        && row.configured_url === parsed.configuredUrl
        && row.canonical_origin === parsed.canonicalOrigin
        && row.trust_mode === config.trustMode;
      if (!matching) {
        this.upsertBinding({
          provider,
          configuredUrl: parsed.configuredUrl,
          canonicalOrigin: parsed.canonicalOrigin,
          trustMode: config.trustMode,
          status: 'confirmation_required',
          credentialFingerprint: null,
          trustedAt: null,
          updatedAt: now
        });
      }
    }
  }

  private binding(provider: ProviderEndpointId): BindingRow | undefined {
    return this.db.raw.prepare(`
      SELECT * FROM provider_endpoint_bindings WHERE provider = ?
    `).get(provider) as BindingRow | undefined;
  }

  private upsertBinding(input: {
    provider: ProviderEndpointId;
    configuredUrl: string;
    canonicalOrigin: string;
    trustMode: ProviderEndpointTrustMode;
    status: BindingRow['status'];
    credentialFingerprint: string | null;
    trustedAt: string | null;
    updatedAt: string;
  }): void {
    this.db.raw.prepare(`
      INSERT INTO provider_endpoint_bindings(
        provider, configured_url, canonical_origin, trust_mode, status,
        credential_fingerprint, trusted_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET
        configured_url = excluded.configured_url,
        canonical_origin = excluded.canonical_origin,
        trust_mode = excluded.trust_mode,
        status = excluded.status,
        credential_fingerprint = excluded.credential_fingerprint,
        trusted_at = excluded.trusted_at,
        updated_at = excluded.updated_at
    `).run(
      input.provider, input.configuredUrl, input.canonicalOrigin, input.trustMode,
      input.status, input.credentialFingerprint, input.trustedAt, input.updatedAt
    );
  }

  private async resolveAndValidate(url: URL, trustMode: ProviderEndpointTrustMode): Promise<ResolvedProviderAddress> {
    const hostname = stripIpv6Brackets(url.hostname).toLowerCase();
    let answers: ResolvedProviderAddress[];
    try {
      answers = await this.resolveHost(hostname);
    } catch {
      throw new ProviderEndpointError('DNS_RESOLUTION_FAILED', 'Provider hostname could not be resolved safely.');
    }
    if (!answers.length) throw new ProviderEndpointError('DNS_RESOLUTION_FAILED', 'Provider hostname returned no usable addresses.');
    for (const answer of answers) {
      const category = providerAddressCategory(answer.address);
      if (category === 'invalid'
        || trustMode === 'custom_local' && category !== 'loopback'
        || trustMode !== 'custom_local' && category !== 'public') {
        throw new ProviderEndpointError('PRIVATE_ADDRESS_BLOCKED', trustMode === 'custom_local'
          ? 'Local provider hostname did not resolve exclusively to loopback.'
          : 'Remote provider hostname resolved to a non-public address.');
      }
    }
    return answers[0]!;
  }

  private async resolveForConfirmation(
    url: URL,
    trustMode: ProviderEndpointTrustMode
  ): Promise<ResolvedProviderAddress> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.resolveAndValidate(url, trustMode),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new ProviderEndpointError(
            'REQUEST_TIMEOUT',
            'Provider endpoint confirmation timed out during DNS validation.'
          )), 10_000);
          timer.unref();
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private assertRequestTarget(
    target: URL,
    base: URL,
    canonicalOrigin: string,
    trustMode: ProviderEndpointTrustMode
  ): void {
    const hostname = stripIpv6Brackets(target.hostname).toLowerCase();
    if (target.username || target.password || target.hash || !hostname || target.host.includes('%')) {
      throw new ProviderEndpointError('REDIRECT_BLOCKED', 'Provider request attempted to use an invalid redirect destination.');
    }
    if (trustMode === 'custom_local') {
      const literal = isIP(hostname) ? providerAddressCategory(hostname) : null;
      if (!['http:', 'https:'].includes(target.protocol)
        || hostname !== 'localhost' && literal !== 'loopback') {
        throw new ProviderEndpointError('REDIRECT_BLOCKED', 'Provider request attempted to leave the confirmed loopback endpoint.');
      }
    } else if (target.protocol !== 'https:'
      || hostname === 'localhost'
      || METADATA_HOSTS.has(hostname)
      || isIP(hostname) && providerAddressCategory(hostname) !== 'public') {
      throw new ProviderEndpointError('REDIRECT_BLOCKED', 'Provider request attempted to use an untrusted remote destination.');
    }
    if (target.origin !== canonicalOrigin) {
      throw new ProviderEndpointError('REDIRECT_BLOCKED', 'Provider request attempted to cross the confirmed origin.');
    }
    const basePath = base.pathname === '/' ? '/' : base.pathname.replace(/\/$/, '');
    if (basePath !== '/' && target.pathname !== basePath && !target.pathname.startsWith(`${basePath}/`)) {
      throw new ProviderEndpointError('REDIRECT_BLOCKED', 'Provider request attempted to leave the configured endpoint path.');
    }
  }

  private assertRequestSnapshot(
    provider: ProviderEndpointId,
    configuredUrl: string,
    trustMode: ProviderEndpointTrustMode,
    credentialFingerprint: string | null
  ): void {
    const current = configuration(this.settings(), provider);
    let parsed: ReturnType<typeof staticallyValidate>;
    try {
      parsed = staticallyValidate(provider, current.baseUrl, current.trustMode);
    } catch {
      throw new ProviderEndpointError('ENDPOINT_INVALID', 'Provider endpoint changed while the request was being admitted.');
    }
    const row = this.binding(provider);
    if (!current.active
      || parsed.configuredUrl !== configuredUrl
      || current.trustMode !== trustMode
      || row?.status !== 'confirmed'
      || row.configured_url !== configuredUrl
      || row.canonical_origin !== parsed.canonicalOrigin
      || row.trust_mode !== trustMode) {
      throw new ProviderEndpointError('ENDPOINT_UNTRUSTED', 'Provider endpoint changed while the request was being admitted.');
    }
    const currentCredential = providerCredentialFingerprint(
      provider,
      parsed.canonicalOrigin,
      credential(this.secrets.getAll(), provider)
    );
    if (!safeEqual(currentCredential, credentialFingerprint)
      || !safeEqual(row.credential_fingerprint, credentialFingerprint)) {
      throw new ProviderEndpointError('CREDENTIAL_ORIGIN_MISMATCH', 'Provider credential changed while the request was being admitted.');
    }
  }

  private recordEndpointError(
    provider: ProviderEndpointId,
    error: unknown,
    operation = 'request.admission',
    context: Record<string, unknown> = {},
    updateHealth = true
  ): void {
    const normalized = error instanceof ProviderEndpointError
      ? error
      : new ProviderEndpointError('NETWORK_FAILURE', 'Provider request failed before a trusted response was received.');
    const status = normalized.code === 'ENDPOINT_INVALID' || normalized.code === 'PRIVATE_ADDRESS_BLOCKED'
      ? 'invalid_endpoint'
      : normalized.code === 'ENDPOINT_UNTRUSTED'
        ? 'endpoint_untrusted'
        : normalized.code === 'CREDENTIAL_ORIGIN_MISMATCH' || normalized.code === 'CREDENTIAL_REQUIRED' || normalized.code === 'LOCAL_CREDENTIAL_FORBIDDEN'
          ? 'credential_origin_mismatch'
          : normalized.code === 'REQUEST_TIMEOUT'
            ? 'timeout'
            : 'provider_failure';
    if (updateHealth) this.recordHealth(provider, status, normalized.message, normalized.code);
    this.audit('provider.endpoint_rejected', provider, {
      code: normalized.code,
      canonicalOrigin: this.safeOrigin(provider),
      trustMode: configuration(this.settings(), provider).trustMode
    });
    recordSecurityRejection(this.db, {
      flow: 'provider',
      operation,
      code: normalized.code,
      recovery: normalized.recovery,
      entityType: 'provider_endpoint',
      entityId: provider,
      context: {
        canonicalOrigin: this.safeOrigin(provider),
        trustMode: configuration(this.settings(), provider).trustMode,
        healthStatus: status,
        ...context
      }
    });
  }

  private recordHealth(provider: ProviderEndpointId, status: string, message: string, code?: string): void {
    this.db.raw.prepare(`
      INSERT INTO provider_health(provider, status, status_code, message, checked_at, metadata_json)
      VALUES(?, ?, NULL, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET
        status = excluded.status,
        status_code = excluded.status_code,
        message = excluded.message,
        checked_at = excluded.checked_at,
        metadata_json = excluded.metadata_json
    `).run(provider, status, message, new Date().toISOString(), JSON.stringify(code ? { code } : {}));
  }

  private safeOrigin(provider: ProviderEndpointId): string | null {
    try {
      const config = configuration(this.settings(), provider);
      return staticallyValidate(provider, config.baseUrl, config.trustMode).canonicalOrigin;
    } catch {
      return null;
    }
  }

  private audit(action: string, provider: ProviderEndpointId, metadata: Record<string, unknown>): void {
    this.db.raw.prepare(`
      INSERT INTO audit_log(action, actor, entity_type, entity_id, metadata_json, created_at)
      VALUES(?, 'system', 'provider_endpoint', ?, ?, ?)
    `).run(action, provider, JSON.stringify(metadata), new Date().toISOString());
  }
}
