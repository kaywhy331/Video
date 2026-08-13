export interface TimeInterval {
  startMs: number;
  endMs: number;
}
function seconds(value: string): number {
  return Math.max(0, Number.parseFloat(value) * 1000);
}

export function parseBlackIntervals(output: string): TimeInterval[] {
  const intervals: TimeInterval[] = [];
  const pattern = /black_start:([0-9.]+)\s+black_end:([0-9.]+)/g;
  for (const match of output.matchAll(pattern)) {
    const startMs = seconds(match[1] ?? '0');
    const endMs = seconds(match[2] ?? '0');
    if (endMs > startMs) intervals.push({ startMs, endMs });
  }
  return intervals;
}

export function parseFreezeIntervals(output: string, mediaDurationMs?: number): TimeInterval[] {
  const events = [...output.matchAll(/freeze_(start|end):\s*([0-9.]+)/g)]
    .map(match => ({ kind: match[1], atMs: seconds(match[2] ?? '0'), index: match.index ?? 0 }))
    .sort((left, right) => left.index - right.index);
  const intervals: TimeInterval[] = [];
  let startMs: number | null = null;
  for (const event of events) {
    if (event.kind === 'start') startMs = event.atMs;
    if (event.kind === 'end' && startMs !== null && event.atMs > startMs) {
      intervals.push({ startMs, endMs: event.atMs });
      startMs = null;
    }
  }
  if (startMs !== null && mediaDurationMs && mediaDurationMs > startMs) {
    intervals.push({ startMs, endMs: mediaDurationMs });
  }
  return intervals;
}

export function parseSilenceIntervals(output: string, mediaDurationMs?: number): TimeInterval[] {
  const events = [...output.matchAll(/silence_(start|end):\s*([0-9.]+)/g)]
    .map(match => ({ kind: match[1], atMs: seconds(match[2] ?? '0'), index: match.index ?? 0 }))
    .sort((left, right) => left.index - right.index);
  const intervals: TimeInterval[] = [];
  let startMs: number | null = null;
  for (const event of events) {
    if (event.kind === 'start') startMs = event.atMs;
    if (event.kind === 'end' && startMs !== null && event.atMs > startMs) {
      intervals.push({ startMs, endMs: event.atMs });
      startMs = null;
    }
  }
  if (startMs !== null && mediaDurationMs && mediaDurationMs > startMs) {
    intervals.push({ startMs, endMs: mediaDurationMs });
  }
  return intervals;
}

export function intervalCoverage(startMs: number, endMs: number, intervals: TimeInterval[]): number {
  const duration = endMs - startMs;
  if (duration <= 0) return 0;
  const overlap = intervals.reduce((total, interval) => {
    return total + Math.max(0, Math.min(endMs, interval.endMs) - Math.max(startMs, interval.startMs));
  }, 0);
  return Math.max(0, Math.min(1, overlap / duration));
}

export function normalizedRotation(
  tags?: Record<string, string>,
  sideData?: Array<{ rotation?: number }>
): 0 | 90 | 180 | 270 {
  const raw = sideData?.find(value => Number.isFinite(value.rotation))?.rotation ?? Number(tags?.rotate ?? 0);
  const normalized = ((Math.round(raw) % 360) + 360) % 360;
  if (normalized >= 45 && normalized < 135) return 90;
  if (normalized >= 135 && normalized < 225) return 180;
  if (normalized >= 225 && normalized < 315) return 270;
  return 0;
}
