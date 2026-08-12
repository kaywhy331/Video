function words(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean);
}

export function splitNarration(text: string, maximumWords = 15): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const sentences = normalized.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map(value => value.trim()).filter(Boolean) ?? [normalized];
  const chunks: string[] = [];
  for (const sentence of sentences) {
    const tokens = words(sentence);
    if (tokens.length <= maximumWords) {
      chunks.push(sentence);
      continue;
    }
    for (let start = 0; start < tokens.length; start += maximumWords) {
      chunks.push(tokens.slice(start, start + maximumWords).join(' '));
    }
  }
  return chunks;
}

export function fitNarrationShotDuration(
  audioDurationMs: number,
  sourceAvailableMs: number,
  hardMaximumMs = 7000
): number {
  if (![audioDurationMs, sourceAvailableMs, hardMaximumMs].every(value => Number.isFinite(value) && value > 0)) {
    throw new Error('Narration and source durations must be positive finite values.');
  }
  if (audioDurationMs > hardMaximumMs) {
    throw new Error(`Narration duration ${audioDurationMs}ms exceeds the visual-shot limit ${hardMaximumMs}ms.`);
  }
  if (sourceAvailableMs < audioDurationMs) {
    throw new Error(`Eligible source duration ${sourceAvailableMs}ms is shorter than narration ${audioDurationMs}ms.`);
  }
  return Math.min(hardMaximumMs, sourceAvailableMs, Math.max(1800, audioDurationMs + 180));
}
