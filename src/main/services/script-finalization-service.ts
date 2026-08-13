import { createHash, randomUUID } from 'node:crypto';
import type { AppDatabase } from '../database/database';
import type { AppSettings, ProjectScene } from '@shared/types';
import type { AiService, FinalizeScriptInput } from './ai-service';
import type { ProjectService } from './project-service';

interface SceneRow {
  id: string;
  ordinal: number;
  chapter: string | null;
  narration: string;
  target_duration_ms: number;
  visual_treatment: string;
  required_country: string | null;
  required_city: string | null;
  required_location: string | null;
  selected_asset_id: string | null;
  selected_file_id: string | null;
  selected_segment_id: string | null;
  duration_ms: number | null;
  verification_state: ProjectScene['verificationState'];
  claim_ids_json: string;
}

function graphicTreatment(value: string): boolean {
  return value === 'MAP_OR_GRAPHIC' || value === 'TEXT_OR_ARCHIVAL';
}

function ids(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export class ScriptFinalizationService {
  constructor(
    private readonly db: AppDatabase,
    private readonly settings: () => AppSettings,
    private readonly ai: AiService,
    private readonly projects: ProjectService
  ) {}

  async finalize(projectId: string): Promise<string> {
    const project = this.db.raw.prepare(`
      SELECT id, title, topic, destination, state, script_version_id
      FROM projects WHERE id = ?
    `).get(projectId) as {
      id: string;
      title: string;
      topic: string;
      destination: string | null;
      state: import('@shared/types').ProjectState;
      script_version_id: string | null;
    } | undefined;
    if (!project) throw new Error('Project not found for final-script generation.');
    if (project.state !== 'FINALIZING_SCRIPT') {
      throw new Error(`Final script can only be generated from FINALIZING_SCRIPT, not ${project.state}.`);
    }
    if (!project.script_version_id) throw new Error('Project has no provisional script version.');

    const source = this.db.raw.prepare(`SELECT * FROM script_versions WHERE id = ?`).get(project.script_version_id) as Record<string, unknown> | undefined;
    if (!source) throw new Error('The active provisional script version is missing.');
    const rows = this.db.raw.prepare(`
      SELECT s.*, g.duration_ms,
        coalesce((
          SELECT json_group_array(c.claim_id)
          FROM project_scene_claims c WHERE c.scene_id = s.id
        ), '[]') AS claim_ids_json
      FROM project_scenes s
      LEFT JOIN media_segments g ON g.id = s.selected_segment_id
      WHERE s.project_id = ? ORDER BY s.ordinal
    `).all(projectId) as unknown as SceneRow[];
    if (!rows.length) throw new Error('Project has no scenes to finalize.');
    const invalid = rows.filter(row => graphicTreatment(row.visual_treatment)
      ? row.verification_state !== 'graphic'
      : row.verification_state !== 'verified'
        || !row.selected_asset_id
        || !row.selected_file_id
        || !row.selected_segment_id
        || !row.duration_ms);
    if (invalid.length) {
      throw new Error(`${invalid.length} scene(s) do not have a verified visual treatment matching the final storyboard.`);
    }

    const claimIds = new Set(rows.flatMap(row => ids(row.claim_ids_json)));
    const acceptedClaims = claimIds.size
      ? (this.db.raw.prepare(`
          SELECT id, text FROM fact_claims
          WHERE project_id = ? AND status = 'accepted' AND category <> 'visual_observation'
        `).all(projectId) as Array<{ id: string; text: string }>).filter(claim => claimIds.has(claim.id))
      : [];
    const acceptedClaimIds = new Set(acceptedClaims.map(claim => claim.id));
    const input: FinalizeScriptInput = {
      projectId,
      title: project.title,
      topic: project.topic,
      destination: project.destination,
      scenes: rows.map(row => ({
        id: row.id,
        ordinal: row.ordinal,
        chapter: row.chapter,
        narration: row.narration,
        targetDurationMs: row.target_duration_ms,
        visualTreatment: row.visual_treatment,
        requiredCountry: row.required_country,
        requiredCity: row.required_city,
        requiredLocation: row.required_location,
        selectedAssetId: row.selected_asset_id,
        selectedFileId: row.selected_file_id,
        selectedSegmentId: row.selected_segment_id,
        sourceDurationMs: row.duration_ms,
        verificationState: row.verification_state,
        claimIds: ids(row.claim_ids_json).filter(claimId => acceptedClaimIds.has(claimId))
      })),
      acceptedClaims,
      pronunciationDictionary: this.settings().pronunciationDictionary
    };
    const rewrite = await this.ai.finalizeScript(input);
    const rewrittenById = new Map(rewrite.scenes.map(scene => [scene.sceneId, scene]));
    const scriptJson = JSON.parse(String(source.script_json)) as Record<string, unknown>;
    const versionNumber = Number((this.db.raw.prepare(`
      SELECT coalesce(max(version_number), 0) + 1 AS next
      FROM script_versions WHERE project_id = ?
    `).get(projectId) as { next: number }).next);
    const inputHash = createHash('sha256').update(JSON.stringify({
      parentId: source.id,
      scenes: input.scenes,
      rewrite,
      provider: this.settings().llmProvider,
      model: this.settings().llmModel
    })).digest('hex');
    const now = new Date().toISOString();
    const finalScriptId = randomUUID();
    const finalScript = {
      ...scriptJson,
      scenes: rows.map(row => ({
        ...(Array.isArray(scriptJson.scenes)
          ? (scriptJson.scenes[row.ordinal - 1] as Record<string, unknown> | undefined) ?? {}
          : {}),
        narration: rewrittenById.get(row.id)!.narration,
        pronunciation: rewrittenById.get(row.id)!.pronunciation,
        sceneId: row.id
      }))
    };

    this.db.raw.transaction(() => {
      this.db.raw.prepare(`
        INSERT INTO script_versions(
          id, project_id, parent_id, version_number, title, topic, summary,
          script_json, generation_reason, provider, model, input_hash, locked,
          script_type, locked_at, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'verified_footage_finalization', ?, ?, ?, 1,
          'final', ?, ?)
      `).run(
        finalScriptId,
        projectId,
        source.id,
        versionNumber,
        source.title,
        source.topic,
        source.summary,
        JSON.stringify(finalScript),
        this.settings().llmProvider,
        this.settings().llmModel,
        inputHash,
        now,
        now
      );
      const updateScene = this.db.raw.prepare(`
        UPDATE project_scenes SET script_version_id = ?, narration = ?,
          pronunciation_json = ?, updated_at = ? WHERE id = ?
      `);
      for (const scene of rewrite.scenes) {
        updateScene.run(finalScriptId, scene.narration, JSON.stringify(scene.pronunciation), now, scene.sceneId);
      }
      this.db.raw.prepare(`
        UPDATE narration_sections SET status = 'stale', updated_at = ?
        WHERE project_id = ? AND status = 'ready'
      `).run(now, projectId);
      this.db.raw.prepare(`
        UPDATE projects SET script_version_id = ?, updated_at = ? WHERE id = ?
      `).run(finalScriptId, now, projectId);
      this.db.raw.prepare(`
        INSERT INTO audit_log(
          project_id, action, actor, entity_type, entity_id, metadata_json, created_at
        ) VALUES(?, 'script.final_locked', 'system', 'script_version', ?, ?, ?)
      `).run(projectId, finalScriptId, JSON.stringify({
        parentId: source.id,
        versionNumber,
        sceneCount: rewrite.scenes.length,
        inputHash
      }), now);
    })();
    this.projects.states.transition(projectId, 'GENERATING_VOICE', {
      progress: 0.54,
      reason: 'Final script was rewritten against verified footage and locked',
      prerequisites: { finalScriptId, parentScriptId: source.id, sceneCount: rewrite.scenes.length }
    });
    return finalScriptId;
  }
}
