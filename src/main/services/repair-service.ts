import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { AppDatabase } from '../database/database';
import type { ProjectState, RepairAttempt, RepairAttemptStatus, RepairClass } from '@shared/types';
import {
  earliestSafeRepairState,
  repairPolicyFor,
  type RepairPolicy
} from '@shared/repair-policy';
import { geographySatisfies, type Granularity } from '@shared/geography';

const ACCEPTED_LICENSE_STATES = new Set([
  'OPERATOR_ATTESTED',
  'CERTIFICATE_ATTACHED',
  'VERIFIED',
  'NOT_REQUIRED'
]);

function parseObject(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value ?? '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseArray(value: unknown): unknown[] {
  try {
    const parsed = JSON.parse(String(value ?? '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toRepairAttempt(row: Record<string, unknown>): RepairAttempt {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    sceneId: row.scene_id ? String(row.scene_id) : null,
    renderId: row.render_id ? String(row.render_id) : null,
    qcResultId: row.qc_result_id ? String(row.qc_result_id) : null,
    failureCode: String(row.failure_code),
    repairClass: row.repair_class as RepairClass,
    action: String(row.action),
    status: row.status as RepairAttemptStatus,
    attemptNumber: Number(row.attempt_number),
    maximumAttempts: Number(row.maximum_attempts),
    sourceAssetId: row.source_asset_id ? String(row.source_asset_id) : null,
    replacementAssetId: row.replacement_asset_id ? String(row.replacement_asset_id) : null,
    replacementFileId: row.replacement_file_id ? String(row.replacement_file_id) : null,
    replacementSegmentId: row.replacement_segment_id ? String(row.replacement_segment_id) : null,
    sourceArtifactVersion: row.source_artifact_version === null || row.source_artifact_version === undefined
      ? null : Number(row.source_artifact_version),
    rangeStartOrdinal: row.range_start_ordinal === null || row.range_start_ordinal === undefined
      ? null : Number(row.range_start_ordinal),
    rangeEndOrdinal: row.range_end_ordinal === null || row.range_end_ordinal === undefined
      ? null : Number(row.range_end_ordinal),
    targetState: row.target_state ? row.target_state as ProjectState : null,
    evidence: parseObject(row.evidence_json),
    createdAt: String(row.created_at),
    completedAt: row.completed_at ? String(row.completed_at) : null
  };
}

interface QcFailure {
  id: string;
  code: string;
  category: string;
  severity: 'BLOCKER' | 'HIGH';
  message: string;
  evidenceJson: string;
}

export interface QcRepairRoute {
  retryAutomatically: boolean;
  waitingForAcquisition: boolean;
  targetState: ProjectState | null;
  retrySequence: number;
  operatorRequired: boolean;
  exhausted: boolean;
}

export interface SceneRepairRoute {
  status: 'verified' | 'waiting_acquisition' | 'exhausted' | 'operator_required';
  attemptId: string | null;
  replacementAssetId: string | null;
}

interface CandidateReadiness {
  candidate: Record<string, unknown>;
  fileId: string | null;
  segmentId: string | null;
  acquisitionState: string | null;
  licenseState: string | null;
  semanticStatus: string | null;
  ready: boolean;
  permanentlyFailed: boolean;
}

export class RepairService {
  constructor(private readonly db: AppDatabase) {}

  list(projectId: string): RepairAttempt[] {
    return (this.db.raw.prepare(`
      SELECT * FROM repair_attempts
      WHERE project_id = ?
      ORDER BY created_at DESC, id DESC
    `).all(projectId) as Array<Record<string, unknown>>).map(toRepairAttempt);
  }

  routeQcFailures(projectId: string, renderId: string, failures: QcFailure[]): QcRepairRoute {
    const targets: Array<ProjectState | null> = [];
    let retrySequence = 0;
    let waitingForAcquisition = false;
    const sceneRoutesByOrdinal = new Map<number, SceneRepairRoute>();
    const decisions = failures.map(failure => {
      const evidence = parseObject(failure.evidenceJson);
      const ordinals = Array.isArray(evidence.ordinals)
        ? [...new Set(evidence.ordinals.map(Number).filter(Number.isFinite))]
        : [];
      return {
        failure,
        evidence,
        ordinals,
        policy: repairPolicyFor(failure.code, failure.category),
        attempts: this.attemptCount(projectId, null, failure.code)
      };
    });
    const supportsAutomaticQcRoute = (decision: typeof decisions[number]): boolean =>
      decision.policy.repairClass === 'alternate'
        ? decision.ordinals.length > 0
        : decision.policy.repairClass === 'automatic'
      || (decision.policy.repairClass === 'regenerate_range' && decision.policy.maximumAttempts > 0);
    const operatorRequiredBeforeRouting = decisions.some(decision =>
      !decision.policy.maximumAttempts || !decision.policy.targetState || !supportsAutomaticQcRoute(decision)
    );
    const exhaustedBeforeRouting = decisions.some(({ policy, attempts }) =>
      policy.repairClass !== 'alternate'
      && Boolean(policy.maximumAttempts && policy.targetState && attempts >= policy.maximumAttempts)
    );
    let operatorRequired = operatorRequiredBeforeRouting;
    let exhausted = exhaustedBeforeRouting;
    const supportsNonSceneAutomaticRoute = (policy: RepairPolicy): boolean =>
      policy.repairClass === 'automatic'
      || (policy.repairClass === 'regenerate_range' && policy.maximumAttempts > 0);

    this.completeClearedRenderRepairs(projectId, renderId, new Set(failures.map(failure => failure.code)));

    for (const { failure, policy, attempts, evidence, ordinals } of decisions) {
      this.db.raw.prepare(`
        UPDATE qc_results SET repair_class = ?, repair_action = ? WHERE id = ?
      `).run(policy.repairClass, policy.action, failure.id);

      if (!policy.maximumAttempts || !policy.targetState || !supportsAutomaticQcRoute({ failure, policy, attempts, evidence, ordinals })) {
        this.recordQcAttempt(projectId, renderId, failure, policy, 'operator_required', 0);
        continue;
      }

      if (policy.repairClass !== 'alternate' && attempts >= policy.maximumAttempts) {
        this.recordQcAttempt(projectId, renderId, failure, policy, 'exhausted', attempts);
        continue;
      }

      if (operatorRequiredBeforeRouting || exhaustedBeforeRouting) continue;

      if (policy.repairClass === 'alternate') {
        const scenes = this.db.raw.prepare(`
          SELECT id, ordinal FROM project_scenes
          WHERE project_id = ? AND ordinal IN (${ordinals.map(() => '?').join(',')})
          ORDER BY ordinal
        `).all(projectId, ...ordinals) as Array<{ id: string; ordinal: number }>;
        if (scenes.length !== ordinals.length) {
          operatorRequired = true;
          this.recordQcAttempt(projectId, renderId, failure, policy, 'operator_required', 0);
          continue;
        }
        const sceneRoutes = scenes.map(scene => {
          const priorRoute = sceneRoutesByOrdinal.get(scene.ordinal);
          if (priorRoute) return priorRoute;
          const route = this.routeFootageFailure(
            projectId,
            scene.id,
            failure.code,
            { ...evidence, renderId, qcResultId: failure.id, sceneOrdinal: scene.ordinal }
          );
          sceneRoutesByOrdinal.set(scene.ordinal, route);
          return route;
        });
        if (sceneRoutes.some(route => route.status === 'operator_required')) operatorRequired = true;
        if (sceneRoutes.some(route => route.status === 'exhausted')) exhausted = true;
        waitingForAcquisition ||= sceneRoutes.some(route => route.status === 'waiting_acquisition');
        const targetState: ProjectState = waitingForAcquisition ? 'WAITING_FOR_DOWNLOADS' : 'FINALIZING_SCRIPT';
        const aggregatePolicy = { ...policy, targetState };
        const aggregateStatus: RepairAttemptStatus = operatorRequired
          ? 'operator_required'
          : exhausted ? 'exhausted' : 'routed';
        this.recordQcAttempt(projectId, renderId, failure, aggregatePolicy, aggregateStatus, attempts + 1);
        if (!operatorRequired && !exhausted) {
          targets.push(targetState);
          retrySequence = Math.max(retrySequence, attempts + 1);
          this.db.raw.prepare('UPDATE qc_results SET repair_attempted = 1 WHERE id = ?').run(failure.id);
        }
        continue;
      }

      if (!supportsNonSceneAutomaticRoute(policy)) continue;

      const attemptNumber = attempts + 1;
      retrySequence = Math.max(retrySequence, attemptNumber);
      targets.push(policy.targetState);
      this.recordQcAttempt(projectId, renderId, failure, policy, 'routed', attemptNumber);
      this.db.raw.prepare(`
        UPDATE qc_results SET repair_attempted = 1 WHERE id = ?
      `).run(failure.id);
    }

    const targetState = earliestSafeRepairState(targets);
    return {
      retryAutomatically: Boolean(targetState) && !operatorRequired && !exhausted && !waitingForAcquisition,
      waitingForAcquisition: Boolean(targetState) && !operatorRequired && !exhausted && waitingForAcquisition,
      targetState,
      retrySequence,
      operatorRequired,
      exhausted
    };
  }

  completeClearedRenderRepairs(
    projectId: string,
    replacementRenderId: string,
    currentFailureCodes: Set<string>
  ): void {
    const open = this.db.raw.prepare(`
      SELECT * FROM repair_attempts
      WHERE project_id = ? AND scene_id IS NULL AND status = 'routed'
      ORDER BY created_at
    `).all(projectId) as Array<Record<string, unknown>>;
    const now = new Date().toISOString();
    for (const attempt of open) {
      if (currentFailureCodes.has(String(attempt.failure_code))) {
        if (String(attempt.render_id) !== replacementRenderId) {
          this.db.raw.prepare(`
            UPDATE repair_attempts SET status = 'failed', completed_at = ?,
              evidence_json = ? WHERE id = ?
          `).run(
            now,
            JSON.stringify({
              ...parseObject(attempt.evidence_json),
              replacementRenderId,
              failure: 'qc_failure_persisted_after_rebuild'
            }),
            attempt.id
          );
        }
        continue;
      }
      this.db.raw.prepare(`
        UPDATE repair_attempts SET status = 'verified', completed_at = ?,
          evidence_json = ? WHERE id = ?
      `).run(
        now,
        JSON.stringify({
          ...parseObject(attempt.evidence_json),
          replacementRenderId,
          verifiedBy: 'subsequent_qc_pass'
        }),
        attempt.id
      );
      if (attempt.qc_result_id) {
        this.db.raw.prepare(`
          UPDATE qc_results SET status = 'repaired', repair_attempted = 1
          WHERE id = ?
        `).run(attempt.qc_result_id);
      }
    }
    if (open.some(attempt => !currentFailureCodes.has(String(attempt.failure_code)))) {
      this.audit(projectId, 'repair.render_verified', 'render', replacementRenderId, {
        clearedFailureCodes: open
          .filter(attempt => !currentFailureCodes.has(String(attempt.failure_code)))
          .map(attempt => String(attempt.failure_code))
      });
    }
  }

  routeFootageFailure(
    projectId: string,
    sceneId: string,
    failureCode: string,
    evidence: Record<string, unknown> = {}
  ): SceneRepairRoute {
    const scene = this.db.raw.prepare(`
      SELECT id, ordinal, selected_asset_id, required_country, required_city,
        required_location, required_granularity FROM project_scenes
      WHERE id = ? AND project_id = ?
    `).get(sceneId, projectId) as Record<string, unknown> | undefined;
    if (!scene) throw new Error('Scene repair target not found.');

    const waiting = this.db.raw.prepare(`
      SELECT * FROM repair_attempts
      WHERE project_id = ? AND scene_id = ? AND failure_code = ?
        AND status = 'waiting_acquisition'
      ORDER BY attempt_number DESC LIMIT 1
    `).get(projectId, sceneId, failureCode) as Record<string, unknown> | undefined;
    if (waiting?.replacement_asset_id) {
      const readiness = this.candidateReadiness(
        projectId,
        sceneId,
        String(waiting.replacement_asset_id)
      );
      const geographySafe = readiness
        ? this.candidateGeographySatisfies(scene, readiness.candidate)
        : false;
      if (readiness?.ready && geographySafe) {
        this.promoteCandidate(scene, readiness, waiting);
        return {
          status: 'verified',
          attemptId: String(waiting.id),
          replacementAssetId: String(waiting.replacement_asset_id)
        };
      }
      if (readiness && !readiness.permanentlyFailed && geographySafe) {
        return {
          status: 'waiting_acquisition',
          attemptId: String(waiting.id),
          replacementAssetId: String(waiting.replacement_asset_id)
        };
      }
      this.failWaitingAttempt(waiting, readiness);
    }

    const policy = repairPolicyFor(failureCode, 'media');
    const attemptNumber = this.attemptCount(projectId, sceneId, failureCode) + 1;
    if (attemptNumber > policy.maximumAttempts) {
      const existing = this.db.raw.prepare(`
        SELECT id FROM repair_attempts
        WHERE project_id = ? AND scene_id = ? AND failure_code = ? AND status = 'exhausted'
        LIMIT 1
      `).get(projectId, sceneId, failureCode) as { id: string } | undefined;
      const id = existing?.id ?? this.insertAttempt({
        projectId,
        sceneId,
        failureCode,
        policy,
        status: 'exhausted',
        attemptNumber: Math.max(0, attemptNumber - 1),
        sourceAssetId: scene.selected_asset_id ? String(scene.selected_asset_id) : null,
        evidence: { ...evidence, reason: 'automatic_attempt_limit_reached' }
      });
      this.blockSceneClosed(projectId, scene, failureCode, id, evidence);
      return { status: 'exhausted', attemptId: id, replacementAssetId: null };
    }

    const attemptedAssets = new Set((this.db.raw.prepare(`
      SELECT replacement_asset_id FROM repair_attempts
      WHERE project_id = ? AND scene_id = ? AND replacement_asset_id IS NOT NULL
    `).all(projectId, sceneId) as Array<{ replacement_asset_id: string }>).map(row => row.replacement_asset_id));
    const candidates = this.db.raw.prepare(`
      SELECT c.*, a.canonical_page_url, a.local_file_id, a.availability_status, a.excluded
      FROM shot_candidates c
      JOIN assets a ON a.id = c.asset_id
      WHERE c.project_id = ? AND c.scene_id = ? AND c.asset_id <> ?
        AND c.status IN ('eligible','alternate')
        AND a.excluded = 0 AND a.availability_status <> 'unavailable'
        AND (a.canonical_page_url IS NOT NULL OR a.local_file_id IS NOT NULL)
      ORDER BY c.candidate_rank, c.candidate_score DESC, c.asset_id
    `).all(projectId, sceneId, scene.selected_asset_id ?? '') as Array<Record<string, unknown>>;
    let candidate: Record<string, unknown> | undefined;
    let readiness: CandidateReadiness | null = null;
    for (const row of candidates) {
      if (attemptedAssets.has(String(row.asset_id))) continue;
      const candidateReadiness = this.candidateReadiness(projectId, sceneId, String(row.asset_id));
      const geographySafe = candidateReadiness && this.candidateGeographySatisfies(scene, candidateReadiness.candidate);
      if (!geographySafe) {
        this.db.raw.prepare(`
          UPDATE shot_candidates SET status = 'rejected', updated_at = ?
          WHERE scene_id = ? AND asset_id = ?
        `).run(new Date().toISOString(), sceneId, row.asset_id);
        continue;
      }
      if (candidateReadiness?.permanentlyFailed) {
        this.db.raw.prepare(`
          UPDATE shot_candidates SET status = 'rejected', updated_at = ?
          WHERE scene_id = ? AND asset_id = ?
        `).run(new Date().toISOString(), sceneId, row.asset_id);
        continue;
      }
      candidate = row;
      readiness = candidateReadiness;
      break;
    }
    if (!candidate) {
      const id = this.insertAttempt({
        projectId,
        sceneId,
        failureCode,
        policy: { ...policy, repairClass: 'operator', maximumAttempts: 0, targetState: null },
        status: 'operator_required',
        attemptNumber: Math.max(0, attemptNumber - 1),
        sourceAssetId: scene.selected_asset_id ? String(scene.selected_asset_id) : null,
        evidence: { ...evidence, reason: 'no_unused_exact_location_candidate' }
      });
      this.blockSceneClosed(projectId, scene, failureCode, id, evidence);
      return { status: 'operator_required', attemptId: id, replacementAssetId: null };
    }

    const replacementAssetId = String(candidate.asset_id);
    const status: RepairAttemptStatus = readiness?.ready ? 'verified' : 'waiting_acquisition';
    const attemptId = this.insertAttempt({
      projectId,
      sceneId,
      failureCode,
      policy,
      status,
      attemptNumber,
      sourceAssetId: scene.selected_asset_id ? String(scene.selected_asset_id) : null,
      replacementAssetId,
      replacementFileId: readiness?.fileId ?? null,
      replacementSegmentId: readiness?.segmentId ?? null,
      evidence: {
        ...evidence,
        candidateRank: Number(candidate.candidate_rank),
        candidateScore: Number(candidate.candidate_score),
        candidateEvidence: parseArray(candidate.explanation_json)
      }
    });

    if (readiness?.ready) {
      const attempt = this.db.raw.prepare('SELECT * FROM repair_attempts WHERE id = ?').get(attemptId) as Record<string, unknown>;
      this.promoteCandidate(scene, readiness, attempt);
      return { status: 'verified', attemptId, replacementAssetId };
    }

    this.ensureAlternateAcquisition(projectId, scene, candidate);
    this.audit(projectId, 'repair.alternate_queued', 'scene', sceneId, {
      attemptId,
      failureCode,
      replacementAssetId,
      candidateRank: Number(candidate.candidate_rank)
    });
    return { status: 'waiting_acquisition', attemptId, replacementAssetId };
  }

  reconcileFootageRepairs(projectId: string): SceneRepairRoute[] {
    const waiting = this.db.raw.prepare(`
      SELECT DISTINCT scene_id, failure_code FROM repair_attempts
      WHERE project_id = ? AND status = 'waiting_acquisition' AND scene_id IS NOT NULL
      ORDER BY scene_id, failure_code
    `).all(projectId) as Array<{ scene_id: string; failure_code: string }>;
    return waiting.map(row => this.routeFootageFailure(projectId, row.scene_id, row.failure_code, {
      trigger: 'acquisition_reconciliation'
    }));
  }

  private recordQcAttempt(
    projectId: string,
    renderId: string,
    failure: QcFailure,
    policy: RepairPolicy,
    status: RepairAttemptStatus,
    attemptNumber: number
  ): string {
    const existing = this.db.raw.prepare(`
      SELECT id FROM repair_attempts WHERE qc_result_id = ? AND status = ? LIMIT 1
    `).get(failure.id, status) as { id: string } | undefined;
    if (existing) return existing.id;
    const render = this.db.raw.prepare(`
      SELECT artifact_version FROM renders WHERE id = ?
    `).get(renderId) as { artifact_version: number } | undefined;
    const evidence = parseObject(failure.evidenceJson);
    const ordinals = Array.isArray(evidence.ordinals)
      ? evidence.ordinals.map(Number).filter(Number.isFinite)
      : [];
    const requestedStart = Number(evidence.startSceneOrdinal ?? evidence.sceneOrdinal ?? ordinals[0]);
    const requestedEnd = Number(evidence.endSceneOrdinal ?? evidence.sceneOrdinal ?? ordinals.at(-1));
    const id = this.insertAttempt({
      projectId,
      renderId,
      qcResultId: failure.id,
      failureCode: failure.code,
      policy,
      status,
      attemptNumber,
      sourceArtifactVersion: Number(render?.artifact_version ?? 1),
      rangeStartOrdinal: Number.isFinite(requestedStart) ? requestedStart : null,
      rangeEndOrdinal: Number.isFinite(requestedEnd) ? requestedEnd : null,
      evidence: {
        message: failure.message,
        severity: failure.severity,
        qcEvidence: evidence
      }
    });
    this.audit(projectId, `repair.${status}`, 'qc_result', failure.id, {
      attemptId: id,
      failureCode: failure.code,
      repairClass: policy.repairClass,
      attemptNumber,
      maximumAttempts: policy.maximumAttempts,
      targetState: policy.targetState
    });
    return id;
  }

  private insertAttempt(input: {
    projectId: string;
    sceneId?: string | null;
    renderId?: string | null;
    qcResultId?: string | null;
    failureCode: string;
    policy: RepairPolicy;
    status: RepairAttemptStatus;
    attemptNumber: number;
    sourceAssetId?: string | null;
    replacementAssetId?: string | null;
    replacementFileId?: string | null;
    replacementSegmentId?: string | null;
    sourceArtifactVersion?: number | null;
    rangeStartOrdinal?: number | null;
    rangeEndOrdinal?: number | null;
    evidence: Record<string, unknown>;
  }): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.raw.prepare(`
      INSERT INTO repair_attempts(
        id, project_id, scene_id, render_id, qc_result_id, failure_code,
        repair_class, action, status, attempt_number, maximum_attempts,
        source_asset_id, replacement_asset_id, replacement_file_id,
        replacement_segment_id, source_artifact_version, range_start_ordinal,
        range_end_ordinal, target_state, evidence_json, created_at, completed_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.projectId,
      input.sceneId ?? null,
      input.renderId ?? null,
      input.qcResultId ?? null,
      input.failureCode,
      input.policy.repairClass,
      input.policy.action,
      input.status,
      input.attemptNumber,
      input.policy.maximumAttempts,
      input.sourceAssetId ?? null,
      input.replacementAssetId ?? null,
      input.replacementFileId ?? null,
      input.replacementSegmentId ?? null,
      input.sourceArtifactVersion ?? null,
      input.rangeStartOrdinal ?? null,
      input.rangeEndOrdinal ?? null,
      input.policy.targetState,
      JSON.stringify(input.evidence),
      now,
      ['verified', 'exhausted', 'operator_required', 'failed'].includes(input.status) ? now : null
    );
    return id;
  }

  private attemptCount(projectId: string, sceneId: string | null, failureCode: string): number {
    const row = this.db.raw.prepare(`
      SELECT coalesce(max(attempt_number), 0) AS attempts FROM repair_attempts
      WHERE project_id = ? AND failure_code = ?
        AND ((? IS NULL AND scene_id IS NULL) OR scene_id = ?)
    `).get(projectId, failureCode, sceneId, sceneId) as { attempts: number };
    return Number(row.attempts ?? 0);
  }

  private candidateReadiness(
    projectId: string,
    sceneId: string,
    assetId: string
  ): CandidateReadiness | null {
    const candidate = this.db.raw.prepare(`
      SELECT c.*, a.local_file_id, a.availability_status, a.excluded,
        a.country, a.city, a.location_name, a.location_granularity,
        q.state AS acquisition_state, q.mapped_file_id, l.license_state,
        (SELECT v.status FROM footage_verifications v
          WHERE v.scene_id = c.scene_id AND v.asset_file_id = coalesce(q.mapped_file_id, a.local_file_id)
          ORDER BY v.created_at DESC, v.id DESC LIMIT 1) AS semantic_status
      FROM shot_candidates c
      JOIN assets a ON a.id = c.asset_id
      LEFT JOIN acquisition_items q ON q.project_id = c.project_id AND q.asset_id = c.asset_id
      LEFT JOIN project_licenses l ON l.project_id = c.project_id AND l.asset_id = c.asset_id
      WHERE c.project_id = ? AND c.scene_id = ? AND c.asset_id = ?
    `).get(projectId, sceneId, assetId) as Record<string, unknown> | undefined;
    if (!candidate) return null;
    const fileId = candidate.mapped_file_id
      ? String(candidate.mapped_file_id)
      : candidate.local_file_id ? String(candidate.local_file_id) : null;
    const segment = fileId ? this.db.raw.prepare(`
      SELECT g.id, f.original_path FROM media_segments g
      JOIN asset_files f ON f.id = g.asset_file_id
      WHERE g.asset_file_id = ? AND g.eligible_1080p = 1
        AND g.black_frame_risk < 0.35 AND g.freeze_risk < 0.5
      ORDER BY g.quality_score DESC, g.start_ms, g.id LIMIT 1
    `).get(fileId) as { id: string; original_path: string } | undefined : undefined;
    const acquisitionState = candidate.acquisition_state ? String(candidate.acquisition_state) : null;
    const licenseState = candidate.license_state ? String(candidate.license_state) : null;
    const originalExists = Boolean(segment?.original_path && existsSync(segment.original_path));
    const semanticStatus = candidate.semantic_status ? String(candidate.semantic_status) : null;
    const ready = Boolean(
      fileId
      && segment
      && originalExists
      && licenseState
      && ACCEPTED_LICENSE_STATES.has(licenseState)
      && semanticStatus === 'verified'
    );
    const permanentlyFailed = Boolean(
      candidate.excluded
      || candidate.availability_status === 'unavailable'
      || acquisitionState === 'FAILED'
      || licenseState === 'CONFLICT'
      || semanticStatus === 'rejected'
      || semanticStatus === 'conflict'
      || semanticStatus === 'uncertain'
      || (acquisitionState === 'COMPLETE' && fileId && (!segment || !originalExists))
    );
    return {
      candidate,
      fileId,
      segmentId: segment?.id ?? null,
      acquisitionState,
      licenseState,
      semanticStatus,
      ready,
      permanentlyFailed
    };
  }

  private promoteCandidate(
    scene: Record<string, unknown>,
    readiness: CandidateReadiness,
    attempt: Record<string, unknown>
  ): void {
    if (
      !readiness.fileId
      || !readiness.segmentId
      || readiness.semanticStatus !== 'verified'
      || !this.candidateGeographySatisfies(scene, readiness.candidate)
    ) throw new Error('Unsafe alternate promotion was blocked.');
    const projectId = String(readiness.candidate.project_id);
    const sceneId = String(scene.id);
    const replacementAssetId = String(readiness.candidate.asset_id);
    const now = new Date().toISOString();
    this.db.raw.transaction(() => {
      this.db.raw.prepare(`
        UPDATE shot_candidates SET status = CASE
          WHEN asset_id = ? THEN 'selected'
          WHEN status = 'selected' THEN 'rejected'
          ELSE status END, updated_at = ?
        WHERE scene_id = ?
      `).run(replacementAssetId, now, sceneId);
      this.db.raw.prepare(`
        UPDATE project_scenes SET selected_asset_id = ?, selected_file_id = ?,
          selected_segment_id = ?, score = ?, score_explanation_json = ?,
          verification_state = 'verified', updated_at = ?
        WHERE id = ?
      `).run(
        replacementAssetId,
        readiness.fileId,
        readiness.segmentId,
        Number(readiness.candidate.candidate_score),
        JSON.stringify([
          ...parseArray(readiness.candidate.explanation_json),
          `Automatically selected after ${String(attempt.failure_code)} failed`,
          `Repair attempt ${Number(attempt.attempt_number)} of ${Number(attempt.maximum_attempts)}`
        ]),
        now,
        sceneId
      );
      this.db.raw.prepare(`
        UPDATE repair_attempts SET status = 'verified', replacement_file_id = ?,
          replacement_segment_id = ?, completed_at = ?, evidence_json = ?
        WHERE id = ?
      `).run(
        readiness.fileId,
        readiness.segmentId,
        now,
        JSON.stringify({
          ...parseObject(attempt.evidence_json),
          verifiedLicenseState: readiness.licenseState,
          semanticVerificationStatus: readiness.semanticStatus,
          promotedAt: now
        }),
        attempt.id
      );
      this.db.raw.prepare(`
        UPDATE exceptions SET status = 'RESOLVED', resolved_at = ?, resolution_json = ?
        WHERE project_id = ? AND status = 'OPEN' AND stage = 'media'
          AND code IN ('SEMANTIC_PROVIDER_REQUIRED', 'NO_SAFE_FOOTAGE_ALTERNATE')
          AND json_extract(evidence_json, '$.sceneId') = ?
      `).run(now, JSON.stringify({ method: 'verified_alternate', attemptId: attempt.id }), projectId, sceneId);
    })();
    this.audit(projectId, 'repair.alternate_selected', 'scene', sceneId, {
      attemptId: String(attempt.id),
      sourceAssetId: scene.selected_asset_id ?? null,
      replacementAssetId,
      replacementFileId: readiness.fileId,
      replacementSegmentId: readiness.segmentId,
      licenseState: readiness.licenseState,
      semanticVerificationStatus: readiness.semanticStatus
    });
  }

  private ensureAlternateAcquisition(
    projectId: string,
    scene: Record<string, unknown>,
    candidate: Record<string, unknown>
  ): void {
    const assetId = String(candidate.asset_id);
    const existing = this.db.raw.prepare(`
      SELECT id, required_scene_ordinals_json FROM acquisition_items
      WHERE project_id = ? AND asset_id = ?
    `).get(projectId, assetId) as Record<string, unknown> | undefined;
    const ordinal = Number(scene.ordinal);
    const now = new Date().toISOString();
    if (existing) {
      const scenes = new Set(parseArray(existing.required_scene_ordinals_json).map(Number));
      scenes.add(ordinal);
      this.db.raw.prepare(`
        UPDATE acquisition_items SET required_scene_ordinals_json = ?,
          role = CASE
            WHEN role IN ('primary','hero','license_only') THEN role
            ELSE 'alternate' END,
          state = CASE WHEN state IN ('FAILED','SKIPPED') THEN 'READY_TO_OPEN' ELSE state END,
          updated_at = ? WHERE id = ?
      `).run(JSON.stringify([...scenes].sort((a, b) => a - b)), now, existing.id);
      return;
    }
    const local = Boolean(candidate.local_file_id);
    const sourceUrl = candidate.canonical_page_url
      ? String(candidate.canonical_page_url)
      : local ? `urn:videofactory:catalog:${assetId}` : null;
    if (!sourceUrl) return;
    const project = this.db.raw.prepare(`
      SELECT envato_project_name FROM projects WHERE id = ?
    `).get(projectId) as { envato_project_name: string };
    const next = this.db.raw.prepare(`
      SELECT coalesce(max(ordinal), 0) + 1 AS ordinal FROM acquisition_items WHERE project_id = ?
    `).get(projectId) as { ordinal: number };
    this.db.raw.transaction(() => {
      this.db.raw.prepare(`
        INSERT INTO acquisition_items(
          id, project_id, asset_id, ordinal, role, state, license_state,
          source_url, required_scene_ordinals_json, match_score, reasons_json,
          created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(), projectId, assetId, Number(next.ordinal), local ? 'license_only' : 'alternate',
        local ? 'LICENSE_ONLY_PENDING' : 'READY_TO_OPEN', sourceUrl, JSON.stringify([ordinal]),
        Number(candidate.candidate_score),
        JSON.stringify([
          ...parseArray(candidate.explanation_json),
          `Queued automatically as repair alternate for scene ${ordinal}`
        ]),
        now, now
      );
      this.db.raw.prepare(`
        INSERT OR IGNORE INTO project_licenses(
          id, project_id, asset_id, license_state, envato_project_name, created_at, updated_at
        ) VALUES(?, ?, ?, 'PENDING', ?, ?, ?)
      `).run(randomUUID(), projectId, assetId, project.envato_project_name, now, now);
    })();
  }

  private candidateGeographySatisfies(
    scene: Record<string, unknown>,
    candidate: Record<string, unknown>
  ): boolean {
    return geographySatisfies({
      country: candidate.country ? String(candidate.country) : null,
      city: candidate.city ? String(candidate.city) : null,
      location: candidate.location_name ? String(candidate.location_name) : null,
      granularity: (candidate.location_granularity ?? 'unknown') as Granularity
    }, {
      country: scene.required_country ? String(scene.required_country) : null,
      city: scene.required_city ? String(scene.required_city) : null,
      location: scene.required_location ? String(scene.required_location) : null,
      granularity: (scene.required_granularity ?? 'unknown') as Granularity
    });
  }

  private blockSceneClosed(
    projectId: string,
    scene: Record<string, unknown>,
    failureCode: string,
    attemptId: string,
    evidence: Record<string, unknown>
  ): void {
    const sceneId = String(scene.id);
    const now = new Date().toISOString();
    this.db.raw.prepare(`
      UPDATE project_scenes SET verification_state = 'rejected', updated_at = ?
      WHERE id = ?
    `).run(now, sceneId);
    const existing = this.db.raw.prepare(`
      SELECT id FROM exceptions
      WHERE project_id = ? AND status = 'OPEN' AND stage = 'media'
        AND code = 'NO_SAFE_FOOTAGE_ALTERNATE'
        AND json_extract(evidence_json, '$.sceneId') = ?
      LIMIT 1
    `).get(projectId, sceneId);
    if (existing) return;
    this.db.raw.prepare(`
      INSERT INTO exceptions(
        id, project_id, severity, stage, code, title, message, evidence_json,
        recommended_action, safe_alternatives_json, status, created_at
      ) VALUES(?, ?, 'BLOCKER', 'media', 'NO_SAFE_FOOTAGE_ALTERNATE',
        'No safe footage alternate remains',
        'The source failed technical verification and bounded alternate selection could not produce verified replacement footage.',
        ?, 'Acquire a new exact-location candidate, use a truthful inset/graphic treatment, or rewrite the affected beat.',
        ?, 'OPEN', ?)
    `).run(
      randomUUID(),
      projectId,
      JSON.stringify({
        ...evidence,
        sceneId,
        sceneOrdinal: Number(scene.ordinal),
        failureCode,
        repairAttemptId: attemptId
      }),
      JSON.stringify([
        'Acquire exact-location alternate',
        'Use non-upscaled graphic treatment',
        'Rewrite affected narration beat'
      ]),
      now
    );
  }

  private failWaitingAttempt(
    attempt: Record<string, unknown>,
    readiness: CandidateReadiness | null
  ): void {
    const now = new Date().toISOString();
    this.db.raw.prepare(`
      UPDATE repair_attempts SET status = 'failed', completed_at = ?, evidence_json = ?
      WHERE id = ?
    `).run(
      now,
      JSON.stringify({
        ...parseObject(attempt.evidence_json),
        failure: 'alternate_failed_verification',
        acquisitionState: readiness?.acquisitionState ?? null,
        licenseState: readiness?.licenseState ?? null
      }),
      attempt.id
    );
    if (attempt.scene_id && attempt.replacement_asset_id) {
      this.db.raw.prepare(`
        UPDATE shot_candidates SET status = 'rejected', updated_at = ?
        WHERE scene_id = ? AND asset_id = ?
      `).run(now, attempt.scene_id, attempt.replacement_asset_id);
    }
  }

  private audit(
    projectId: string,
    action: string,
    entityType: string,
    entityId: string,
    metadata: Record<string, unknown>
  ): void {
    this.db.raw.prepare(`
      INSERT INTO audit_log(
        project_id, action, actor, entity_type, entity_id,
        before_json, after_json, metadata_json, created_at
      ) VALUES(?, ?, 'system', ?, ?, '{}', '{}', ?, ?)
    `).run(projectId, action, entityType, entityId, JSON.stringify(metadata), new Date().toISOString());
  }
}
