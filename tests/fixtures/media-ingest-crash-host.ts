import { resolve } from 'node:path';
import { writeSync } from 'node:fs';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { AppDatabase } from '@main/database/database';
import { MediaService } from '@main/services/media-service';
import type { AppSettings } from '@shared/types';

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

const root = resolve(requiredEnvironment('VIDEOFACTORY_INGEST_CRASH_ROOT'));
if (!ffmpegPath) throw new Error('ffmpeg-static binary is unavailable.');

const database = new AppDatabase(resolve(root, 'db.sqlite'));
const settings = () => ({
  ingestFolder: resolve(root, 'ingest'),
  mediaLibraryFolder: resolve(root, 'media'),
  ffmpegPath,
  ffprobePath: ffprobeStatic.path
} as AppSettings);
const media = new MediaService(
  database,
  settings,
  {} as never,
  (_projectId, phase) => {
    if (phase !== 'proxy') return;
    writeSync(1, 'VIDEOFACTORY_INGEST_CHECKPOINT_READY\n');
    process.kill(process.pid, 'SIGKILL');
  }
);

await media.ingestAcquisition('acquisition-1', resolve(root, 'ingest', 'crash-source.mp4'));
throw new Error('Crash fixture reached the end of ingest without being forcibly terminated.');
