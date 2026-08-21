export interface SourceColorMetadata {
  colorSpace?: string | null;
  colorTransfer?: string | null;
  colorPrimaries?: string | null;
}

export const MEDIA_PIPELINE_VERSION = 'media-v3-perceptual-matching';

export type SourceColorMode = 'sdr' | 'tone_map_pq' | 'tone_map_hlg' | 'blocked';

export interface SourceColorTreatment {
  mode: SourceColorMode;
  identity: string;
  reason: string;
  videoFilter: string | null;
}

const PQ_TRANSFERS = new Set(['smpte2084', 'smpte-st-2084', 'pq']);
const HLG_TRANSFERS = new Set(['arib-std-b67', 'arib-std-b-67', 'hlg']);
const SDR_TRANSFERS = new Set([
  '',
  'unknown',
  'unspecified',
  'bt709',
  'smpte170m',
  'smpte240m',
  'bt470m',
  'bt470bg',
  'gamma22',
  'gamma28',
  'iec61966-2-1',
  'iec61966-2-4'
]);

function normalized(value: string | null | undefined): string {
  return (value ?? '').trim().toLocaleLowerCase('en-US').replaceAll('_', '-');
}

function isBt2020(value: string): boolean {
  return value === 'bt2020' || value === 'bt2020nc' || value === 'bt2020-ncl' || value === 'bt2020c' || value === 'bt2020-cl';
}

const PQ_FILTER = [
  'zscale=pin=bt2020:tin=smpte2084:min=bt2020nc:rin=limited:t=linear:npl=100',
  'format=gbrpf32le',
  'zscale=p=bt709',
  'tonemap=tonemap=mobius:param=0.3:desat=0.5',
  'zscale=t=bt709:m=bt709:r=limited',
  'format=yuv420p'
].join(',');

const HLG_FILTER = [
  'zscale=pin=bt2020:tin=arib-std-b67:min=bt2020nc:rin=limited:t=linear:npl=100',
  'format=gbrpf32le',
  'zscale=p=bt709',
  'tonemap=tonemap=mobius:param=0.3:desat=0.5',
  'zscale=t=bt709:m=bt709:r=limited',
  'format=yuv420p'
].join(',');

/**
 * Classifies source transfer metadata before any proxy, contact-sheet, or final
 * render is produced. Unknown ordinary SDR metadata remains usable; explicit
 * wide-gamut/HDR/log metadata must be handled deliberately or fail closed.
 */
export function sourceColorTreatment(metadata: SourceColorMetadata): SourceColorTreatment {
  const space = normalized(metadata.colorSpace);
  const transfer = normalized(metadata.colorTransfer);
  const primaries = normalized(metadata.colorPrimaries);
  const identity = `${space || 'unspecified'}:${transfer || 'unspecified'}:${primaries || 'unspecified'}`;
  const wideGamut = isBt2020(space) || isBt2020(primaries);

  if (PQ_TRANSFERS.has(transfer)) {
    if (!wideGamut) {
      return {
        mode: 'blocked', identity,
        reason: 'PQ/HDR10 transfer metadata is present without BT.2020 matrix or primaries, so deterministic tone mapping is unsafe.',
        videoFilter: null
      };
    }
    return {
      mode: 'tone_map_pq', identity,
      reason: 'BT.2020 PQ/HDR10 is tone-mapped to the approved BT.709 SDR profile.',
      videoFilter: PQ_FILTER
    };
  }

  if (HLG_TRANSFERS.has(transfer)) {
    if (!wideGamut) {
      return {
        mode: 'blocked', identity,
        reason: 'HLG transfer metadata is present without BT.2020 matrix or primaries, so deterministic tone mapping is unsafe.',
        videoFilter: null
      };
    }
    return {
      mode: 'tone_map_hlg', identity,
      reason: 'BT.2020 HLG is tone-mapped to the approved BT.709 SDR profile.',
      videoFilter: HLG_FILTER
    };
  }

  if (transfer.includes('log') || wideGamut || !SDR_TRANSFERS.has(transfer)) {
    return {
      mode: 'blocked', identity,
      reason: `Unsupported or ambiguous HDR/log color metadata (${identity}) must be normalized by an approved profile before use.`,
      videoFilter: null
    };
  }

  return {
    mode: 'sdr', identity,
    reason: transfer || space || primaries
      ? 'Source metadata is compatible with the BT.709 SDR production profile.'
      : 'Source has no explicit HDR/log signal and is handled as conventional SDR.',
    videoFilter: null
  };
}

export function assertSupportedSourceColor(metadata: SourceColorMetadata): SourceColorTreatment {
  const treatment = sourceColorTreatment(metadata);
  if (treatment.mode === 'blocked') throw new Error(treatment.reason);
  return treatment;
}
