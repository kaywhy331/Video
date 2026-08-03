import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { app } from 'electron';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

function onPath(executable: string): string | null {
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
    : [''];
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    for (const extension of extensions) {
      const candidate = join(directory, process.platform === 'win32' ? `${executable}${extension}` : executable);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function packagedPath(candidate: string | null): string | null {
  if (!candidate) return null;
  if (!app.isPackaged) return candidate;
  return candidate.replace('app.asar', 'app.asar.unpacked');
}

export function resolveFfmpeg(configured?: string): string | null {
  if (configured && existsSync(configured)) return configured;
  const bundled = packagedPath(ffmpegStatic);
  if (bundled && existsSync(bundled)) return bundled;
  return onPath('ffmpeg');
}

export function resolveFfprobe(configured?: string): string | null {
  if (configured && existsSync(configured)) return configured;
  const bundled = packagedPath(ffprobeStatic.path);
  if (bundled && existsSync(bundled)) return bundled;
  return onPath('ffprobe');
}
