import { describe, expect, it } from 'vitest';
import {
  parseCommittedRange,
  reusableEnglishCaptionId,
  resumableContentRange
} from '@shared/youtube-resumable';

describe('YouTube resumable upload protocol', () => {
  it('converts the committed Range response into the next byte offset', () => {
    expect(parseCommittedRange('bytes=0-1048575')).toBe(1_048_576);
    expect(parseCommittedRange(undefined)).toBe(0);
    expect(parseCommittedRange('invalid')).toBe(0);
  });

  it('builds a valid remaining Content-Range and rejects completed ranges', () => {
    expect(resumableContentRange(1_048_576, 2_000_000)).toBe('bytes 1048576-1999999/2000000');
    expect(() => resumableContentRange(2_000_000, 2_000_000)).toThrow(/Invalid/);
    expect(() => resumableContentRange(-1, 2_000_000)).toThrow(/Invalid/);
  });

  it('reuses an existing English caption after a crash before local receipt persistence', () => {
    expect(reusableEnglishCaptionId([
      { id: 'spanish', snippet: { videoId: 'video-1', language: 'es' } },
      { id: 'other-video', snippet: { videoId: 'video-2', language: 'en-US' } },
      { id: 'english', snippet: { videoId: 'video-1', language: 'en-US' } }
    ], 'video-1')).toBe('english');
    expect(reusableEnglishCaptionId([], 'video-1')).toBeNull();
  });
});
