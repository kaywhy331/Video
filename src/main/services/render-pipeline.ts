import { requireSuccess } from './process-utils';
import { musicMixFilter, type MusicMixPolicy } from '@shared/audio-policy';

export interface LoudnormMeasurement {
  inputI: string;
  inputTp: string;
  inputLra: string;
  inputThresh: string;
  targetOffset: string;
}

export function loudnormStats(stderr: string): LoudnormMeasurement {
  const match = stderr.match(/\{\s*"input_i"[\s\S]*?\}/g)?.at(-1);
  if (!match) throw new Error('FFmpeg did not return measurable loudness statistics.');
  const parsed = JSON.parse(match) as Record<string, string>;
  for (const key of ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset']) {
    if (!parsed[key] || parsed[key] === '-inf' || parsed[key] === 'inf') {
      throw new Error(`Final audio loudness measurement ${key} is invalid.`);
    }
  }
  return {
    inputI: parsed.input_i!,
    inputTp: parsed.input_tp!,
    inputLra: parsed.input_lra!,
    inputThresh: parsed.input_thresh!,
    targetOffset: parsed.target_offset!
  };
}

export async function assembleAndNormalizeTimeline(options: {
  ffmpeg: string;
  concatPath: string;
  assembledPath: string;
  outputPath: string;
  audioBitrate: '192k' | '384k';
  music?: { path: string; durationMs: number; policy: MusicMixPolicy };
}): Promise<LoudnormMeasurement> {
  await requireSuccess(options.ffmpeg, [
    '-y', '-hide_banner',
    '-f', 'concat', '-safe', '0', '-i', options.concatPath,
    '-c', 'copy', '-movflags', '+faststart', options.assembledPath
  ]);
  const measurementFilter = 'loudnorm=I=-14:TP=-1:LRA=11:print_format=json';
  const mix = options.music ? musicMixFilter(options.music.policy, options.music.durationMs) : null;
  const firstPass = await requireSuccess(options.ffmpeg, options.music ? [
    '-hide_banner', '-nostats', '-i', options.assembledPath,
    '-stream_loop', '-1', '-i', options.music.path,
    '-filter_complex', `${mix};[mix]${measurementFilter}[measure]`,
    '-map', '[measure]', '-f', 'null', '-'
  ] : [
    '-hide_banner', '-nostats', '-i', options.assembledPath,
    '-map', '0:a:0', '-af', measurementFilter, '-f', 'null', '-'
  ]);
  const measured = loudnormStats(firstPass.stderr);
  const normalizeFilter = `loudnorm=I=-14:TP=-1:LRA=11:measured_I=${measured.inputI}:measured_TP=${measured.inputTp}:measured_LRA=${measured.inputLra}:measured_thresh=${measured.inputThresh}:offset=${measured.targetOffset}:linear=true`;
  await requireSuccess(options.ffmpeg, options.music ? [
    '-y', '-hide_banner', '-i', options.assembledPath,
    '-stream_loop', '-1', '-i', options.music.path,
    '-filter_complex', `${mix};[mix]${normalizeFilter}[normalized]`,
    '-map', '0:v:0', '-map', '[normalized]', '-c:v', 'copy',
    '-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', options.audioBitrate,
    '-ar', '48000', '-ac', '2', '-t', (options.music.durationMs / 1000).toFixed(3),
    '-movflags', '+faststart', options.outputPath
  ] : [
    '-y', '-hide_banner', '-i', options.assembledPath,
    '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy',
    '-af', normalizeFilter,
    '-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', options.audioBitrate,
    '-ar', '48000', '-ac', '2', '-movflags', '+faststart', options.outputPath
  ]);
  return measured;
}
