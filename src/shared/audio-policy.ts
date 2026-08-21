export interface MusicMixPolicy {
  targetGainDb: number;
  duckingDb: number;
  fadeInMs: number;
  fadeOutMs: number;
}

export function validateMusicMixPolicy(policy: MusicMixPolicy, durationMs: number): void {
  if (policy.targetGainDb < -40 || policy.targetGainDb > -12) throw new Error('Music gain is outside the safe background range.');
  if (policy.duckingDb < -30 || policy.duckingDb > -6) throw new Error('Music ducking is outside the safe narration range.');
  if (policy.fadeInMs < 250 || policy.fadeOutMs < 250) throw new Error('Music fades must be at least 250ms.');
  if (durationMs <= policy.fadeInMs + policy.fadeOutMs) throw new Error('Music duration is too short for the configured edge fades.');
}

export function musicMixFilter(policy: MusicMixPolicy, durationMs: number): string {
  validateMusicMixPolicy(policy, durationMs);
  const targetVolume = 10 ** (policy.targetGainDb / 20);
  const compressionRatio = Math.max(2, Math.min(20, Math.abs(policy.duckingDb)));
  const fadeOutStart = Math.max(0, durationMs - policy.fadeOutMs) / 1000;
  return [
    `[1:a]atrim=0:${(durationMs / 1000).toFixed(3)},asetpts=PTS-STARTPTS,aresample=48000,volume=${targetVolume.toFixed(6)},afade=t=in:st=0:d=${(policy.fadeInMs / 1000).toFixed(3)},afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${(policy.fadeOutMs / 1000).toFixed(3)}[music]`,
    `[music][0:a]sidechaincompress=threshold=0.02:ratio=${compressionRatio.toFixed(2)}:attack=20:release=350:makeup=1[ducked]`,
    `[0:a][ducked]amix=inputs=2:duration=first:dropout_transition=0,alimiter=limit=0.891251[mix]`
  ].join(';');
}

export function abruptMusicCut(durationMs: number, fadeOutMs: number): boolean {
  return durationMs > 0 && fadeOutMs < Math.min(750, Math.max(250, durationMs * 0.05));
}
