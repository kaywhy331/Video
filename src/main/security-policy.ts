import { isAbsolute, relative, resolve } from 'node:path';

const EXTERNAL_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'studio.youtube.com',
  'github.com',
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

export function isAllowedRendererUrl(
  url: string,
  development: boolean,
  productionEntryUrl?: string
): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'file:') {
      if (!productionEntryUrl) return false;
      const expected = new URL(productionEntryUrl);
      parsed.hash = '';
      parsed.search = '';
      expected.hash = '';
      expected.search = '';
      return expected.protocol === 'file:' && parsed.href === expected.href;
    }
    return development
      && parsed.protocol === 'http:'
      && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

export interface IpcSenderFrameLike {
  url: string;
}

export interface IpcSenderContentsLike {
  mainFrame: IpcSenderFrameLike | null;
}

export function assertAuthorizedIpcSender(
  event: {
    sender: IpcSenderContentsLike;
    senderFrame: IpcSenderFrameLike | null;
  },
  authorizedWebContents: IpcSenderContentsLike | null,
  development: boolean,
  productionEntryUrl: string
): void {
  if (!authorizedWebContents || event.sender !== authorizedWebContents) {
    throw new Error('IPC sender is not authorized.');
  }
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('IPC sender is not authorized.');
  }
  if (!isAllowedRendererUrl(event.senderFrame.url, development, productionEntryUrl)) {
    throw new Error('IPC sender is not authorized.');
  }
}
