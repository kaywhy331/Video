import { describe, expect, it } from 'vitest';
import { assertAllowedExternalUrl, isAllowedRendererUrl, pathIsInside } from '@main/security-policy';
import { redactSecrets } from '@main/logger';

describe('desktop security policy', () => {
  it('allows only the explicit HTTPS external-host list', () => {
    expect(assertAllowedExternalUrl('https://elements.envato.com/item/ABC').hostname).toBe('elements.envato.com');
    expect(assertAllowedExternalUrl('https://studio.youtube.com/video/abc').hostname).toBe('studio.youtube.com');
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
    expect(isAllowedRendererUrl('file:///app/out/renderer/index.html', false)).toBe(true);
    expect(isAllowedRendererUrl('https://example.com', false)).toBe(false);
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
