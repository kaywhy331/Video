import { describe, expect, it } from 'vitest';
import {
  assertAllowedExternalUrl,
  assertAuthorizedIpcSender,
  isAllowedRendererUrl,
  pathIsInside
} from '@main/security-policy';
import { redactSecrets } from '@main/logger';
import { installNavigationGuards } from '@main/window-security';

describe('desktop security policy', () => {
  it('allows only the explicit HTTPS external-host list', () => {
    expect(assertAllowedExternalUrl('https://elements.envato.com/item/ABC').hostname).toBe('elements.envato.com');
    expect(assertAllowedExternalUrl('https://studio.youtube.com/video/abc').hostname).toBe('studio.youtube.com');
    expect(assertAllowedExternalUrl('https://github.com/kaywhy331/Video/releases').hostname).toBe('github.com');
    for (const unsafe of [
      'http://youtube.com/watch?v=x',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'https://youtube.com.evil.example/watch?v=x',
      'https://user:password@youtube.com/watch?v=x'
    ]) {
      expect(() => assertAllowedExternalUrl(unsafe)).toThrow();
    }
  });

  it('rejects traversal and sibling paths outside managed roots', () => {
    expect(pathIsInside('/data/media/video.mp4', ['/data/media'])).toBe(true);
    expect(pathIsInside('/data/media/../secret.txt', ['/data/media'])).toBe(false);
    expect(pathIsInside('/data/media-other/video.mp4', ['/data/media'])).toBe(false);
    expect(pathIsInside('relative/video.mp4', ['/data/media'])).toBe(false);
  });

  it('accepts local renderer origins only in the correct mode', () => {
    expect(isAllowedRendererUrl('http://localhost:5173/', true)).toBe(true);
    expect(isAllowedRendererUrl('http://evil.example/', true)).toBe(false);
    expect(isAllowedRendererUrl(
      'file:///app/out/renderer/index.html',
      true,
      'file:///app/out/renderer/index.html'
    )).toBe(true);
    expect(isAllowedRendererUrl(
      'file:///app/out/renderer/index.html',
      false,
      'file:///app/out/renderer/index.html'
    )).toBe(true);
    expect(isAllowedRendererUrl(
      'file:///tmp/untrusted.html',
      false,
      'file:///app/out/renderer/index.html'
    )).toBe(false);
    expect(isAllowedRendererUrl('https://example.com', false)).toBe(false);
  });

  it('[SEC-003] rejects IPC from a different webContents, subframe, or renderer URL', () => {
    const mainFrame = { url: 'file:///app/out/renderer/index.html' };
    const authorized = { mainFrame };
    const event = { sender: authorized, senderFrame: mainFrame };
    expect(() => assertAuthorizedIpcSender(
      event,
      authorized,
      false,
      'file:///app/out/renderer/index.html'
    )).not.toThrow();

    expect(() => assertAuthorizedIpcSender(
      { ...event, sender: { mainFrame } },
      authorized,
      false,
      'file:///app/out/renderer/index.html'
    )).toThrow('not authorized');
    expect(() => assertAuthorizedIpcSender(
      { ...event, senderFrame: { url: mainFrame.url } },
      authorized,
      false,
      'file:///app/out/renderer/index.html'
    )).toThrow('not authorized');
    const unsafeFrame = { url: 'file:///tmp/untrusted.html' };
    const unsafeAuthorized = { mainFrame: unsafeFrame };
    expect(() => assertAuthorizedIpcSender(
      { sender: unsafeAuthorized, senderFrame: unsafeFrame },
      unsafeAuthorized,
      false,
      'file:///app/out/renderer/index.html'
    )).toThrow('not authorized');
  });

  it('[SEC-004] denies new windows, navigation, and webview attachment', () => {
    let openHandler: ((details: unknown) => { action: string }) | undefined;
    const listeners = new Map<string, (event: { preventDefault(): void }) => void>();
    const webContents = {
      setWindowOpenHandler: (handler: typeof openHandler) => { openHandler = handler; },
      on: (name: string, listener: (event: { preventDefault(): void }) => void) => {
        listeners.set(name, listener);
      }
    };
    installNavigationGuards(webContents as unknown as Electron.WebContents);

    expect(openHandler?.({})).toEqual({ action: 'deny' });
    for (const eventName of ['will-navigate', 'will-attach-webview']) {
      let prevented = false;
      listeners.get(eventName)?.({ preventDefault: () => { prevented = true; } });
      expect(prevented).toBe(true);
    }
  });

  it('redacts bearer, JSON token, secret, key, and credential URL values', () => {
    const value = redactSecrets({
      authorization: 'Bearer secret-token',
      youtubeAccessToken: 'access-token',
      youtubeRefreshToken: 'refresh-token',
      youtubeClientSecret: 'client-secret',
      llmApiKey: 'api-key',
      endpoint: 'https://user:password@example.com/path'
    });
    for (const secret of ['secret-token', 'access-token', 'refresh-token', 'client-secret', 'api-key', 'password']) {
      expect(value).not.toContain(secret);
    }
  });
});
