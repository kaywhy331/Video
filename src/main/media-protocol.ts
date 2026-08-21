import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { pathIsInside } from './security-policy';

export interface MediaProtocolRoots {
  mediaLibraryFolder: string;
  projectFolder: string;
  outputFolder: string;
}

export interface MediaProtocolLookups {
  render: (id: string) => string | null;
  proxy: (id: string) => string | null;
  thumbnail: (id: string) => string | null;
  captionManifest: (id: string) => string | null;
}

export type ResolvedMediaRequest =
  | { status: 200; kind: 'file' | 'caption'; path: string }
  | { status: 400 | 404; message: string };

const MEDIA_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export function captionPathFromManifest(
  manifestPath: string | null | undefined,
  projectFolder: string
): string | null {
  if (!manifestPath || !pathIsInside(manifestPath, [projectFolder]) || !existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      captions?: { vttPath?: unknown };
    };
    const path = typeof manifest.captions?.vttPath === 'string' ? manifest.captions.vttPath : null;
    if (!path || extname(path).toLowerCase() !== '.vtt') return null;
    return existsSync(path) && pathIsInside(path, [projectFolder]) ? path : null;
  } catch {
    return null;
  }
}

export function resolveMediaRequest(
  requestUrl: string,
  roots: MediaProtocolRoots,
  lookups: MediaProtocolLookups
): ResolvedMediaRequest {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return { status: 400, message: 'Malformed media URL.' };
  }
  if (url.protocol !== 'videofactory:' || url.username || url.password || url.search || url.hash) {
    return { status: 400, message: 'Malformed media URL.' };
  }
  const type = url.hostname as 'render' | 'proxy' | 'thumbnail' | 'caption';
  if (!['render', 'proxy', 'thumbnail', 'caption'].includes(type)) {
    return { status: 404, message: 'Unsupported media type.' };
  }
  let id: string;
  try {
    id = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  } catch {
    return { status: 400, message: 'Malformed media identifier.' };
  }
  if (!MEDIA_ID.test(id) || id.includes('/') || id.includes('\\')) {
    return { status: 400, message: 'Malformed media identifier.' };
  }

  const caption = type === 'caption';
  const candidate = type === 'caption'
    ? captionPathFromManifest(lookups.captionManifest(id), roots.projectFolder)
    : lookups[type](id);
  const allowedRoots = caption
    ? [roots.projectFolder]
    : [roots.mediaLibraryFolder, roots.projectFolder, roots.outputFolder];
  if (!candidate || !existsSync(candidate) || !pathIsInside(candidate, allowedRoots)) {
    return { status: 404, message: 'Media not found.' };
  }
  return { status: 200, kind: caption ? 'caption' : 'file', path: candidate };
}
