export function parseCommittedRange(value: unknown): number {
  const match = typeof value === 'string' ? value.match(/bytes=\d+-(\d+)/i) : null;
  return match ? Number(match[1]) + 1 : 0;
}

export function resumableContentRange(offset: number, size: number): string {
  if (size <= 0 || offset < 0 || offset >= size) throw new Error('Invalid resumable upload byte range.');
  return `bytes ${offset}-${size - 1}/${size}`;
}

export function reusableEnglishCaptionId(
  items: Array<{ id?: string | null; snippet?: { language?: string | null; videoId?: string | null } | null }> | null | undefined,
  videoId: string
): string | null {
  const existing = items?.find(item =>
    item.id
    && item.snippet?.videoId === videoId
    && item.snippet.language?.toLowerCase().startsWith('en')
  );
  return existing?.id ?? null;
}
