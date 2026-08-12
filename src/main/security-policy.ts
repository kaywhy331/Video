import { isAbsolute, relative, resolve } from 'node:path';

const EXTERNAL_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'studio.youtube.com',
  'elements.envato.com',
  'envato.com'
]);

export function assertAllowedExternalUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Only credential-free HTTPS URLs may be opened.');
  }
  const allowed = [...EXTERNAL_HOSTS].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
  if (!allowed) throw new Error('External URL is not allowlisted.');
  return url;
}
export function pathIsInside(candidate: string, roots: string[]): boolean {
  if (!isAbsolute(candidate)) return false;
  const resolvedCandidate = resolve(candidate);
  return roots.some(root => {
    const segment = relative(resolve(root), resolvedCandidate);
    return segment === '' || (!segment.startsWith('..') && !isAbsolute(segment));
  });
}

export function isAllowedRendererUrl(url: string, development: boolean): boolean {
  if (development) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    } catch {
      return false;
    }
  }
  return url.startsWith('file://');
}
