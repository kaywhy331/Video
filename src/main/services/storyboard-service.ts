import { createHash, randomUUID } from 'node:crypto';
import type {
  ProjectDetail,
  ProjectScene,
  ProjectState,
  StoryboardMutationResult,
  StoryboardRecoveryAction,
  StoryboardRecoveryScene,
  VisualTreatment
} from '@shared/types';
import { canTransitionProject } from '@shared/state-machine';
import type { AppDatabase } from '../database/database';
import type { FootageVerificationService } from './footage-verification-service';
import type { PlaceService } from './place-service';
import type { ProjectService } from './project-service';
import type { RepairService } from './repair-service';

const EDITABLE_STATES = new Set<ProjectState>([
  'STORYBOARD_PROVISIONAL',
  'WAITING_FOR_DOWNLOADS',
  'VERIFYING_FOOTAGE',
  'FINALIZING_SCRIPT',
  'GENERATING_VOICE',
  'BUILDING_TIMELINE',
  'QC_DRAFT',
  'QC_FINAL',
  'WAITING_FINAL_APPROVAL',
  'BLOCKED_EXCEPTION'
]);

const GRAPHIC_TREATMENTS = new Set<VisualTreatment>(['MAP_OR_GRAPHIC', 'TEXT_OR_ARCHIVAL']);

interface LockedProject {
  state: ProjectState;
  scriptVersionId: string | null;
}

interface MutationOutcome {
  affectedSceneIds: string[];
  affectedRange: { startSceneOrdinal: number; endSceneOrdinal: number; sceneOrdinals: number[] } | null;
  nextAction: StoryboardMutationResult['nextAction'];
}

function jsonArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? '[]'));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function jsonObject(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value ?? '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

export class StoryboardService {
  constructor(
    private readonly db: AppDatabase,
    private readonly projects: ProjectService,
    private readonly repairs: RepairService,
    private readonly places: PlaceService,
    private readonly footageVerification: Pick<FootageVerificationService, 'verifyScene'>
  ) {}

  getRecoveryScene(projectId: string, sceneId: string): StoryboardRecoveryScene {
    const project = this.projects.get(projectId);
    const sceneIndex = project.scenes.findIndex(scene => scene.id === sceneId);
    if (sceneIndex < 0) throw new Error('Storyboard scene not found.');
    const lock = this.db.raw.prepare(`
      SELECT locked_by_job_id FROM projects WHERE id = ?
    `).get(projectId) as { locked_by_job_id: string | null };
    const editBlockedReason = lock.locked_by_job_id
      ? 'Wait for the active project job to reach a safe checkpoint.'
      : !EDITABLE_STATES.has(project.state)
        ? `Storyboard recovery is unavailable while the project is ${project.state}.`
        : null;
    return {
      projectId,
      scene: project.scenes[sceneIndex]!,
      candidates: this.repairs.listStoryboardCandidates(projectId, sceneId),
      previousSceneId: project.scenes[sceneIndex - 1]?.id ?? null,
      nextSceneId: project.scenes[sceneIndex + 1]?.id ?? null,
      editable: !editBlockedReason,
      editBlockedReason
    };
  }

  replaceShot(input: {
    projectId: string;
    sceneId: string;
    candidateId: string;
    reason: string;
  }): StoryboardMutationResult {
    const outcome = this.withProjectLock(input.projectId, 'replace_shot', (_project, now) => {
      const before = this.sceneRow(input.projectId, input.sceneId);
      this.repairs.selectStoryboardCandidate(
        input.projectId,
        input.sceneId,
        input.candidateId,
        input.reason
      );
      const version = this.forkScript(input.projectId, 'operator_replace_shot', now, true);
      this.invalidateDownstream(input.projectId, [input.sceneId], now);
      this.resolveSceneMediaExceptions(input.projectId, input.sceneId, now, 'verified_storyboard_candidate');
      this.completeManualRevision(input.projectId, [input.sceneId], now);
      this.recordRangeRepair(input.projectId, input.sceneId, Number(before.ordinal), 'replace_shot', now);
      this.transitionForRecovery(input.projectId, 'BUILDING_TIMELINE', 'Operator selected a verified storyboard replacement', {
        sceneId: input.sceneId,
        candidateId: input.candidateId,
        scriptVersionId: version
      });
      this.audit(input.projectId, 'storyboard.replace_shot', input.sceneId, before, this.sceneRow(input.projectId, input.sceneId), {
        candidateId: input.candidateId,
        reason: input.reason,
        scriptVersionId: version
      }, now);
      return this.rangeOutcome(input.projectId, [input.sceneId], 'render_range');
    });
    return this.result('replace_shot', input.projectId, outcome);
  }

  rewriteBeat(input: {
    projectId: string;
    sceneId: string;
    narration: string;
    reason: string;
  }): StoryboardMutationResult {
    const outcome = this.withProjectLock(input.projectId, 'rewrite_beat', (_project, now) => {
      const before = this.sceneRow(input.projectId, input.sceneId);
      if (String(before.narration).trim() === input.narration.trim()) {
        throw new Error('The rewritten narration must differ from the current beat.');
      }
      this.assertNarrationClaimsPreserved(input.projectId, input.sceneId, input.narration);
      this.db.raw.prepare(`
        UPDATE project_scenes SET narration = ?, updated_at = ? WHERE id = ? AND project_id = ?
      `).run(input.narration.trim(), now, input.sceneId, input.projectId);
      const version = this.forkScript(input.projectId, 'operator_rewrite_beat', now, false);
      this.invalidateDownstream(input.projectId, [input.sceneId], now);
      this.completeManualRevision(input.projectId, [input.sceneId], now);
      this.transitionForRecovery(input.projectId, 'GENERATING_VOICE', 'Operator rewrote one storyboard narration beat', {
        sceneId: input.sceneId,
        scriptVersionId: version
      });
      this.audit(input.projectId, 'storyboard.rewrite_beat', input.sceneId, before, this.sceneRow(input.projectId, input.sceneId), {
        reason: input.reason,
        scriptVersionId: version,
        factualPolicy: 'linked_claims_preserved'
      }, now);
      return this.rangeOutcome(input.projectId, [input.sceneId], 'continue_workflow');
    });
    return this.result('rewrite_beat', input.projectId, outcome);
  }

  useGraphic(input: {
    projectId: string;
    sceneId: string;
    treatment: Extract<VisualTreatment, 'MAP_OR_GRAPHIC' | 'TEXT_OR_ARCHIVAL'>;
    reason: string;
  }): StoryboardMutationResult {
    const outcome = this.withProjectLock(input.projectId, 'use_graphic', (_project, now) => {
      const before = this.sceneRow(input.projectId, input.sceneId);
      this.assertGraphicEvidence(input.projectId, input.sceneId);
      this.assertGraphicNarrationSafe(input.projectId, [input.sceneId], String(before.narration));
      this.db.raw.prepare(`
        UPDATE project_scenes SET visual_treatment = ?, selected_asset_id = NULL,
          selected_file_id = NULL, selected_segment_id = NULL, score = NULL,
          score_explanation_json = ?, verification_state = 'graphic', updated_at = ?
        WHERE id = ? AND project_id = ?
      `).run(
        input.treatment,
        JSON.stringify([`Operator selected an evidence-bound ${input.treatment.toLowerCase().replaceAll('_', ' ')} treatment`, input.reason]),
        now,
        input.sceneId,
        input.projectId
      );
      this.db.raw.prepare(`
        UPDATE shot_candidates SET status = CASE WHEN status = 'selected' THEN 'eligible' ELSE status END,
          updated_at = ? WHERE scene_id = ?
      `).run(now, input.sceneId);
      this.dropVisualObservationLinks([input.sceneId]);
      const version = this.forkScript(input.projectId, 'operator_use_graphic', now, true);
      this.invalidateDownstream(input.projectId, [input.sceneId], now);
      this.resolveSceneMediaExceptions(input.projectId, input.sceneId, now, 'evidence_bound_graphic');
      this.completeManualRevision(input.projectId, [input.sceneId], now);
      this.recordRangeRepair(input.projectId, input.sceneId, Number(before.ordinal), 'use_graphic', now);
      this.transitionForRecovery(input.projectId, 'BUILDING_TIMELINE', 'Operator assigned an evidence-bound graphic treatment', {
        sceneId: input.sceneId,
        treatment: input.treatment,
        scriptVersionId: version
      });
      this.audit(input.projectId, 'storyboard.use_graphic', input.sceneId, before, this.sceneRow(input.projectId, input.sceneId), {
        treatment: input.treatment,
        reason: input.reason,
        scriptVersionId: version
      }, now);
      return this.rangeOutcome(input.projectId, [input.sceneId], 'render_range');
    });
    return this.result('use_graphic', input.projectId, outcome);
  }

  splitBeat(input: {
    projectId: string;
    sceneId: string;
    firstNarration: string;
    secondNarration: string;
    secondTreatment: Extract<VisualTreatment, 'MAP_OR_GRAPHIC' | 'TEXT_OR_ARCHIVAL'>;
    reason: string;
  }): StoryboardMutationResult {
    const outcome = this.withProjectLock(input.projectId, 'split_beat', (_project, now) => {
      const before = this.sceneRow(input.projectId, input.sceneId);
      const claimAssignments = this.splitClaimAssignments(
        input.projectId,
        input.sceneId,
        input.firstNarration,
        input.secondNarration
      );
      if (!before.required_place_id && !claimAssignments.secondAcceptedEvidence) {
        throw new Error('The second graphic beat requires a canonical place or an accepted factual claim assigned to its narration.');
      }
      const newSceneId = randomUUID();
      const originalOrdinal = Number(before.ordinal);
      const totalCharacters = input.firstNarration.trim().length + input.secondNarration.trim().length;
      const totalDuration = Math.max(3_000, Number(before.target_duration_ms));
      const firstDuration = Math.max(1_500, Math.min(7_000, Math.round(totalDuration * input.firstNarration.trim().length / totalCharacters)));
      const secondDuration = Math.max(1_500, Math.min(7_000, totalDuration - firstDuration));
      this.shiftOrdinals(input.projectId, originalOrdinal, 1);
      this.db.raw.prepare(`
        UPDATE project_scenes SET narration = ?, target_duration_ms = ?, updated_at = ? WHERE id = ?
      `).run(input.firstNarration.trim(), firstDuration, now, input.sceneId);
      this.db.raw.prepare(`
        INSERT INTO project_scenes(
          id, project_id, script_version_id, ordinal, chapter, narration,
          target_duration_ms, required_country, required_city, required_location,
          required_granularity, required_place_id, required_objects_json,
          required_activities_json, preferred_shots_json, visual_treatment,
          selected_asset_id, selected_file_id, selected_segment_id, score,
          score_explanation_json, verification_state, pronunciation_json,
          created_at, updated_at
        ) SELECT ?, project_id, script_version_id, ?, chapter, ?, ?, required_country,
          required_city, required_location, required_granularity, required_place_id,
          required_objects_json, required_activities_json, preferred_shots_json, ?,
          NULL, NULL, NULL, NULL, ?, 'graphic', pronunciation_json, ?, ?
        FROM project_scenes WHERE id = ? AND project_id = ?
      `).run(
        newSceneId,
        originalOrdinal + 1,
        input.secondNarration.trim(),
        secondDuration,
        input.secondTreatment,
        JSON.stringify(['Operator split the beat and assigned an evidence-bound graphic treatment', input.reason]),
        now,
        now,
        input.sceneId,
        input.projectId
      );
      this.db.raw.prepare('DELETE FROM project_scene_claims WHERE scene_id = ?').run(input.sceneId);
      const insertClaim = this.db.raw.prepare(`
        INSERT OR IGNORE INTO project_scene_claims(scene_id, claim_id) VALUES(?, ?)
      `);
      for (const claimId of claimAssignments.first) insertClaim.run(input.sceneId, claimId);
      for (const claimId of claimAssignments.second) insertClaim.run(newSceneId, claimId);
      const version = this.forkScript(input.projectId, 'operator_split_beat', now, false);
      const affectedIds = this.sceneIdsFromOrdinal(input.projectId, originalOrdinal);
      this.invalidateDownstream(input.projectId, affectedIds, now);
      this.completeManualRevision(input.projectId, [input.sceneId], now);
      this.transitionForRecovery(input.projectId, 'GENERATING_VOICE', 'Operator split one storyboard beat', {
        sourceSceneId: input.sceneId,
        newSceneId,
        scriptVersionId: version
      });
      this.audit(input.projectId, 'storyboard.split_beat', input.sceneId, before, {
        first: this.sceneRow(input.projectId, input.sceneId),
        second: this.sceneRow(input.projectId, newSceneId)
      }, { reason: input.reason, newSceneId, scriptVersionId: version }, now);
      return this.rangeOutcome(input.projectId, affectedIds, 'continue_workflow');
    });
    return this.result('split_beat', input.projectId, outcome);
  }

  mergeBeats(input: {
    projectId: string;
    firstSceneId: string;
    secondSceneId: string;
    narration: string;
    graphicTreatment?: Extract<VisualTreatment, 'MAP_OR_GRAPHIC' | 'TEXT_OR_ARCHIVAL'>;
    reason: string;
  }): StoryboardMutationResult {
    const outcome = this.withProjectLock(input.projectId, 'merge_beats', (_project, now) => {
      const first = this.sceneRow(input.projectId, input.firstSceneId);
      const second = this.sceneRow(input.projectId, input.secondSceneId);
      if (Number(second.ordinal) !== Number(first.ordinal) + 1) {
        throw new Error('Only adjacent storyboard beats can be merged.');
      }
      this.assertNarrationClaimsPreserved(input.projectId, input.firstSceneId, input.narration);
      this.assertNarrationClaimsPreserved(input.projectId, input.secondSceneId, input.narration);
      const sameVerifiedVisual = first.verification_state === 'verified'
        && second.verification_state === 'verified'
        && first.selected_asset_id
        && first.selected_asset_id === second.selected_asset_id
        && first.selected_file_id === second.selected_file_id
        && first.required_place_id === second.required_place_id;
      const sameGeography = ['required_place_id', 'required_country', 'required_city', 'required_location', 'required_granularity']
        .every(field => (first[field] ?? null) === (second[field] ?? null));
      if (!sameVerifiedVisual && !input.graphicTreatment) {
        throw new Error('Beats with different verified visuals can merge only into an explicit evidence-bound graphic treatment.');
      }
      if (!sameGeography) {
        throw new Error('Beats with different location contracts cannot be merged into a single-location scene. Rewrite them to one supported geography first.');
      }
      if (input.graphicTreatment) {
        this.assertGraphicEvidence(input.projectId, input.firstSceneId, input.secondSceneId);
        this.assertGraphicNarrationSafe(
          input.projectId,
          [input.firstSceneId, input.secondSceneId],
          input.narration
        );
      }
      const objects = unique([...jsonArray(first.required_objects_json), ...jsonArray(second.required_objects_json)]);
      const activities = unique([...jsonArray(first.required_activities_json), ...jsonArray(second.required_activities_json)]);
      const preferred = unique([...jsonArray(first.preferred_shots_json), ...jsonArray(second.preferred_shots_json)]);
      const pronunciation = { ...jsonObject(first.pronunciation_json), ...jsonObject(second.pronunciation_json) };
      this.db.raw.prepare(`
        INSERT OR IGNORE INTO project_scene_claims(scene_id, claim_id)
        SELECT ?, claim_id FROM project_scene_claims WHERE scene_id = ?
      `).run(input.firstSceneId, input.secondSceneId);
      if (input.graphicTreatment) this.dropVisualObservationLinks([input.firstSceneId]);
      this.db.raw.prepare(`
        UPDATE project_scenes SET narration = ?, target_duration_ms = ?,
          required_objects_json = ?, required_activities_json = ?, preferred_shots_json = ?,
          visual_treatment = ?, selected_asset_id = ?, selected_file_id = ?,
          selected_segment_id = ?, score = ?, score_explanation_json = ?,
          verification_state = ?, pronunciation_json = ?, updated_at = ?
        WHERE id = ? AND project_id = ?
      `).run(
        input.narration.trim(),
        Math.min(7_000, Number(first.target_duration_ms) + Number(second.target_duration_ms)),
        JSON.stringify(objects),
        JSON.stringify(activities),
        JSON.stringify(preferred),
        input.graphicTreatment ?? first.visual_treatment,
        input.graphicTreatment ? null : first.selected_asset_id,
        input.graphicTreatment ? null : first.selected_file_id,
        input.graphicTreatment ? null : first.selected_segment_id,
        input.graphicTreatment ? null : first.score,
        JSON.stringify([`Operator merged adjacent beats: ${input.reason}`]),
        input.graphicTreatment ? 'graphic' : 'verified',
        JSON.stringify(pronunciation),
        now,
        input.firstSceneId,
        input.projectId
      );
      this.db.raw.prepare('DELETE FROM project_scenes WHERE id = ? AND project_id = ?')
        .run(input.secondSceneId, input.projectId);
      this.shiftOrdinals(input.projectId, Number(second.ordinal), -1);
      const version = this.forkScript(input.projectId, 'operator_merge_beats', now, false);
      const affectedIds = this.sceneIdsFromOrdinal(input.projectId, Number(first.ordinal));
      this.invalidateDownstream(input.projectId, affectedIds, now);
      this.completeManualRevision(input.projectId, [input.firstSceneId, input.secondSceneId], now);
      this.transitionForRecovery(input.projectId, 'GENERATING_VOICE', 'Operator merged two adjacent storyboard beats', {
        firstSceneId: input.firstSceneId,
        removedSceneId: input.secondSceneId,
        scriptVersionId: version
      });
      this.audit(input.projectId, 'storyboard.merge_beats', input.firstSceneId, { first, second }, this.sceneRow(input.projectId, input.firstSceneId), {
        reason: input.reason,
        removedSceneId: input.secondSceneId,
        scriptVersionId: version
      }, now);
      return this.rangeOutcome(input.projectId, affectedIds, 'continue_workflow');
    });
    return this.result('merge_beats', input.projectId, outcome);
  }

  async verifyLocation(input: {
    projectId: string;
    sceneId: string;
    reason: string;
  }): Promise<StoryboardMutationResult> {
    const target = this.withProjectLock(input.projectId, 'verify_location', (_project, now) => {
      const scene = this.sceneRow(input.projectId, input.sceneId);
      if (!scene.selected_asset_id || !scene.selected_file_id || !scene.required_place_id) {
        throw new Error('Location verification requires selected media and a canonical required place.');
      }
      const evidence = this.places.recordHumanAssertion({
        assetId: String(scene.selected_asset_id),
        placeId: String(scene.required_place_id),
        reason: input.reason,
        evidenceRef: `storyboard:${input.sceneId}`,
        evidence: { projectId: input.projectId, sceneId: input.sceneId }
      });
      this.audit(input.projectId, 'storyboard.verify_location_requested', input.sceneId, null, evidence, {
        reason: input.reason,
        assetId: scene.selected_asset_id,
        assetFileId: scene.selected_file_id
      }, now);
      return {
        assetId: String(scene.selected_asset_id),
        fileId: String(scene.selected_file_id),
        placeId: String(scene.required_place_id)
      };
    });

    let decision: Awaited<ReturnType<FootageVerificationService['verifyScene']>>;
    try {
      decision = await this.footageVerification.verifyScene(
        input.projectId,
        input.sceneId,
        target.assetId,
        target.fileId
      );
    } catch (error) {
      this.blockVerificationFailure(input.projectId, input.sceneId, error);
      throw error;
    }

    const outcome = this.withProjectLock(input.projectId, 'verify_location', (_project, now) => {
      const current = this.sceneRow(input.projectId, input.sceneId);
      if (
        current.selected_asset_id !== target.assetId
        || current.selected_file_id !== target.fileId
        || current.required_place_id !== target.placeId
      ) {
        throw new Error('The storyboard changed while location verification was running. Reload the scene before applying new evidence.');
      }
      if (decision.status !== 'verified') {
        this.db.raw.prepare(`
          UPDATE project_scenes SET verification_state = 'rejected', updated_at = ? WHERE id = ?
        `).run(now, input.sceneId);
        this.ensureRecoveryException(input.projectId, input.sceneId, 'LOCATION_REVERIFICATION_FAILED',
          'Human location evidence did not satisfy complete footage verification.', {
            verificationId: decision.id,
            status: decision.status,
            reasons: decision.reasons
          }, now);
        this.transitionForRecovery(input.projectId, 'BLOCKED_EXCEPTION', 'Location re-verification remained unsafe', {
          sceneId: input.sceneId,
          verificationId: decision.id,
          status: decision.status
        });
        this.audit(input.projectId, 'storyboard.verify_location_failed', input.sceneId, null, decision, { reason: input.reason }, now);
        return this.rangeOutcome(input.projectId, [input.sceneId], 'manual_recovery');
      }
      this.db.raw.prepare(`
        UPDATE project_scenes SET verification_state = 'verified', updated_at = ? WHERE id = ?
      `).run(now, input.sceneId);
      this.invalidateDownstream(input.projectId, [input.sceneId], now);
      this.resolveSceneMediaExceptions(input.projectId, input.sceneId, now, 'human_location_reverified');
      this.completeManualRevision(input.projectId, [input.sceneId], now);
      const ordinal = Number(this.sceneRow(input.projectId, input.sceneId).ordinal);
      this.recordRangeRepair(input.projectId, input.sceneId, ordinal, 'verify_location', now);
      this.transitionForRecovery(input.projectId, 'BUILDING_TIMELINE', 'Human location evidence passed complete footage re-verification', {
        sceneId: input.sceneId,
        verificationId: decision.id
      });
      this.audit(input.projectId, 'storyboard.verify_location', input.sceneId, null, decision, { reason: input.reason }, now);
      return this.rangeOutcome(input.projectId, [input.sceneId], 'render_range');
    });
    return this.result('verify_location', input.projectId, outcome);
  }

  rejectCandidate(input: {
    projectId: string;
    sceneId: string;
    candidateId: string;
    reason: string;
  }): StoryboardMutationResult {
    const outcome = this.withProjectLock(input.projectId, 'reject_candidate', (_project, now) => {
      const before = this.sceneRow(input.projectId, input.sceneId);
      const candidate = this.db.raw.prepare(`
        SELECT id, asset_id, status FROM shot_candidates
        WHERE id = ? AND project_id = ? AND scene_id = ?
      `).get(input.candidateId, input.projectId, input.sceneId) as
        | { id: string; asset_id: string; status: string }
        | undefined;
      if (!candidate) throw new Error('The storyboard candidate does not belong to this scene.');
      if (candidate.status === 'rejected') throw new Error('The storyboard candidate is already rejected.');
      this.db.raw.prepare(`
        UPDATE shot_candidates SET status = 'rejected', updated_at = ? WHERE id = ?
      `).run(now, input.candidateId);
      const selected = String(before.selected_asset_id ?? '') === candidate.asset_id;
      if (selected) {
        this.db.raw.prepare(`
          UPDATE project_scenes SET selected_asset_id = NULL, selected_file_id = NULL,
            selected_segment_id = NULL, score = NULL, verification_state = 'rejected', updated_at = ?
          WHERE id = ?
        `).run(now, input.sceneId);
        this.invalidateDownstream(input.projectId, [input.sceneId], now);
        this.ensureRecoveryException(input.projectId, input.sceneId, 'OPERATOR_REJECTED_STORYBOARD_CANDIDATE',
          'The selected storyboard candidate was rejected and must be replaced before production can continue.', {
            candidateId: input.candidateId,
            assetId: candidate.asset_id,
            reason: input.reason
          }, now);
        this.transitionForRecovery(input.projectId, 'BLOCKED_EXCEPTION', 'Operator rejected the selected storyboard candidate', {
          sceneId: input.sceneId,
          candidateId: input.candidateId
        });
      }
      this.audit(input.projectId, 'storyboard.reject_candidate', input.sceneId, before, this.sceneRow(input.projectId, input.sceneId), {
        candidateId: input.candidateId,
        assetId: candidate.asset_id,
        selected,
        reason: input.reason
      }, now);
      return this.rangeOutcome(input.projectId, selected ? [input.sceneId] : [], 'manual_recovery');
    });
    return this.result('reject_candidate', input.projectId, outcome);
  }

  private withProjectLock<T>(
    projectId: string,
    action: StoryboardRecoveryAction,
    work: (project: LockedProject, now: string) => T
  ): T {
    return this.db.raw.transaction(() => {
      const row = this.db.raw.prepare(`
        SELECT state, script_version_id, locked_by_job_id FROM projects WHERE id = ?
      `).get(projectId) as {
        state: ProjectState;
        script_version_id: string | null;
        locked_by_job_id: string | null;
      } | undefined;
      if (!row) throw new Error('Project not found.');
      if (!EDITABLE_STATES.has(row.state)) {
        throw new Error(`Storyboard recovery is unavailable while the project is ${row.state}.`);
      }
      if (row.locked_by_job_id) {
        throw new Error('Wait for the active project job to reach a safe checkpoint before editing the storyboard.');
      }
      const operationId = `storyboard-${action}-${randomUUID()}`;
      const acquired = this.db.raw.prepare(`
        UPDATE projects SET locked_by_job_id = ?
        WHERE id = ? AND locked_by_job_id IS NULL
      `).run(operationId, projectId);
      if (Number(acquired.changes) !== 1) {
        throw new Error('The project became busy before the storyboard edit could start.');
      }
      const now = new Date().toISOString();
      try {
        return work({ state: row.state, scriptVersionId: row.script_version_id }, now);
      } finally {
        this.db.raw.prepare(`
          UPDATE projects SET locked_by_job_id = NULL WHERE id = ? AND locked_by_job_id = ?
        `).run(projectId, operationId);
      }
    })();
  }

  private sceneRow(projectId: string, sceneId: string): Record<string, unknown> {
    const row = this.db.raw.prepare(`
      SELECT * FROM project_scenes WHERE id = ? AND project_id = ?
    `).get(sceneId, projectId) as Record<string, unknown> | undefined;
    if (!row) throw new Error('Storyboard scene not found.');
    return row;
  }

  private forkScript(projectId: string, generationReason: string, now: string, cloneNarration: boolean): string {
    const project = this.db.raw.prepare(`
      SELECT script_version_id FROM projects WHERE id = ?
    `).get(projectId) as { script_version_id: string | null };
    if (!project.script_version_id) throw new Error('Storyboard recovery requires an active script version.');
    const source = this.db.raw.prepare(`
      SELECT * FROM script_versions WHERE id = ? AND project_id = ?
    `).get(project.script_version_id, projectId) as Record<string, unknown> | undefined;
    if (!source) throw new Error('The active script version is missing.');
    const sourceJson = jsonObject(source.script_json);
    const sourceScenes = Array.isArray(sourceJson.scenes)
      ? sourceJson.scenes.filter(scene => scene && typeof scene === 'object') as Array<Record<string, unknown>>
      : [];
    const sourceById = new Map(sourceScenes.flatMap(scene =>
      typeof scene.sceneId === 'string' ? [[scene.sceneId, scene] as const] : []
    ));
    const rows = this.db.raw.prepare(`
      SELECT * FROM project_scenes WHERE project_id = ? ORDER BY ordinal
    `).all(projectId) as Array<Record<string, unknown>>;
    const scriptScenes = rows.map((row, index) => ({
      ...(sourceById.get(String(row.id)) ?? sourceScenes[index] ?? {}),
      sceneId: String(row.id),
      chapter: row.chapter ? String(row.chapter) : null,
      narration: String(row.narration),
      targetDurationMs: Number(row.target_duration_ms),
      requiredCountry: row.required_country ? String(row.required_country) : null,
      requiredCity: row.required_city ? String(row.required_city) : null,
      requiredLocation: row.required_location ? String(row.required_location) : null,
      requiredGranularity: String(row.required_granularity),
      requiredObjects: jsonArray(row.required_objects_json),
      requiredActivities: jsonArray(row.required_activities_json),
      preferredShots: jsonArray(row.preferred_shots_json),
      visualTreatment: String(row.visual_treatment),
      selectedAssetId: row.selected_asset_id ? String(row.selected_asset_id) : null,
      selectedFileId: row.selected_file_id ? String(row.selected_file_id) : null,
      selectedSegmentId: row.selected_segment_id ? String(row.selected_segment_id) : null,
      pronunciation: jsonObject(row.pronunciation_json)
    }));
    const versionNumber = Number((this.db.raw.prepare(`
      SELECT coalesce(max(version_number), 0) + 1 AS next FROM script_versions WHERE project_id = ?
    `).get(projectId) as { next: number }).next);
    const id = randomUUID();
    const scriptJson = { ...sourceJson, scenes: scriptScenes };
    const inputHash = createHash('sha256').update(JSON.stringify({
      parentId: source.id,
      generationReason,
      scriptJson
    })).digest('hex');
    this.db.raw.prepare(`
      INSERT INTO script_versions(
        id, project_id, parent_id, version_number, title, topic, summary,
        script_json, generation_reason, provider, model, input_hash, locked,
        script_type, locked_at, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'operator', 'manual-recovery', ?, 1, ?, ?, ?)
    `).run(
      id,
      projectId,
      source.id,
      versionNumber,
      source.title,
      source.topic,
      source.summary,
      JSON.stringify(scriptJson),
      generationReason,
      inputHash,
      source.script_type ?? 'final',
      now,
      now
    );
    this.db.raw.prepare(`
      UPDATE project_scenes SET script_version_id = ?, updated_at = ? WHERE project_id = ?
    `).run(id, now, projectId);
    this.db.raw.prepare(`
      UPDATE projects SET script_version_id = ?, updated_at = ? WHERE id = ?
    `).run(id, now, projectId);
    if (cloneNarration) this.cloneNarrationVersion(projectId, String(source.id), id, now);
    return id;
  }

  private cloneNarrationVersion(projectId: string, sourceVersionId: string, targetVersionId: string, now: string): void {
    const sections = this.db.raw.prepare(`
      SELECT n.* FROM narration_sections n
      JOIN voice_assets v ON v.id = n.voice_asset_id AND v.status = 'ready'
      WHERE n.project_id = ? AND n.script_version_id = ? AND n.status = 'ready'
      ORDER BY n.ordinal
    `).all(projectId, sourceVersionId) as Array<Record<string, unknown>>;
    for (const section of sections) {
      const sectionId = randomUUID();
      this.db.raw.prepare(`
        INSERT INTO narration_sections(
          id, project_id, script_version_id, voice_asset_id, ordinal, chapter,
          scene_ids_json, text, pronunciation_json, duration_ms, status, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)
      `).run(
        sectionId,
        projectId,
        targetVersionId,
        section.voice_asset_id,
        section.ordinal,
        section.chapter,
        section.scene_ids_json,
        section.text,
        section.pronunciation_json,
        section.duration_ms,
        now,
        now
      );
      const words = this.db.raw.prepare(`
        SELECT * FROM narration_words WHERE section_id = ? ORDER BY ordinal
      `).all(section.id) as Array<Record<string, unknown>>;
      const insertWord = this.db.raw.prepare(`
        INSERT INTO narration_words(
          id, section_id, scene_id, ordinal, word, start_ms, end_ms, confidence, timing_method
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const word of words) {
        insertWord.run(randomUUID(), sectionId, word.scene_id, word.ordinal, word.word,
          word.start_ms, word.end_ms, word.confidence, word.timing_method);
      }
    }
  }

  private invalidateDownstream(projectId: string, sceneIds: string[], now: string): void {
    const ids = unique(sceneIds);
    if (ids.length) {
      this.db.raw.prepare(`
        UPDATE render_fragments SET status = 'stale', updated_at = ?
        WHERE project_id = ? AND scene_id IN (${ids.map(() => '?').join(',')}) AND status = 'ready'
      `).run(now, projectId, ...ids);
    }
    this.db.raw.prepare(`
      UPDATE projects SET final_render_id = NULL, youtube_video_id = NULL, updated_at = ? WHERE id = ?
    `).run(now, projectId);
    this.db.raw.prepare(`
      UPDATE packaging_candidates SET risk_status = 'blocked' WHERE project_id = ?
    `).run(projectId);
    this.db.raw.prepare(`
      UPDATE publication_records SET approval_hash = NULL, approved_at = NULL, updated_at = ?
      WHERE project_id = ?
    `).run(now, projectId);
  }

  private transitionForRecovery(
    projectId: string,
    target: ProjectState,
    reason: string,
    prerequisites: Record<string, unknown>
  ): void {
    let current = (this.db.raw.prepare('SELECT state FROM projects WHERE id = ?').get(projectId) as { state: ProjectState }).state;
    if (current === target) return;
    if (!canTransitionProject(current, target)) {
      if (!canTransitionProject(current, 'BLOCKED_EXCEPTION')) {
        throw new Error(`Storyboard recovery cannot route ${current} to ${target}.`);
      }
      this.projects.states.transition(projectId, 'BLOCKED_EXCEPTION', {
        reason: `Manual storyboard recovery interrupted ${current}`,
        prerequisites: { ...prerequisites, intendedRecoveryState: target }
      });
      current = 'BLOCKED_EXCEPTION';
    }
    if (current !== target) {
      this.projects.states.transition(projectId, target, { reason, prerequisites });
    }
  }

  private resolveSceneMediaExceptions(projectId: string, sceneId: string, now: string, method: string): void {
    this.db.raw.prepare(`
      UPDATE exceptions SET status = 'RESOLVED', resolved_at = ?, resolution_json = ?
      WHERE project_id = ? AND status = 'OPEN' AND stage = 'media'
        AND json_extract(evidence_json, '$.sceneId') = ?
    `).run(now, JSON.stringify({ method, sceneId }), projectId, sceneId);
  }

  private completeManualRevision(projectId: string, sceneIds: string[], now: string): void {
    const ids = unique(sceneIds);
    if (!ids.length) return;
    this.db.raw.prepare(`
      UPDATE revision_requests SET status = 'completed', completed_at = ?
      WHERE project_id = ? AND status = 'requested'
        AND (affected_scene_id IS NULL OR affected_scene_id IN (${ids.map(() => '?').join(',')}))
    `).run(now, projectId, ...ids);
  }

  private recordRangeRepair(
    projectId: string,
    sceneId: string,
    ordinal: number,
    action: StoryboardRecoveryAction,
    now: string
  ): void {
    this.db.raw.prepare(`
      INSERT INTO repair_attempts(
        id, project_id, scene_id, failure_code, repair_class, action, status,
        attempt_number, maximum_attempts, range_start_ordinal, range_end_ordinal,
        target_state, evidence_json, created_at
      ) VALUES(?, ?, NULL, 'OPERATOR_STORYBOARD_EDIT', 'regenerate_range', ?, 'routed',
        1, 1, ?, ?, 'BUILDING_TIMELINE', ?, ?)
    `).run(
      randomUUID(),
      projectId,
      `Regenerate the operator-edited scene range after ${action.replaceAll('_', ' ')}.`,
      ordinal,
      ordinal,
      JSON.stringify({ sceneId, action, selectedBy: 'operator' }),
      now
    );
  }

  private assertGraphicEvidence(projectId: string, ...sceneIds: string[]): void {
    const ids = unique(sceneIds);
    const evidence = this.db.raw.prepare(`
      SELECT count(*) AS count FROM project_scenes s
      WHERE s.project_id = ? AND s.id IN (${ids.map(() => '?').join(',')})
        AND (
          s.required_place_id IS NOT NULL
          OR EXISTS (
            SELECT 1 FROM project_scene_claims sc
            JOIN fact_claims c ON c.id = sc.claim_id AND c.status = 'accepted'
            WHERE sc.scene_id = s.id AND c.category <> 'visual_observation' AND c.material = 1
              AND EXISTS (
                SELECT 1 FROM fact_claim_sources citation
                JOIN research_sources source ON source.id = citation.source_id
                WHERE citation.claim_id = c.id AND citation.support_type = 'supports'
                  AND source.project_id = c.project_id AND source.status = 'active'
              )
          )
        )
    `).get(projectId, ...ids) as { count: number };
    if (Number(evidence.count) !== ids.length) {
      throw new Error('A generated graphic requires persisted place or accepted-claim evidence for every affected beat.');
    }
  }

  private assertGraphicNarrationSafe(projectId: string, sceneIds: string[], narration: string): void {
    const ids = unique(sceneIds);
    if (!ids.length) return;
    const visualClaims = this.db.raw.prepare(`
      SELECT DISTINCT c.id, c.text FROM project_scene_claims sc
      JOIN fact_claims c ON c.id = sc.claim_id
      WHERE c.project_id = ? AND c.status = 'accepted' AND c.category = 'visual_observation'
        AND sc.scene_id IN (${ids.map(() => '?').join(',')})
      ORDER BY c.id
    `).all(projectId, ...ids) as Array<{ id: string; text: string }>;
    const normalized = narration.toLocaleLowerCase('en-US');
    const unsupported = visualClaims.filter(claim => normalized.includes(claim.text.toLocaleLowerCase('en-US')));
    if (unsupported.length) {
      throw new Error(`A graphic cannot preserve footage-only visual claim(s): ${unsupported.map(claim => claim.id).join(', ')}. Rewrite the narration first.`);
    }
  }

  private dropVisualObservationLinks(sceneIds: string[]): void {
    const ids = unique(sceneIds);
    if (!ids.length) return;
    this.db.raw.prepare(`
      DELETE FROM project_scene_claims
      WHERE scene_id IN (${ids.map(() => '?').join(',')})
        AND claim_id IN (SELECT id FROM fact_claims WHERE category = 'visual_observation')
    `).run(...ids);
  }

  private splitClaimAssignments(
    projectId: string,
    sceneId: string,
    firstNarration: string,
    secondNarration: string
  ): { first: string[]; second: string[]; secondAcceptedEvidence: boolean } {
    const claims = this.db.raw.prepare(`
      SELECT c.id, c.text, c.status, c.category, c.material,
        EXISTS (
          SELECT 1 FROM fact_claim_sources citation
          JOIN research_sources source ON source.id = citation.source_id
          WHERE citation.claim_id = c.id AND citation.support_type = 'supports'
            AND source.project_id = c.project_id AND source.status = 'active'
        ) AS source_valid
      FROM project_scene_claims sc
      JOIN fact_claims c ON c.id = sc.claim_id
      WHERE sc.scene_id = ? AND c.project_id = ? ORDER BY c.id
    `).all(sceneId, projectId) as Array<{
      id: string;
      text: string;
      status: string;
      category: string;
      material: number;
      source_valid: number;
    }>;
    const firstText = firstNarration.toLocaleLowerCase('en-US');
    const secondText = secondNarration.toLocaleLowerCase('en-US');
    const first: string[] = [];
    const second: string[] = [];
    let secondAcceptedEvidence = false;
    for (const claim of claims) {
      if (claim.status !== 'accepted' || claim.category === 'visual_observation') {
        first.push(claim.id);
        continue;
      }
      const normalizedClaim = claim.text.toLocaleLowerCase('en-US');
      const inFirst = firstText.includes(normalizedClaim);
      const inSecond = secondText.includes(normalizedClaim);
      if (!inFirst && !inSecond) {
        throw new Error(`The split removed or divided linked accepted claim ${claim.id}. Keep the complete claim in one narration beat.`);
      }
      if (inFirst) first.push(claim.id);
      if (inSecond) {
        second.push(claim.id);
        secondAcceptedEvidence ||= Boolean(claim.material && claim.source_valid);
      }
    }
    return { first, second, secondAcceptedEvidence };
  }

  private assertNarrationClaimsPreserved(projectId: string, sceneId: string, narration: string): void {
    const claims = this.db.raw.prepare(`
      SELECT c.id, c.text FROM project_scene_claims sc
      JOIN fact_claims c ON c.id = sc.claim_id
      WHERE sc.scene_id = ? AND c.project_id = ? AND c.status = 'accepted'
        AND c.category <> 'visual_observation'
      ORDER BY c.id
    `).all(sceneId, projectId) as Array<{ id: string; text: string }>;
    const normalized = narration.toLocaleLowerCase('en-US');
    const missing = claims.filter(claim => !normalized.includes(claim.text.toLocaleLowerCase('en-US')));
    if (missing.length) {
      throw new Error(`The rewrite removed or changed linked accepted claim(s): ${missing.map(claim => claim.id).join(', ')}.`);
    }
  }

  private shiftOrdinals(projectId: string, pivot: number, direction: 1 | -1): void {
    if (direction === 1) {
      this.db.raw.prepare(`
        UPDATE project_scenes SET ordinal = ordinal + 100000 WHERE project_id = ? AND ordinal > ?
      `).run(projectId, pivot);
      this.db.raw.prepare(`
        UPDATE project_scenes SET ordinal = ordinal - 99999 WHERE project_id = ? AND ordinal > 100000 + ?
      `).run(projectId, pivot);
      return;
    }
    this.db.raw.prepare(`
      UPDATE project_scenes SET ordinal = ordinal + 100000 WHERE project_id = ? AND ordinal > ?
    `).run(projectId, pivot);
    this.db.raw.prepare(`
      UPDATE project_scenes SET ordinal = ordinal - 100001 WHERE project_id = ? AND ordinal > 100000 + ?
    `).run(projectId, pivot);
  }

  private sceneIdsFromOrdinal(projectId: string, ordinal: number): string[] {
    return (this.db.raw.prepare(`
      SELECT id FROM project_scenes WHERE project_id = ? AND ordinal >= ? ORDER BY ordinal
    `).all(projectId, ordinal) as Array<{ id: string }>).map(row => row.id);
  }

  private rangeOutcome(
    projectId: string,
    sceneIds: string[],
    nextAction: StoryboardMutationResult['nextAction']
  ): MutationOutcome {
    const ids = unique(sceneIds);
    if (!ids.length) return { affectedSceneIds: [], affectedRange: null, nextAction };
    const rows = this.db.raw.prepare(`
      SELECT id, ordinal FROM project_scenes
      WHERE project_id = ? AND id IN (${ids.map(() => '?').join(',')}) ORDER BY ordinal
    `).all(projectId, ...ids) as Array<{ id: string; ordinal: number }>;
    const ordinals = rows.map(row => Number(row.ordinal));
    return {
      affectedSceneIds: rows.map(row => row.id),
      affectedRange: ordinals.length ? {
        startSceneOrdinal: Math.min(...ordinals),
        endSceneOrdinal: Math.max(...ordinals),
        sceneOrdinals: ordinals
      } : null,
      nextAction
    };
  }

  private result(
    action: StoryboardRecoveryAction,
    projectId: string,
    outcome: MutationOutcome
  ): StoryboardMutationResult {
    return { action, project: this.projects.get(projectId), ...outcome };
  }

  private ensureRecoveryException(
    projectId: string,
    sceneId: string,
    code: string,
    message: string,
    evidence: Record<string, unknown>,
    now: string
  ): void {
    const existing = this.db.raw.prepare(`
      SELECT id FROM exceptions WHERE project_id = ? AND code = ? AND status = 'OPEN'
        AND json_extract(evidence_json, '$.sceneId') = ? LIMIT 1
    `).get(projectId, code, sceneId);
    if (existing) return;
    this.db.raw.prepare(`
      INSERT INTO exceptions(
        id, project_id, severity, stage, code, title, message, evidence_json,
        recommended_action, safe_alternatives_json, status, created_at
      ) VALUES(?, ?, 'BLOCKER', 'media', ?, 'Storyboard recovery needs attention', ?, ?,
        'Compare verified candidates, use an evidence-bound graphic, or rewrite the beat.', ?, 'OPEN', ?)
    `).run(
      randomUUID(),
      projectId,
      code,
      message,
      JSON.stringify({ ...evidence, sceneId }),
      JSON.stringify(['Select verified alternate', 'Use evidence-bound graphic', 'Rewrite beat']),
      now
    );
  }

  private blockVerificationFailure(projectId: string, sceneId: string, error: unknown): void {
    this.withProjectLock(projectId, 'verify_location', (_project, now) => {
      const message = error instanceof Error ? error.message : String(error);
      this.ensureRecoveryException(projectId, sceneId, 'LOCATION_REVERIFICATION_FAILED', message, {}, now);
      this.transitionForRecovery(projectId, 'BLOCKED_EXCEPTION', 'Location re-verification failed closed', {
        sceneId,
        error: message
      });
    });
  }

  private audit(
    projectId: string,
    action: string,
    entityId: string,
    before: unknown,
    after: unknown,
    metadata: Record<string, unknown>,
    now: string
  ): void {
    this.db.raw.prepare(`
      INSERT INTO audit_log(
        project_id, action, actor, entity_type, entity_id,
        before_json, after_json, metadata_json, created_at
      ) VALUES(?, ?, 'human', 'scene', ?, ?, ?, ?, ?)
    `).run(
      projectId,
      action,
      entityId,
      JSON.stringify(before ?? {}),
      JSON.stringify(after ?? {}),
      JSON.stringify(metadata),
      now
    );
  }
}
