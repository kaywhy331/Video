import { app } from 'electron';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AppSettings } from '@shared/types';
import { resolveFfmpeg, resolveFfprobe } from '../tool-paths';
import { requireSuccess } from './process-utils';

function resourcePath(name: string): string {
  const candidates = [
    join(process.cwd(), 'resources', name),
    join(app.getAppPath(), 'resources', name),
    join(process.resourcesPath, 'resources', name),
    join(process.resourcesPath, name)
  ];
  const found = candidates.find(existsSync);
  if (!found) throw new Error(`Resource not found: ${name}`);
  return found;
}

export class TtsService {
  constructor(private readonly settings: () => AppSettings) {}

  async synthesize(text: string, outputPath: string): Promise<{ durationMs: number }> {
    mkdirSync(dirname(outputPath), { recursive: true });
    const settings = this.settings();
    if (settings.narratorProvider !== 'windows_sapi') {
      throw new Error('Only the built-in Windows SAPI voice provider is implemented in this alpha.');
    }
    if (process.platform !== 'win32') {
      return this.synthesizeDevelopmentTone(text, outputPath);
    }

    const textPath = outputPath.replace(/\.[^.]+$/, '.txt');
    writeFileSync(textPath, text, 'utf8');
    const powershell = process.env.SystemRoot
      ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe';
    await requireSuccess(powershell, [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', resourcePath('sapi-tts.ps1'),
      '-TextPath', textPath,
      '-OutputPath', outputPath,
      '-VoiceName', settings.narratorVoice,
      '-Rate', String(settings.narratorRate),
      '-Volume', '100'
    ]);
    return { durationMs: await this.probeDuration(outputPath) };
  }

  private async synthesizeDevelopmentTone(text: string, outputPath: string): Promise<{ durationMs: number }> {
    const ffmpeg = resolveFfmpeg(this.settings().ffmpegPath);
    if (!ffmpeg) throw new Error('Windows SAPI is unavailable and FFmpeg was not found for development audio.');
    const words = Math.max(1, text.trim().split(/\s+/).length);
    const durationSeconds = Math.min(7, Math.max(1.8, words / 2.7));
    await requireSuccess(ffmpeg, [
      '-y', '-hide_banner',
      '-f', 'lavfi',
      '-i', `anullsrc=channel_layout=stereo:sample_rate=48000`,
      '-t', String(durationSeconds),
      '-c:a', 'pcm_s16le',
      outputPath
    ]);
    return { durationMs: Math.round(durationSeconds * 1000) };
  }

  async probeDuration(path: string): Promise<number> {
    const ffprobe = resolveFfprobe(this.settings().ffprobePath);
    if (!ffprobe) throw new Error('FFprobe is unavailable.');
    const result = await requireSuccess(ffprobe, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      path
    ]);
    return Math.round(Number(result.stdout.trim()) * 1000);
  }
}
