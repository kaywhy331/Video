import type { ProjectState } from './types';

export type RepairClass =
  | 'automatic'
  | 'alternate'
  | 'regenerate_range'
  | 'acquisition'
  | 'operator'
  | 'fatal';

export interface RepairPolicy {
  repairClass: RepairClass;
  action: string;
  targetState: ProjectState | null;
  maximumAttempts: number;
}

export const MAXIMUM_AUTOMATIC_REPAIR_ATTEMPTS = 2;

const OUTPUT_REPAIR_CODES = new Set([
  'OUTPUT_EXISTS',
  'FINAL_MEDIA_PROFILE',
  'FINAL_DURATION',
  'FAST_START',
  'LOUDNESS_MEASURED',
  'CLIPPING',
  'EXCESSIVE_SILENCE',
  'MISSING_NARRATION',
  'CAPTION_OVERLAP',
  'CAPTION_LINE_LIMIT',
  'THUMBNAIL_FILE_LIMIT'
]);

const RANGE_REPAIR_CODES = new Set([
  'SHOT_DURATION',
  'ABRUPT_AUDIO_JOIN',
  'MUSIC_OVER_SPEECH'
]);

const FOOTAGE_REPAIR_CODES = new Set([
  'NO_SAFE_SEGMENT',
  'NO_UPSCALE_BLOCK',
  'MISSING_SOURCE',
  'CORRUPT_FRAMES',
  'BLACK_FRAMES',
  'FROZEN_FRAMES',
  'EFFECTIVE_RESOLUTION',
  'SEVERE_CROP',
  'DUPLICATE_SHOT',
  'LETTERBOX'
]);

const SCRIPT_REPAIR_CODES = new Set([
  'UNSUPPORTED_CLAIM',
  'LOCATION_GROUNDING',
  'MISSING_LOCATION_LABEL',
  'SCRIPT_VISUAL_CONTRADICTION',
  'PACKAGE_PROMISE_UNSUPPORTED'
]);

const OPERATOR_CODES = new Set([
  'LICENSE_STATE',
  'AUTHENTICATION',
  'QUOTA',
  'DUPLICATE_UPLOAD',
  'PRIVACY_STATE'
]);

export function repairPolicyFor(code: string, category?: string): RepairPolicy {
  const normalized = code.trim().toUpperCase().replace(/^QC_/, '');
  if (OUTPUT_REPAIR_CODES.has(normalized)) {
    return {
      repairClass: 'automatic',
      action: 'Rebuild and revalidate only the final media/package artifact.',
      targetState: 'QC_DRAFT',
      maximumAttempts: MAXIMUM_AUTOMATIC_REPAIR_ATTEMPTS
    };
  }
  if (RANGE_REPAIR_CODES.has(normalized)) {
    return {
      repairClass: 'regenerate_range',
      action: 'Rebuild the smallest affected timeline range, then run QC again.',
      targetState: 'BUILDING_TIMELINE',
      maximumAttempts: MAXIMUM_AUTOMATIC_REPAIR_ATTEMPTS
    };
  }
  if (FOOTAGE_REPAIR_CODES.has(normalized)) {
    return {
      repairClass: 'alternate',
      action: 'Select the highest-ranked verified alternate or queue the next exact-location candidate.',
      targetState: 'WAITING_FOR_DOWNLOADS',
      maximumAttempts: MAXIMUM_AUTOMATIC_REPAIR_ATTEMPTS
    };
  }
  if (SCRIPT_REPAIR_CODES.has(normalized)) {
    return {
      repairClass: 'regenerate_range',
      action: 'Rewrite only the unsupported beat against verified footage, then rebuild its range.',
      targetState: 'FINALIZING_SCRIPT',
      maximumAttempts: 0
    };
  }
  if (OPERATOR_CODES.has(normalized) || category === 'rights' || category === 'publishing') {
    return {
      repairClass: 'operator',
      action: 'Complete the rights or provider prerequisite, then explicitly retry verification.',
      targetState: null,
      maximumAttempts: 0
    };
  }
  return {
    repairClass: 'operator',
    action: 'Inspect the recorded evidence and choose a safe repair before retrying.',
    targetState: null,
    maximumAttempts: 0
  };
}

export function shouldAcquireAlternate(candidate: {
  score: number;
  locationConfidence: number;
  verificationStatus: string;
  localFileId: string | null;
}): boolean {
  return candidate.score < 80
    || candidate.locationConfidence < 0.9
    || candidate.verificationStatus !== 'human_verified'
    || candidate.localFileId === null;
}

const STAGE_ORDER: ProjectState[] = [
  'STORYBOARD_PROVISIONAL',
  'WAITING_FOR_DOWNLOADS',
  'FINALIZING_SCRIPT',
  'BUILDING_TIMELINE',
  'QC_DRAFT'
];

export function earliestSafeRepairState(states: Array<ProjectState | null>): ProjectState | null {
  const targets = states.filter((state): state is ProjectState => state !== null);
  return targets.sort((left, right) => STAGE_ORDER.indexOf(left) - STAGE_ORDER.indexOf(right))[0] ?? null;
}
