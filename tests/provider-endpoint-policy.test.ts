import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { buildDefaultSettings } from '@main/app-paths';
import { AppDatabase } from '@main/database/database';
import {
  ProviderEndpointError,
  ProviderEndpointPolicy,
  providerAddressCategory,
  type ProviderEndpointDependencies
} from '@main/services/provider-endpoint-policy';
import type { Secrets } from '@main/secret-store';
import type { AppSettings } from '@shared/types';

const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(options: {
  settings?: (defaults: AppSettings) => AppSettings;
  secrets?: Secrets;
  resolve?: ProviderEndpointDependencies['resolve'];
  transport?: ProviderEndpointDependencies['transport'];
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'videofactory-provider-endpoint-'));
  roots.push(root);
  const db = new AppDatabase(join(root, 'db.sqlite'));
  let settings = options.settings?.(buildDefaultSettings(join(root, 'data'))) ?? buildDefaultSettings(join(root, 'data'));
  let secrets = { ...(options.secrets ?? {}) };
  const transport = options.transport ?? vi.fn(async () => new Response('{}', {
    status: 200,
    headers: { 'content-type': 'application/json' }
  }));
  const policy = new ProviderEndpointPolicy(
    db,
    { getAll: () => ({ ...secrets }) } as never,
    () => settings,
    {
      resolve: options.resolve ?? (async () => [{ address: '93.184.216.34', family: 4 }]),
      transport
    }
  );
  return {
    db,
    policy,
    transport,
    settings: () => settings,
    setSettings: (next: AppSettings) => { settings = next; },
    setSecrets: (next: Secrets) => { secrets = { ...next }; }
  };
}

describe('provider endpoint trust boundary', () => {
  it('[SEC-010] rejects ambiguous, private, metadata, and mixed-DNS remote destinations while allowing public addresses', async () => {
    expect(providerAddressCategory('127.0.0.1')).toBe('loopback');
    expect(providerAddressCategory('::1')).toBe('loopback');
    expect(providerAddressCategory('::ffff:127.0.0.1')).toBe('loopback');
    for (const address of [
      '0.0.0.0', '10.0.0.1', '100.100.100.200', '169.254.169.254',
      '172.16.0.1', '192.168.1.1', '224.0.0.1', '::', 'fc00::1',
      'fe80::1', 'fec0::1', 'ff02::1', '::127.0.0.1', '2001:0::1'
    ]) expect(providerAddressCategory(address), address).toBe('blocked');
    expect(providerAddressCategory('93.184.216.34')).toBe('public');
    expect(providerAddressCategory('2606:2800:220:1:248:1893:25c8:1946')).toBe('public');

    const value = fixture({
      settings: defaults => ({
        ...defaults,
        llmProvider: 'openai_compatible',
        llmBaseUrl: 'https://custom.example/v1',
        llmEndpointTrust: 'custom_remote'
      }),
      secrets: { llmApiKey: 'top-secret' },
      resolve: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '169.254.169.254', family: 4 }
      ]
    });
    await expect(value.policy.trust('openai_compatible')).rejects.toMatchObject({ code: 'PRIVATE_ADDRESS_BLOCKED' });
    expect(value.transport).not.toHaveBeenCalled();

    for (const baseUrl of [
      'http://provider.example/v1',
      'https://user:password@provider.example/v1',
      'https://metadata.google.internal/v1',
      'https://2130706433/v1',
      'https://[::ffff:127.0.0.1]/v1'
    ]) {
      expect(() => value.policy.validateSettings({
        ...value.settings(),
        llmBaseUrl: baseUrl,
        llmEndpointTrust: 'custom_remote'
      }), baseUrl).toThrow(ProviderEndpointError);
    }
    value.db.close();
  });

  it('[SEC-011] blocks unconfirmed and origin-mismatched credentials, then binds an explicit replacement', async () => {
    const value = fixture({
      settings: defaults => ({
        ...defaults,
        llmProvider: 'openai_compatible',
        llmBaseUrl: 'https://first.example/v1',
        llmEndpointTrust: 'custom_remote'
      }),
      secrets: { llmApiKey: 'first-secret' }
    });
    await expect(value.policy.request('openai_compatible', 'https://first.example/v1/chat/completions'))
      .rejects.toMatchObject({ code: 'ENDPOINT_UNTRUSTED' });
    expect(value.transport).not.toHaveBeenCalled();

    expect(await value.policy.trust('openai_compatible')).toMatchObject({ status: 'confirmed', ready: true });
    await value.policy.request('openai_compatible', 'https://first.example/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer renderer-controlled', 'content-type': 'application/json' },
      body: '{}'
    });
    const trustedRequest = vi.mocked(value.transport).mock.calls[0]?.[1];
    expect(new Headers(trustedRequest?.headers).get('authorization')).toBe('Bearer first-secret');

    value.setSecrets({ llmApiKey: 'replacement-secret' });
    expect(value.policy.state('openai_compatible')).toMatchObject({
      status: 'credential_origin_mismatch',
      ready: false
    });
    value.policy.reconcileCredentialChanges(['openai_compatible']);
    expect(value.policy.state('openai_compatible')).toMatchObject({ status: 'confirmed', ready: true });

    const next = { ...value.settings(), llmBaseUrl: 'https://second.example/v1' };
    value.policy.applySettingsChange(value.settings(), next);
    value.setSettings(next);
    expect(value.policy.state('openai_compatible')).toMatchObject({ status: 'confirmation_required', ready: false });
    await expect(value.policy.request('openai_compatible', 'https://second.example/v1/chat/completions'))
      .rejects.toMatchObject({ code: 'ENDPOINT_UNTRUSTED' });
    expect(await value.policy.trust('openai_compatible')).toMatchObject({
      canonicalOrigin: 'https://second.example',
      credentialBound: true,
      ready: true
    });

    const audit = value.db.raw.prepare(`
      SELECT group_concat(coalesce(metadata_json, ''), ' ') AS metadata FROM audit_log
      WHERE entity_type = 'provider_endpoint'
    `).get() as { metadata: string };
    expect(audit.metadata).not.toContain('first-secret');
    expect(audit.metadata).not.toContain('replacement-secret');
    value.db.close();
  });

  it('[SEC-010] permits explicit loopback mode only when no reusable credential is attached', async () => {
    const value = fixture({
      settings: defaults => ({
        ...defaults,
        llmProvider: 'openai_compatible',
        llmBaseUrl: 'http://127.0.0.1:11434/v1',
        llmEndpointTrust: 'custom_local'
      }),
      resolve: async () => [{ address: '127.0.0.1', family: 4 }]
    });
    expect(await value.policy.trust('openai_compatible')).toMatchObject({ status: 'confirmed', ready: true });
    await value.policy.request('openai_compatible', 'http://127.0.0.1:11434/v1/chat/completions', {
      method: 'POST',
      body: '{}'
    });
    const request = vi.mocked(value.transport).mock.calls[0]?.[1];
    expect(new Headers(request?.headers).has('authorization')).toBe(false);

    value.setSecrets({ llmApiKey: 'must-not-cross-local-boundary' });
    value.policy.reconcileCredentialChanges(['openai_compatible']);
    expect(value.policy.state('openai_compatible')).toMatchObject({
      status: 'local_credential_forbidden',
      ready: false
    });
    await expect(value.policy.request('openai_compatible', 'http://127.0.0.1:11434/v1/chat/completions'))
      .rejects.toMatchObject({ code: 'LOCAL_CREDENTIAL_FORBIDDEN' });
    value.db.close();
  });

  it('blocks DNS rebinding and a settings change that races request admission', async () => {
    let lookupCount = 0;
    const rebound = fixture({
      settings: defaults => ({
        ...defaults,
        llmProvider: 'openai_compatible',
        llmBaseUrl: 'https://rebind.example/v1',
        llmEndpointTrust: 'custom_remote'
      }),
      secrets: { llmApiKey: 'secret' },
      resolve: async () => lookupCount++ === 0
        ? [{ address: '93.184.216.34', family: 4 }]
        : [{ address: '127.0.0.1', family: 4 }]
    });
    await rebound.policy.trust('openai_compatible');
    await expect(rebound.policy.request('openai_compatible', 'https://rebind.example/v1/chat/completions'))
      .rejects.toMatchObject({ code: 'PRIVATE_ADDRESS_BLOCKED' });
    expect(rebound.transport).not.toHaveBeenCalled();
    rebound.db.close();

    let releaseLookup!: (answers: Array<{ address: string; family: 4 }>) => void;
    let markLookupStarted!: () => void;
    const lookupStarted = new Promise<void>(resolve => { markLookupStarted = resolve; });
    const raced = fixture({
      settings: defaults => ({ ...defaults, llmProvider: 'openai_compatible' }),
      secrets: { llmApiKey: 'secret' },
      resolve: async () => {
        markLookupStarted();
        return new Promise(resolve => { releaseLookup = resolve; });
      }
    });
    const pending = raced.policy.request('openai_compatible', 'https://api.openai.com/v1/chat/completions');
    await lookupStarted;
    const changed = {
      ...raced.settings(),
      llmBaseUrl: 'https://replacement.example/v1',
      llmEndpointTrust: 'custom_remote' as const
    };
    raced.policy.applySettingsChange(raced.settings(), changed);
    raced.setSettings(changed);
    releaseLookup([{ address: '93.184.216.34', family: 4 }]);
    await expect(pending).rejects.toMatchObject({ code: 'ENDPOINT_UNTRUSTED' });
    expect(raced.transport).not.toHaveBeenCalled();
    raced.db.close();
  });

  it('[JOB-010] revalidates redirects and enforces redirect, timeout, abort, and response-size bounds', async () => {
    const crossOrigin = vi.fn(async () => new Response(null, {
      status: 307,
      headers: { location: 'https://redirect.example/v1/chat/completions' }
    }));
    const rejected = fixture({
      settings: defaults => ({
        ...defaults,
        llmProvider: 'openai_compatible',
        llmBaseUrl: 'https://api.openai.com/v1',
        llmEndpointTrust: 'managed'
      }),
      secrets: { llmApiKey: 'secret' },
      transport: crossOrigin
    });
    await expect(rejected.policy.request('openai_compatible', 'https://api.openai.com/v1/chat/completions', {
      method: 'POST', body: '{}'
    })).rejects.toMatchObject({ code: 'REDIRECT_BLOCKED' });
    expect(crossOrigin).toHaveBeenCalledOnce();
    rejected.db.close();

    const redirectLoop = fixture({
      settings: defaults => ({ ...defaults, llmProvider: 'openai_compatible' }),
      secrets: { llmApiKey: 'secret' },
      transport: async () => new Response(null, {
        status: 307,
        headers: { location: 'https://api.openai.com/v1/chat/completions' }
      })
    });
    await expect(redirectLoop.policy.request('openai_compatible', 'https://api.openai.com/v1/chat/completions', {}, {
      maxRedirects: 1
    })).rejects.toMatchObject({ code: 'REDIRECT_LIMIT' });
    redirectLoop.db.close();

    const oversized = fixture({
      settings: defaults => ({ ...defaults, llmProvider: 'openai_compatible' }),
      secrets: { llmApiKey: 'secret' },
      transport: async () => new Response('12345')
    });
    await expect(oversized.policy.request('openai_compatible', 'https://api.openai.com/v1/chat/completions', {}, {
      maxResponseBytes: 4
    })).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
    oversized.db.close();

    const timeout = fixture({
      settings: defaults => ({ ...defaults, llmProvider: 'openai_compatible' }),
      secrets: { llmApiKey: 'secret' },
      transport: async () => new Promise<Response>(() => undefined)
    });
    await expect(timeout.policy.request('openai_compatible', 'https://api.openai.com/v1/chat/completions', {}, {
      timeoutMs: 20
    })).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
    expect(timeout.db.raw.prepare(`SELECT status FROM provider_health WHERE provider = 'openai_compatible'`).get())
      .toEqual({ status: 'timeout' });
    timeout.db.close();

    const aborted = fixture({
      settings: defaults => ({ ...defaults, llmProvider: 'openai_compatible' }),
      secrets: { llmApiKey: 'secret' },
      transport: async () => new Promise<Response>(() => undefined)
    });
    const controller = new AbortController();
    const pending = aborted.policy.request(
      'openai_compatible',
      'https://api.openai.com/v1/chat/completions',
      { signal: controller.signal },
      { timeoutMs: 2_000 }
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_ABORTED' });
    aborted.db.close();
  });

  it('[JOB-010] pins the validated address in the real bounded transport and follows only a same-origin redirect', async () => {
    const requests: Array<{ url: string; authorization: string | undefined }> = [];
    const server = createServer((request, response) => {
      requests.push({ url: request.url ?? '', authorization: request.headers.authorization });
      if (request.url === '/v1/start') {
        response.writeHead(307, { location: '/v1/final' });
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Loopback test server did not expose a TCP port.');
    const root = mkdtempSync(join(tmpdir(), 'videofactory-provider-real-transport-'));
    roots.push(root);
    const db = new AppDatabase(join(root, 'db.sqlite'));
    const settings = {
      ...buildDefaultSettings(join(root, 'data')),
      llmProvider: 'openai_compatible' as const,
      llmBaseUrl: `http://127.0.0.1:${address.port}/v1`,
      llmEndpointTrust: 'custom_local' as const
    };
    const policy = new ProviderEndpointPolicy(
      db,
      { getAll: () => ({}) } as never,
      () => settings
    );
    try {
      await policy.trust('openai_compatible');
      const response = await policy.request(
        'openai_compatible',
        `http://127.0.0.1:${address.port}/v1/start`,
        { method: 'POST', body: '{}' },
        { timeoutMs: 2_000 }
      );
      expect(await response.json()).toEqual({ ok: true });
      expect(requests).toEqual([
        { url: '/v1/start', authorization: undefined },
        { url: '/v1/final', authorization: undefined }
      ]);
    } finally {
      db.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
