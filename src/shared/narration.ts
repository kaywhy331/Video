function words(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean);
}

export interface NarrationSceneInput {
  id: string;
  chapter: string | null;
  narration: string;
  targetDurationMs: number;
}

export interface NarrationSectionPlan {
  ordinal: number;
  chapter: string | null;
  scenes: NarrationSceneInput[];
  text: string;
  estimatedDurationMs: number;
}

export interface AlignedWord {
  word: string;
  startMs: number;
  endMs: number;
  confidence: number;
  timingMethod: 'provider_word' | 'duration_weighted_fallback';
}

export interface TimedNarrationPart {
  words: AlignedWord[];
  text: string;
  audioStartMs: number;
  audioEndMs: number;
  durationMs: number;
}

export interface CaptionCue {
  text: string;
  startMs: number;
  endMs: number;
}

export interface RenderFragmentInput {
  sceneId: string;
  sourceHash: string;
  sourceStartMs: number;
  durationMs: number;
  voiceInputHash: string;
  audioStartMs: number;
  narration: string;
  width: number;
  height: number;
  profile: string;
}

export function narrationTokens(text: string): string[] {
  return text.match(/\S+/g) ?? [];
}

export function planNarrationSections(
  scenes: NarrationSceneInput[],
  minimumMs = 15_000,
  maximumMs = 45_000
): NarrationSectionPlan[] {
  if (minimumMs <= 0 || maximumMs < minimumMs) throw new Error('Narration section duration bounds are invalid.');
  const sections: NarrationSceneInput[][] = [];
  let current: NarrationSceneInput[] = [];
  let duration = 0;
  for (const scene of scenes) {
    const sceneDuration = Math.max(1_500, scene.targetDurationMs);
    const chapterChanged = current.length > 0 && scene.chapter !== current[0]?.chapter;
    if (current.length && (duration + sceneDuration > maximumMs || (chapterChanged && duration >= minimumMs))) {
      sections.push(current);
      current = [];
      duration = 0;
    }
    current.push(scene);
    duration += sceneDuration;
  }
  if (current.length) sections.push(current);

  if (sections.length > 1) {
    const last = sections.at(-1)!;
    const previous = sections.at(-2)!;
    const lastDuration = last.reduce((sum, scene) => sum + Math.max(1_500, scene.targetDurationMs), 0);
    const previousDuration = previous.reduce((sum, scene) => sum + Math.max(1_500, scene.targetDurationMs), 0);
    if (lastDuration < minimumMs && previousDuration + lastDuration <= maximumMs) {
      previous.push(...last);
      sections.pop();
    }
  }

  return sections.map((sectionScenes, index) => ({
    ordinal: index + 1,
    chapter: sectionScenes[0]?.chapter ?? null,
    scenes: sectionScenes,
    text: sectionScenes.map(scene => scene.narration.trim()).filter(Boolean).join(' '),
    estimatedDurationMs: sectionScenes.reduce(
      (sum, scene) => sum + Math.max(1_500, scene.targetDurationMs),
      0
    )
  }));
}

export function applicablePronunciations(
  text: string,
  dictionary: Record<string, string>
): Record<string, string> {
  const selected: Record<string, string> = {};
  const haystack = text.toLocaleLowerCase();
  for (const [term, pronunciation] of Object.entries(dictionary)) {
    const normalizedTerm = term.trim();
    const normalizedPronunciation = pronunciation.trim();
    if (!normalizedTerm || !normalizedPronunciation) continue;
    if (haystack.includes(normalizedTerm.toLocaleLowerCase())) selected[normalizedTerm] = normalizedPronunciation;
  }
  return Object.fromEntries(Object.entries(selected).sort(([left], [right]) => left.localeCompare(right)));
}

export function applyPronunciationOverrides(text: string, dictionary: Record<string, string>): string {
  let result = text;
  const entries = Object.entries(dictionary)
    .filter(([term, pronunciation]) => term.trim() && pronunciation.trim())
    .sort(([left], [right]) => right.length - left.length);
  for (const [term, pronunciation] of entries) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu'), pronunciation);
  }
  return result;
}

export function durationWeightedWordTimings(
  text: string,
  durationMs: number,
  timingMethod: AlignedWord['timingMethod'] = 'duration_weighted_fallback'
): AlignedWord[] {
  const tokens = narrationTokens(text);
  if (!tokens.length || !Number.isFinite(durationMs) || durationMs <= 0) return [];
  const weights = tokens.map(token => Math.max(1, token.replace(/[^\p{L}\p{N}]/gu, '').length) + (/[.!?]$/.test(token) ? 4 : /[,;:]$/.test(token) ? 2 : 0));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = 0;
  return tokens.map((word, index) => {
    const startMs = Math.round(cursor);
    cursor += durationMs * (weights[index]! / totalWeight);
    const endMs = index === tokens.length - 1 ? Math.round(durationMs) : Math.max(startMs + 1, Math.round(cursor));
    return { word, startMs, endMs, confidence: timingMethod === 'provider_word' ? 0.95 : 0.35, timingMethod };
  });
}

export function splitAlignedNarration(
  wordsToSplit: AlignedWord[],
  hardMaximumMs = 7_000,
  edgePaddingMs = 80
): TimedNarrationPart[] {
  if (hardMaximumMs <= edgePaddingMs * 2) throw new Error('Aligned narration shot bound is too small.');
  if (!wordsToSplit.length) return [];
  const parts: AlignedWord[][] = [];
  let current: AlignedWord[] = [];
  for (const word of wordsToSplit) {
    const proposedStart = current[0]?.startMs ?? word.startMs;
    const proposedEnd = word.endMs + edgePaddingMs;
    if (current.length && proposedEnd - proposedStart > hardMaximumMs) {
      parts.push(current);
      current = [];
    }
    current.push(word);
  }
  if (current.length) parts.push(current);
  return parts.map((partWords, index) => {
    const previousEndMs = parts[index - 1]?.at(-1)?.endMs ?? 0;
    const nextStartMs = parts[index + 1]?.[0]?.startMs ?? Number.POSITIVE_INFINITY;
    const audioStartMs = index === 0
      ? Math.max(0, partWords[0]!.startMs - edgePaddingMs)
      : Math.max(previousEndMs, partWords[0]!.startMs - edgePaddingMs);
    const audioEndMs = Math.min(nextStartMs, partWords.at(-1)!.endMs + edgePaddingMs);
    if (audioEndMs - audioStartMs > hardMaximumMs) {
      throw new Error(`One aligned word exceeds the ${hardMaximumMs}ms visual-shot limit.`);
    }
    return {
      words: partWords,
      text: partWords.map(word => word.word).join(' '),
      audioStartMs,
      audioEndMs,
      durationMs: audioEndMs - audioStartMs
    };
  });
}

export function captionCuesFromWords(
  timedWords: Array<{ word: string; startMs: number; endMs: number }>,
  maximumCharacters = 42,
  maximumWords = 8
): CaptionCue[] {
  const cues: CaptionCue[] = [];
  let current: typeof timedWords = [];
  const flush = (): void => {
    if (!current.length) return;
    cues.push({
      text: current.map(word => word.word).join(' '),
      startMs: current[0]!.startMs,
      endMs: Math.max(current[0]!.startMs + 500, current.at(-1)!.endMs)
    });
    current = [];
  };
  for (const word of timedWords) {
    const candidate = [...current, word];
    const text = candidate.map(item => item.word).join(' ');
    if (current.length && (candidate.length > maximumWords || text.length > maximumCharacters)) flush();
    current.push(word);
    if (/[.!?]$/.test(word.word) || current.length >= maximumWords) flush();
  }
  flush();
  return cues;
}

export function renderFragmentCacheKey(input: RenderFragmentInput): string {
  const stable = JSON.stringify({
    sceneId: input.sceneId,
    sourceHash: input.sourceHash,
    sourceStartMs: input.sourceStartMs,
    durationMs: input.durationMs,
    voiceInputHash: input.voiceInputHash,
    audioStartMs: input.audioStartMs,
    narration: input.narration,
    width: input.width,
    height: input.height,
    profile: input.profile
  });
  let hash = 2166136261;
  for (let index = 0; index < stable.length; index += 1) {
    hash ^= stable.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fragment-${(hash >>> 0).toString(16).padStart(8, '0')}`;
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
