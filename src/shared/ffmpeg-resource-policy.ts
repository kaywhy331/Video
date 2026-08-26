export const FFMPEG_BACKGROUND_RESOURCE_POLICY = 'interactive-reserve-v1' as const;

const RESERVED_INTERACTIVE_LOGICAL_CPUS = 2;
const MAXIMUM_BACKGROUND_FFMPEG_THREADS = 8;

export function backgroundFfmpegThreadCount(logicalCpuCount: number): number {
  const normalizedCpuCount = Number.isFinite(logicalCpuCount)
    ? Math.max(1, Math.floor(logicalCpuCount))
    : 1;
  return Math.max(
    1,
    Math.min(MAXIMUM_BACKGROUND_FFMPEG_THREADS, normalizedCpuCount - RESERVED_INTERACTIVE_LOGICAL_CPUS)
  );
}

export function backgroundFfmpegGlobalArguments(logicalCpuCount: number): string[] {
  const threads = String(backgroundFfmpegThreadCount(logicalCpuCount));
  return ['-filter_threads', threads, '-filter_complex_threads', threads];
}

export function backgroundFfmpegVideoArguments(logicalCpuCount: number): string[] {
  return ['-threads', String(backgroundFfmpegThreadCount(logicalCpuCount))];
}
