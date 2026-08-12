import { describe, expect, it } from 'vitest';
import {
  earliestSafeRepairState,
  repairPolicyFor,
  shouldAcquireAlternate
} from '@shared/repair-policy';

describe('bounded QC repair policy', () => {
  it('routes failures to the smallest safe stage and keeps safety prerequisites manual', () => {
    expect(repairPolicyFor('FINAL_MEDIA_PROFILE')).toMatchObject({
      repairClass: 'automatic',
      targetState: 'QC_DRAFT',
      maximumAttempts: 2
    });
    expect(repairPolicyFor('NO_SAFE_SEGMENT')).toMatchObject({
      repairClass: 'alternate',
      targetState: 'WAITING_FOR_DOWNLOADS',
      maximumAttempts: 2
    });
    expect(repairPolicyFor('UNSUPPORTED_CLAIM')).toMatchObject({
      repairClass: 'regenerate_range',
      targetState: 'FINALIZING_SCRIPT',
      maximumAttempts: 0
    });
    expect(repairPolicyFor('LICENSE_STATE', 'rights')).toMatchObject({
      repairClass: 'operator',
      targetState: null,
      maximumAttempts: 0
    });
    expect(earliestSafeRepairState(['QC_DRAFT', 'FINALIZING_SCRIPT'])).toBe('FINALIZING_SCRIPT');
  });

  it('requests one planned alternate only when the primary carries residual risk', () => {
    expect(shouldAcquireAlternate({
      score: 91,
      locationConfidence: 0.98,
      verificationStatus: 'human_verified',
      localFileId: 'file-1'
    })).toBe(false);
    expect(shouldAcquireAlternate({
      score: 76,
      locationConfidence: 0.86,
      verificationStatus: 'metadata',
      localFileId: null
    })).toBe(true);
  });
});
