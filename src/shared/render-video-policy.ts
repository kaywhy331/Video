export const PROJECT_VIDEO_FRAME_RATE = 30;

export function buildFootageVideoFilter(input: {
  sourceColorFilter?: string | null;
  scaleFilter: string;
  editingFilter?: string | null;
  frameRate?: number;
}): string {
  return [
    'yadif=mode=send_frame:parity=auto:deint=interlaced',
    input.sourceColorFilter,
    input.scaleFilter,
    'setsar=1',
    `fps=${input.frameRate ?? PROJECT_VIDEO_FRAME_RATE}`,
    // Explicitly flatten any alpha-bearing source into the supported opaque profile.
    'format=yuv420p',
    input.editingFilter
  ].filter(Boolean).join(',');
}

export function buildGeneratedVideoFilter(input: {
  editingFilter: string;
  frameRate?: number;
}): string {
  return [
    input.editingFilter,
    'setsar=1',
    `fps=${input.frameRate ?? PROJECT_VIDEO_FRAME_RATE}`,
    'format=yuv420p'
  ].join(',');
}
