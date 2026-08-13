import { describe, expect, it } from 'vitest';
import {
  applicablePronunciations,
  captionCuesFromWords,
  durationWeightedWordTimings,
  fitNarrationShotDuration,
  planNarrationSections,
  renderFragmentCacheKey,
  splitAlignedNarration,
  splitNarration
} from '@shared/narration';

describe('narration visual-shot splitting', () => {
  it('keeps short sentences intact', () => {
    expect(splitNarration('A short grounded sentence.')).toEqual(['A short grounded sentence.']);
  });

  it('splits long narration into bounded chunks without losing words', () => {
    const text = 'One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen.';
    const chunks = splitNarration(text, 7);
    expect(chunks.every(chunk => chunk.split(/\s+/).length <= 7)).toBe(true);
    expect(chunks.join(' ').replace(/[.!?]/g, '')).toBe(text.replace(/[.!?]/g, ''));
  });

  it('returns no shot for blank narration', () => {
    expect(splitNarration('   ')).toEqual([]);
  });

  it('never truncates narration to fit a shorter visual segment', () => {
    expect(fitNarrationShotDuration(4_000, 5_000)).toBe(4_180);
    expect(fitNarrationShotDuration(4_900, 5_000)).toBe(5_000);
    expect(() => fitNarrationShotDuration(5_001, 5_000)).toThrow(/shorter than narration/);
    expect(() => fitNarrationShotDuration(7_001, 8_000)).toThrow(/visual-shot limit/);
  });

  it('groups final scenes into natural bounded narration sections', () => {
    const scenes = Array.from({ length: 10 }, (_, index) => ({
      id: `scene-${index + 1}`,
      chapter: index < 5 ? 'Opening' : 'Arrival',
      narration: `Scene ${index + 1}.`,
      targetDurationMs: 4_000
    }));
    const sections = planNarrationSections(scenes);
    expect(sections).toHaveLength(2);
    expect(sections.map(section => section.estimatedDurationMs)).toEqual([20_000, 20_000]);
    expect(sections[0]?.scenes.map(scene => scene.id)).toEqual(scenes.slice(0, 5).map(scene => scene.id));
  });

  it('selects only pronunciations present in a section', () => {
    expect(applicablePronunciations('Welcome to Oaxaca and Paris.', {
      Oaxaca: 'wah-HAH-kah',
      Kyoto: 'kee-OH-toh',
      Paris: 'PAIR-iss'
    })).toEqual({ Oaxaca: 'wah-HAH-kah', Paris: 'PAIR-iss' });
  });

  it('creates monotonic fallback word timing and splits only on word boundaries', () => {
    const timings = durationWeightedWordTimings('One two, three four five six seven.', 8_400);
    expect(timings).toHaveLength(7);
    expect(timings[0]?.startMs).toBe(0);
    expect(timings.at(-1)?.endMs).toBe(8_400);
    expect(timings.every((word, index) => index === 0 || word.startMs >= timings[index - 1]!.endMs)).toBe(true);
    const parts = splitAlignedNarration(timings, 7_000);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every(part => part.durationMs <= 7_000)).toBe(true);
    expect(parts.flatMap(part => part.words).map(word => word.word)).toEqual(timings.map(word => word.word));
  });

  it('derives bounded caption cues from word timing', () => {
    const timings = durationWeightedWordTimings('One two three four five six seven eight nine.', 4_500);
    const cues = captionCuesFromWords(timings, 20, 4);
    expect(cues.length).toBeGreaterThan(1);
    expect(cues.every(cue => cue.text.length <= 20 && cue.endMs > cue.startMs)).toBe(true);
    expect(cues.map(cue => cue.text).join(' ')).toBe('One two three four five six seven eight nine.');
  });

  it('keeps unaffected render fragments stable across a scoped scene repair', () => {
    const base = {
      sceneId: 'scene-1', sourceHash: 'source-a', sourceStartMs: 0,
      durationMs: 4_000, voiceInputHash: 'voice-a', audioStartMs: 0,
      narration: 'Grounded narration.', width: 1280, height: 720, profile: 'draft_720p'
    };
    const original = renderFragmentCacheKey(base);
    expect(renderFragmentCacheKey({ ...base })).toBe(original);
    expect(renderFragmentCacheKey({ ...base, sceneId: 'scene-2' })).not.toBe(original);
    expect(renderFragmentCacheKey({ ...base, voiceInputHash: 'voice-repaired' })).not.toBe(original);
  });
});
