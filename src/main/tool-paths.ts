import { existsSync } from 'node:fs';
import { delimiter, resolve as resolvePath } from 'node:path';
import { app } from 'electron';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import type { MediaToolRole } from '@shared/types';

export interface MediaToolPathResolver {
  resolvePath(role: MediaToolRole, configuredPath?: string): string | null;
}

let installedResolver: MediaToolPathResolver | null = null;

function onPath(executable: string): string | null {
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
    : [''];
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    for (const extension of extensions) {
      const candidate = resolvePath(directory || '.', process.platform === 'win32' ? `${executable}${extension}` : executable);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function packagedPath(candidate: string | null): string | null {
  if (!candidate) return null;
  if (!app?.isPackaged) return candidate;
  return candidate.replace('app.asar', 'app.asar.unpacked');
}

export function installMediaToolResolver(resolver: MediaToolPathResolver | null): void {
  installedResolver = resolver;
}

export function bundledMediaToolPath(role: MediaToolRole): string | null {
  const bundled = packagedPath(role === 'ffmpeg' ? ffmpegStatic : ffprobeStatic.path);
  if (bundled && existsSync(bundled)) return bundled;
  return null;
}

export function developmentPathMediaTool(role: MediaToolRole): string | null {
  return app?.isPackaged ? null : onPath(role);
}

function resolveMediaTool(role: MediaToolRole, configured?: string): string | null {
  if (installedResolver) return installedResolver.resolvePath(role, configured);
  return bundledMediaToolPath(role) ?? developmentPathMediaTool(role);
}

export function resolveFfmpeg(configured?: string): string | null {
  return resolveMediaTool('ffmpeg', configured);
}

export function resolveFfprobe(configured?: string): string | null {
  return resolveMediaTool('ffprobe', configured);
}
