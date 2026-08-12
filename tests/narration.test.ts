import { describe, expect, it } from 'vitest';
import { fitNarrationShotDuration, splitNarration } from '@shared/narration';

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
});
