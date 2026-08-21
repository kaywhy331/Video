import { describe, expect, it, vi } from 'vitest';
import { awaitUsableYouTubeProcessing } from '@main/services/youtube-service';

describe('YouTube processing polling', () => {
  it('[YT-005] waits through pending states and returns only after usable processing succeeds', async () => {
    const statuses = ['processing', null, 'succeeded'];
    const readStatus = vi.fn(async () => statuses.shift());
    const sleep = vi.fn(async () => undefined);
    const progress = vi.fn();
    await expect(awaitUsableYouTubeProcessing({
      readStatus,
      sleep,
      onProgress: progress,
      intervalMs: 15_000
    })).resolves.toBeUndefined();
    expect(readStatus).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(progress).toHaveBeenNthCalledWith(1, 0, 'processing');
    expect(progress).toHaveBeenNthCalledWith(2, 1, null);
  });

  it('fails immediately for terminal processing and times out deterministically', async () => {
    const sleep = vi.fn(async () => undefined);
    await expect(awaitUsableYouTubeProcessing({ readStatus: async () => 'failed', sleep }))
      .rejects.toThrow('processing failed');
    expect(sleep).not.toHaveBeenCalled();
    await expect(awaitUsableYouTubeProcessing({
      readStatus: async () => 'processing', sleep, maximumAttempts: 2, intervalMs: 1
    })).rejects.toThrow(/configured polling window/);
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});
