export interface EffectiveResolutionInput {
  sourceWidth: number;
  sourceHeight: number;
  cropWidthFraction?: number;
  cropHeightFraction?: number;
  rotation?: 0 | 90 | 180 | 270;
  treatment?: 'full_screen' | 'inset';
}

export interface EffectiveResolutionResult {
  effectiveWidth: number;
  effectiveHeight: number;
  eligible1080p: boolean;
  eligible4k: boolean;
  requiresUpscale1080p: boolean;
  requiresUpscale4k: boolean;
}

export function calculateEffectiveResolution(input: EffectiveResolutionInput): EffectiveResolutionResult {
  const rotated = input.rotation === 90 || input.rotation === 270;
  const width = rotated ? input.sourceHeight : input.sourceWidth;
  const height = rotated ? input.sourceWidth : input.sourceHeight;
  const effectiveWidth = Math.floor(width * (input.cropWidthFraction ?? 1));
  const effectiveHeight = Math.floor(height * (input.cropHeightFraction ?? 1));
  const fullScreen = (input.treatment ?? 'full_screen') === 'full_screen';
  return {
    effectiveWidth,
    effectiveHeight,
    eligible1080p: !fullScreen || (effectiveWidth >= 1920 && effectiveHeight >= 1080),
    eligible4k: !fullScreen || (effectiveWidth >= 3840 && effectiveHeight >= 2160),
    requiresUpscale1080p: fullScreen && (effectiveWidth < 1920 || effectiveHeight < 1080),
    requiresUpscale4k: fullScreen && (effectiveWidth < 3840 || effectiveHeight < 2160)
  };
}

export function assertShotDuration(durationMs: number, maxMs = 7000): void {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error('Shot duration must be a positive finite number.');
  }
  if (durationMs > maxMs) {
    throw new Error(`Shot duration ${durationMs}ms exceeds hard maximum ${maxMs}ms.`);
  }
}

export function generateSlidingWindows(
  durationMs: number,
  preferredMs: number[] = [3000, 4500, 6000],
  overlapRatio = 0.35,
  maxWindows = 12
): Array<{ startMs: number; endMs: number; durationMs: number }> {
  const windows: Array<{ startMs: number; endMs: number; durationMs: number }> = [];
  if (durationMs < 1500) return windows;

  for (const requested of preferredMs) {
    const length = Math.min(requested, 7000, durationMs);
    const step = Math.max(1000, Math.round(length * (1 - overlapRatio)));
    for (let start = 0; start + 1500 <= durationMs; start += step) {
      const end = Math.min(durationMs, start + length);
      const actual = end - start;
      if (actual >= 1500 && actual <= 7000) {
        windows.push({ startMs: start, endMs: end, durationMs: actual });
      }
      if (windows.length >= maxWindows * 3) break;
      if (end === durationMs) break;
    }
  }

  const unique = new Map<string, { startMs: number; endMs: number; durationMs: number }>();
  for (const window of windows) {
    const key = `${Math.round(window.startMs / 250)}:${Math.round(window.endMs / 250)}`;
    unique.set(key, window);
  }

  return [...unique.values()]
    .sort((a, b) => Math.abs(4500 - a.durationMs) - Math.abs(4500 - b.durationMs) || a.startMs - b.startMs)
    .slice(0, maxWindows);
}

export function fileLooksTemporary(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return lower.endsWith('.crdownload')
    || lower.endsWith('.part')
    || lower.endsWith('.tmp')
    || lower.endsWith('.download');
}
