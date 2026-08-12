import { describe, expect, it } from 'vitest';
import { approvalFingerprint } from '@shared/approval';

describe('publication approval fingerprint', () => {
  const base = {
    finalSha256: 'render-hash',
    packageId: 'package-1',
    title: 'Grounded title',
    description: 'Description',
    chapters: '0:00 Opening',
    tags: ['travel', 'grounded'],
    thumbnailSha256: 'thumbnail-hash'
  };

  it('is deterministic and invalidates every approved artifact change', () => {
    const hash = approvalFingerprint(base);
    expect(approvalFingerprint({ ...base })).toBe(hash);
    for (const changed of [
      { ...base, finalSha256: 'different-render' },
      { ...base, title: 'Different title' },
      { ...base, description: 'Different description' },
      { ...base, chapters: '0:00 Different' },
      { ...base, tags: ['other'] },
      { ...base, thumbnailSha256: 'different-thumbnail' }
    ]) {
      expect(approvalFingerprint(changed)).not.toBe(hash);
    }
  });
});
