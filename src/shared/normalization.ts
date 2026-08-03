import { createHash } from 'node:crypto';

const NULL_MARKERS = new Set([
  '',
  'not found',
  'n/a',
  'na',
  'none',
  'null',
  'undefined',
  '-',
  '--',
  'unknown'
]);

export function normalizeNullable(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\u00a0/g, ' ').trim();
  if (NULL_MARKERS.has(text.toLowerCase())) return null;
  return text;
}

export function normalizeBoolean(value: unknown): boolean | null {
  const text = normalizeNullable(value)?.toLowerCase();
  if (text === null || text === undefined) return null;
  if (['yes', 'true', '1', 'y'].includes(text)) return true;
  if (['no', 'false', '0', 'n'].includes(text)) return false;
  return null;
}

export function parseDurationMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Spreadsheet duration commonly arrives as seconds.
    return Math.max(0, Math.round(value * 1000));
  }
  const text = normalizeNullable(value);
  if (!text) return null;

  const colon = text.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
  if (colon) {
    const hours = Number(colon[1] ?? 0);
    const minutes = Number(colon[2] ?? 0);
    const seconds = Number(colon[3] ?? 0);
    return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
  }

  const number = Number(text.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(number)) return null;
  if (/ms/i.test(text)) return Math.round(number);
  if (/min/i.test(text)) return Math.round(number * 60_000);
  return Math.round(number * 1000);
}

export function parseFileSizeBytes(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  const text = normalizeNullable(value);
  if (!text) return null;
  const match = text.replace(/,/g, '').match(/([\d.]+)\s*(b|kb|mb|gb|tb)?/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const unit = (match[2] ?? 'b').toLowerCase();
  const multiplier: Record<string, number> = {
    b: 1,
    kb: 1024,
    mb: 1024 ** 2,
    gb: 1024 ** 3,
    tb: 1024 ** 4
  };
  return Math.round(amount * (multiplier[unit] ?? 1));
}

export function parseFrameRate(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = normalizeNullable(value);
  if (!text) return null;
  if (text.includes('/')) {
    const [left, right] = text.split('/').map(Number);
    if (left && right) return left / right;
  }
  const parsed = Number(text.replace(/[^\d.]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseResolution(value: unknown): { width: number | null; height: number | null } {
  const text = normalizeNullable(value);
  if (!text) return { width: null, height: null };
  const match = text.match(/(\d{3,5})\s*[x×]\s*(\d{3,5})/i);
  if (match) return { width: Number(match[1]), height: Number(match[2]) };
  const lower = text.toLowerCase();
  if (lower.includes('8k')) return { width: 7680, height: 4320 };
  if (lower.includes('4k') || lower.includes('uhd')) return { width: 3840, height: 2160 };
  if (lower.includes('1080')) return { width: 1920, height: 1080 };
  if (lower.includes('720')) return { width: 1280, height: 720 };
  return { width: null, height: null };
}

export function inferOrientation(
  declared: unknown,
  width: number | null,
  height: number | null
): 'landscape' | 'portrait' | 'square' | 'unknown' {
  const text = normalizeNullable(declared)?.toLowerCase();
  if (text?.includes('landscape') || text?.includes('horizontal')) return 'landscape';
  if (text?.includes('portrait') || text?.includes('vertical')) return 'portrait';
  if (text?.includes('square')) return 'square';
  if (width && height) {
    const ratio = width / height;
    if (ratio > 1.1) return 'landscape';
    if (ratio < 0.9) return 'portrait';
    return 'square';
  }
  return 'unknown';
}

export function inferLocationGranularity(input: {
  country: string | null;
  city: string | null;
  location: string | null;
}): 'country' | 'region' | 'city' | 'neighborhood' | 'landmark' | 'feature' | 'unknown' {
  if (input.location) return 'landmark';
  if (input.city) return 'city';
  if (input.country) return 'country';
  return 'unknown';
}

export function canonicalizeName(value: unknown): string | null {
  const text = normalizeNullable(value);
  if (!text) return null;
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s+,/g, ',')
    .trim();
}

export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'untitled';
}

export function stableAssetKey(input: {
  provider?: string | null;
  providerAssetId?: string | null;
  canonicalPageUrl?: string | null;
  sourceRowId?: string | null;
  title?: string | null;
  authorName?: string | null;
}): string {
  const payload = [
    input.provider ?? 'envato',
    input.providerAssetId ?? '',
    input.canonicalPageUrl ?? '',
    input.sourceRowId ?? '',
    input.title ?? '',
    input.authorName ?? ''
  ].join('|').toLowerCase();
  return createHash('sha256').update(payload).digest('hex');
}

export function splitList(value: unknown): string[] {
  const text = normalizeNullable(value);
  if (!text) return [];
  return [...new Set(text.split(/[,;|]\s*/).map(item => item.trim()).filter(Boolean))];
}
