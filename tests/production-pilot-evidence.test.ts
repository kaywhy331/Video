import { describe, expect, it } from 'vitest';
import { assessProductionPilotEvidence } from '../scripts/production-pilot-evidence.mjs';
import {
  pilotDigest,
  qualifyingProductionPilotEvidence
} from './fixtures/production-pilot-evidence-fixture';

const evidence = qualifyingProductionPilotEvidence;

describe('production pilot evidence', () => {
  it('[E2E-001][E2E-002][E2E-005][UX-001] qualifies a complete exact-source Windows field pilot', () => {
    const assessed = assessProductionPilotEvidence(evidence());

    expect(assessed.externalQualificationPassed).toBe(true);
    expect(assessed.acceptance).toEqual({
      'E2E-001': 'qualified',
      'E2E-002': 'qualified',
      'E2E-005': 'qualified',
      'UX-001': 'qualified'
    });
    expect(assessed.derived).toMatchObject({
      projectCount: 5,
      destinationClusterCount: 3,
      completeProductionCount: 5,
      scheduledCount: 1,
      routineOnlyCount: 4
    });
  });

  it('keeps identical measured evidence supporting outside the representative Windows target', () => {
    const input = evidence();
    input.mode = 'supporting';
    input.environment.platform = 'linux';
    input.environment.ci = true;
    input.environment.deviceClass = null;

    const assessed = assessProductionPilotEvidence(input);

    expect(assessed.fieldCriteriaPassed).toBe(true);
    expect(assessed.externalQualificationPassed).toBe(false);
    expect(new Set(Object.values(assessed.acceptance))).toEqual(new Set(['supporting']));
  });

  it('fails the pilot and UX gates when fewer than four projects have routine-only operator activity', () => {
    const input = evidence();
    input.projects[3]!.audit.operatorActions.push('storyboard.replace_shot');

    const assessed = assessProductionPilotEvidence(input);

    expect(assessed.acceptance['E2E-001']).toBe('qualified');
    expect(assessed.acceptance['E2E-002']).toBe('qualified');
    expect(assessed.acceptance['E2E-005']).toBe('failed');
    expect(assessed.acceptance['UX-001']).toBe('failed');
    expect(assessed.externalQualificationPassed).toBe(false);
  });

  it('rejects duplicate remote identities and mismatched final bytes', () => {
    const duplicated = evidence();
    duplicated.projects[4]!.publication.videoIdHash = duplicated.projects[0]!.publication.videoIdHash;
    expect(() => assessProductionPilotEvidence(duplicated)).toThrow(/distinct remote videos/);

    const changed = evidence();
    changed.projects[0]!.render.artifact.sha256 = pilotDigest('changed-final');
    const assessed = assessProductionPilotEvidence(changed);
    expect(assessed.projectAssessments[0]?.checks.verifiedFinalArtifact).toBe(false);
    expect(assessed.acceptance['E2E-001']).toBe('failed');
  });

  it('does not call final media clean when any current-final QC result failed', () => {
    const input = evidence();
    input.projects[0]!.qc.failedCount = 1;
    input.projects[0]!.qc.failedBlockerHighCount = 0;

    const assessed = assessProductionPilotEvidence(input);

    expect(assessed.projectAssessments[0]?.checks.cleanQc).toBe(false);
    expect(assessed.acceptance['E2E-001']).toBe('failed');
    expect(assessed.acceptance['E2E-005']).toBe('failed');
  });

  it('requires a live-provider receipt for every narration section', () => {
    const input = evidence();
    input.projects[0]!.narration.providerReceiptCount = 1;

    const assessed = assessProductionPilotEvidence(input);

    expect(assessed.projectAssessments[0]?.checks.liveNarration).toBe(false);
    expect(assessed.acceptance['E2E-001']).toBe('failed');
  });

  it('does not infer approval or scheduling from omitted timestamps', () => {
    const input = evidence() as any;
    delete input.projects[0].publication.approvedAt;
    delete input.projects[0].publication.scheduledAt;

    const assessed = assessProductionPilotEvidence(input);

    expect(assessed.projectAssessments[0]?.finalApprovalCompleted).toBe(false);
    expect(assessed.projectAssessments[0]?.scheduleCompleted).toBe(false);
    expect(assessed.acceptance['E2E-002']).toBe('failed');
  });

  it('allows one batch certificate to back multiple distinct asset licenses', () => {
    const input = evidence();
    input.projects[0]!.acquisition.certificateArtifacts[1]!.sha256 =
      input.projects[0]!.acquisition.certificateArtifacts[0]!.sha256;

    const assessed = assessProductionPilotEvidence(input);

    expect(assessed.projectAssessments[0]?.checks.completeAcquisition).toBe(true);
    expect(assessed.acceptance['E2E-001']).toBe('qualified');
  });
});
