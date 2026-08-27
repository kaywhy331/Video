import { describe, expect, it } from 'vitest';
import { assessProductionRecoveryEvidence } from '../scripts/production-recovery-evidence.mjs';
import {
  qualifyingProductionRecoveryEvidence,
  recoveryDigest
} from './fixtures/production-recovery-evidence-fixture';

function drill(input: ReturnType<typeof qualifyingProductionRecoveryEvidence>, kind: string) {
  return input.observations.find(value => value.kind === kind) as any;
}

describe('production recovery evidence', () => {
  it('[E2E-004] qualifies all representative forced-restart boundaries on a packaged Windows target', () => {
    const assessed = assessProductionRecoveryEvidence(qualifyingProductionRecoveryEvidence());

    expect(assessed.externalQualificationPassed).toBe(true);
    expect(assessed.acceptance).toEqual({ 'E2E-004': 'qualified' });
    expect(assessed.observationCount).toBe(6);
    expect(assessed.fieldCriteria).toEqual({
      provider: true,
      ingest: true,
      render: true,
      upload_session: true,
      upload_commit: true,
      restore: true
    });
  });

  it('keeps the same measured drills supporting outside the representative target', () => {
    const input = qualifyingProductionRecoveryEvidence();
    input.mode = 'supporting';
    input.source.dirty = true;
    input.environment.platform = 'linux';
    input.environment.ci = true;
    input.application.packaged = false;

    const assessed = assessProductionRecoveryEvidence(input);

    expect(assessed.fieldCriteriaPassed).toBe(true);
    expect(assessed.externalQualificationPassed).toBe(false);
    expect(assessed.acceptance).toEqual({ 'E2E-004': 'supporting' });
  });

  it('rejects missing, repeated, or unknown drill kinds', () => {
    const missing = qualifyingProductionRecoveryEvidence();
    missing.observations.pop();
    expect(() => assessProductionRecoveryEvidence(missing)).toThrow(/exactly 6 drills/);

    const repeated = qualifyingProductionRecoveryEvidence();
    repeated.observations[5] = structuredClone(repeated.observations[0]!);
    repeated.observations[5]!.observationSha256 = recoveryDigest('distinct-repeated-observation');
    expect(() => assessProductionRecoveryEvidence(repeated)).toThrow(/exactly these drill kinds/);

    const unknown = qualifyingProductionRecoveryEvidence();
    unknown.observations[0]!.kind = 'manual_claim';
    expect(() => assessProductionRecoveryEvidence(unknown)).toThrow(/unsupported drill kind/);
  });

  it('fails when a completed paid provider call or cost is repeated', () => {
    const input = qualifyingProductionRecoveryEvidence();
    const provider = drill(input, 'provider').evidence;
    provider.completedCallSha256sAfter = [recoveryDigest('changed-provider-call')];
    provider.replayedCompletedCallSha256s = [recoveryDigest('provider-call-1')];
    provider.paidCallCountAfter = 2;
    provider.estimatedCostMicrosAfter = 100_000;
    provider.repeatedEstimatedCostMicros = 50_000;

    const assessed = assessProductionRecoveryEvidence(input);

    expect(assessed.fieldCriteria.provider).toBe(false);
    expect(assessed.acceptance['E2E-004']).toBe('failed');
  });

  it('fails unsafe ingest and render recovery instead of accepting completed rows alone', () => {
    const input = qualifyingProductionRecoveryEvidence();
    drill(input, 'ingest').evidence.unmanagedPathTouched = true;
    drill(input, 'render').evidence.mediaProbePassed = false;
    drill(input, 'render').evidence.managedPartialCountAfter = 1;

    const assessed = assessProductionRecoveryEvidence(input);

    expect(assessed.fieldCriteria.ingest).toBe(false);
    expect(assessed.fieldCriteria.render).toBe(false);
    expect(assessed.externalQualificationPassed).toBe(false);
  });

  it('fails duplicate or changed remote upload identities at both interruption boundaries', () => {
    const input = qualifyingProductionRecoveryEvidence();
    const session = drill(input, 'upload_session').evidence;
    session.uploadSessionSha256After = recoveryDigest('different-session');
    session.publicationCountAfter = 2;
    const commit = drill(input, 'upload_commit').evidence;
    commit.videoIdSha256After = recoveryDigest('different-video');

    const assessed = assessProductionRecoveryEvidence(input);

    expect(assessed.fieldCriteria.upload_session).toBe(false);
    expect(assessed.fieldCriteria.upload_commit).toBe(false);
    expect(assessed.acceptance['E2E-004']).toBe('failed');
  });

  it('fails incomplete restore acknowledgement or corrupted safety evidence', () => {
    const input = qualifyingProductionRecoveryEvidence();
    const restore = drill(input, 'restore').evidence;
    restore.restoredSourceSha256 = recoveryDigest('wrong-restored-source');
    restore.safetyBackupIntegrity = 'malformed';
    restore.completionMarkerAfter = true;
    restore.artifactRebuildStatus = 'partial';

    const assessed = assessProductionRecoveryEvidence(input);

    expect(assessed.fieldCriteria.restore).toBe(false);
    expect(assessed.externalQualificationPassed).toBe(false);
  });

  it('requires a real forced process-tree restart and intact schema/foreign keys', () => {
    const input = qualifyingProductionRecoveryEvidence();
    const render = drill(input, 'render');
    render.process.forced = false;
    render.process.restartedPidSha256 = render.process.initialPidSha256;
    render.database.integrityAfter = 'corrupt';
    render.database.foreignKeyViolationsAfter = 1;
    render.work.attemptAfter = render.work.attemptBefore;

    const assessed = assessProductionRecoveryEvidence(input);
    const renderAssessment = assessed.observationAssessments.find(value => value.kind === 'render');

    expect(renderAssessment?.commonPassed).toBe(false);
    expect(assessed.acceptance['E2E-004']).toBe('failed');
  });

  it('rejects extra fields, duplicate observation hashes, and impossible event order', () => {
    const extra = qualifyingProductionRecoveryEvidence() as any;
    extra.manualApproval = true;
    expect(() => assessProductionRecoveryEvidence(extra)).toThrow(/fields must be exactly/);

    const duplicated = qualifyingProductionRecoveryEvidence();
    duplicated.observations[1]!.observationSha256 = duplicated.observations[0]!.observationSha256;
    expect(() => assessProductionRecoveryEvidence(duplicated)).toThrow(/must not contain duplicates/);

    const reversed = qualifyingProductionRecoveryEvidence();
    reversed.observations[0]!.restartedAt = reversed.observations[0]!.killedAt;
    expect(() => assessProductionRecoveryEvidence(reversed)).toThrow(/timestamps must prove/);
  });
});
