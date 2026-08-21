import type { OutputProfileKey } from './types';

export interface OutputDimensions {
  profileKey: OutputProfileKey;
  width: number;
  height: number;
  orientation: 'landscape' | 'portrait';
}

export function outputDimensions(profileKey: OutputProfileKey): OutputDimensions {
  if (profileKey === 'landscape_4k') {
    return { profileKey, width: 3840, height: 2160, orientation: 'landscape' };
  }
  if (profileKey === 'vertical_1080p') {
    return { profileKey, width: 1080, height: 1920, orientation: 'portrait' };
  }
  return { profileKey: 'landscape_1080p', width: 1920, height: 1080, orientation: 'landscape' };
}

export function cropRetainedPixels(
  sourceWidth: number,
  sourceHeight: number,
  outputWidth: number,
  outputHeight: number
): { width: number; height: number } {
  if (![sourceWidth, sourceHeight, outputWidth, outputHeight].every(value => Number.isFinite(value) && value > 0)) {
    return { width: 0, height: 0 };
  }
  const sourceAspect = sourceWidth / sourceHeight;
  const outputAspect = outputWidth / outputHeight;
  return sourceAspect >= outputAspect
    ? { width: sourceHeight * outputAspect, height: sourceHeight }
    : { width: sourceWidth, height: sourceWidth / outputAspect };
}

export function qualifiesOutputPixels(
  sourceWidth: number,
  sourceHeight: number,
  outputWidth: number,
  outputHeight: number
): boolean {
  const retained = cropRetainedPixels(sourceWidth, sourceHeight, outputWidth, outputHeight);
  return retained.width + 0.5 >= outputWidth && retained.height + 0.5 >= outputHeight;
}
