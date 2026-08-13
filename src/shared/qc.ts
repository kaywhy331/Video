export interface QcTimelineShot {
  sceneId: string;
  ordinal: number;
  sourceHash: string;
  sourceStartMs: number;
  sourceEndMs: number;
  sourceWidth: number;
  sourceHeight: number;
  outputWidth: number;
  outputHeight: number;
  generatedGraphic: boolean;
}

export interface ChapterValidation {
  invalidLineIndexes: number[];
  nonMonotonicIndexes: number[];
  outOfBoundsIndexes: number[];
  startsAtZero: boolean;
}

export interface DuplicateShotPair {
  leftOrdinal: number;
  rightOrdinal: number;
  sourceHash: string;
  overlapRatio: number;
}

export function cropRetentionFraction(
  sourceWidth: number,
  sourceHeight: number,
  outputWidth: number,
  outputHeight: number
): number {
  if (![sourceWidth, sourceHeight, outputWidth, outputHeight].every(value => Number.isFinite(value) && value > 0)) return 0;
  const sourceAspect = sourceWidth / sourceHeight;
  const outputAspect = outputWidth / outputHeight;
  return Math.min(sourceAspect / outputAspect, outputAspect / sourceAspect);
}

export function duplicateShotPairs(shots: QcTimelineShot[], threshold = 0.6): DuplicateShotPair[] {
  const duplicates: DuplicateShotPair[] = [];
  for (let leftIndex = 0; leftIndex < shots.length; leftIndex += 1) {
    const left = shots[leftIndex]!;
    if (left.generatedGraphic) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < shots.length; rightIndex += 1) {
      const right = shots[rightIndex]!;
      if (right.generatedGraphic || left.sourceHash !== right.sourceHash) continue;
      const overlap = Math.max(0, Math.min(left.sourceEndMs, right.sourceEndMs) - Math.max(left.sourceStartMs, right.sourceStartMs));
      const shorter = Math.max(1, Math.min(left.sourceEndMs - left.sourceStartMs, right.sourceEndMs - right.sourceStartMs));
      const overlapRatio = overlap / shorter;
      if (overlapRatio >= threshold) duplicates.push({
        leftOrdinal: left.ordinal,
        rightOrdinal: right.ordinal,
        sourceHash: left.sourceHash,
        overlapRatio
      });
    }
  }
  return duplicates;
}

export function severeCropOrdinals(shots: QcTimelineShot[], minimumRetention = 0.72): number[] {
  return [...new Set(shots
    .filter(shot => !shot.generatedGraphic && cropRetentionFraction(
      shot.sourceWidth,
      shot.sourceHeight,
      shot.outputWidth,
      shot.outputHeight
    ) < minimumRetention)
    .map(shot => shot.ordinal))];
}

export function insufficientResolutionOrdinals(shots: QcTimelineShot[]): number[] {
  return [...new Set(shots.flatMap(shot => {
    if (shot.generatedGraphic) return [];
    const sourceAspect = shot.sourceWidth / shot.sourceHeight;
    const outputAspect = shot.outputWidth / shot.outputHeight;
    const retainedWidth = sourceAspect >= outputAspect
      ? shot.sourceHeight * outputAspect
      : shot.sourceWidth;
    const retainedHeight = sourceAspect >= outputAspect
      ? shot.sourceHeight
      : shot.sourceWidth / outputAspect;
    return retainedWidth + 0.5 < shot.outputWidth || retainedHeight + 0.5 < shot.outputHeight
      ? [shot.ordinal]
      : [];
  }))];
}

export function unsafePromiseIndexes(
  packages: Array<{ title: string; viewerPromise: string }>
): number[] {
  const unsupportedAbsolutes = /\b(best|greatest|most|only|every|guaranteed|ultimate|really|exact(?:ly)?)\b/i;
  return packages.flatMap((candidate, index) => {
    const title = candidate.title.trim();
    const promise = candidate.viewerPromise.trim();
    return !title || title.length > 100 || !promise || unsupportedAbsolutes.test(`${title} ${promise}`)
      ? [index]
      : [];
  });
}

export function validateChapters(chapters: string, durationMs: number): ChapterValidation {
  const lines = chapters.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const invalidLineIndexes: number[] = [];
  const nonMonotonicIndexes: number[] = [];
  const outOfBoundsIndexes: number[] = [];
  const timestamps: number[] = [];
  lines.forEach((line, index) => {
    const match = line.match(/^(\d+):([0-5]\d)\s+(.+)$/);
    if (!match) {
      invalidLineIndexes.push(index);
      return;
    }
    const atMs = (Number(match[1]) * 60 + Number(match[2])) * 1000;
    timestamps.push(atMs);
    if (atMs > durationMs + 999) outOfBoundsIndexes.push(index);
    const previous = timestamps.at(-2);
    if (previous !== undefined && atMs <= previous) nonMonotonicIndexes.push(index);
  });
  return {
    invalidLineIndexes,
    nonMonotonicIndexes,
    outOfBoundsIndexes,
    startsAtZero: timestamps[0] === 0
  };
}

export function silenceViolations(
  intervals: Array<{ startMs: number; endMs: number }>,
  durationMs: number,
  maximumIntervalMs = 1_800,
  maximumCoverage = 0.12
): { excessive: boolean; longestMs: number; coverage: number } {
  const valid = intervals.filter(interval => interval.endMs > interval.startMs);
  const longestMs = valid.reduce((longest, interval) => Math.max(longest, interval.endMs - interval.startMs), 0);
  const total = valid.reduce((sum, interval) => sum + interval.endMs - interval.startMs, 0);
  const coverage = durationMs > 0 ? Math.min(1, total / durationMs) : 1;
  return {
    excessive: longestMs > maximumIntervalMs || (durationMs >= 10_000 && coverage > maximumCoverage),
    longestMs,
    coverage
  };
}

export function captionViolations(cues: Array<{ text: string; startMs: number; endMs: number }>, durationMs: number): {
  overlapIndexes: number[];
  lineLimitIndexes: number[];
  outOfBoundsIndexes: number[];
} {
  const overlapIndexes: number[] = [];
  const lineLimitIndexes: number[] = [];
  const outOfBoundsIndexes: number[] = [];
  cues.forEach((cue, index) => {
    if (index > 0 && cue.startMs < cues[index - 1]!.endMs) overlapIndexes.push(index);
    if (cue.text.length > 42 || cue.text.split(/\s+/).some(word => word.length > 32)) lineLimitIndexes.push(index);
    if (cue.startMs < 0 || cue.endMs <= cue.startMs || cue.endMs > durationMs + 250) outOfBoundsIndexes.push(index);
  });
  return { overlapIndexes, lineLimitIndexes, outOfBoundsIndexes };
}
