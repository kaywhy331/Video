import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { AppDatabase } from '../database/database';
import type { AppSettings } from '@shared/types';
import {
  decideFootageVerification,
  type FootageVerificationDecision,
  type VisionFootageAssessment
} from '@shared/footage-verification';
import { geographySatisfies, type Granularity } from '@shared/geography';
import type { PlaceService } from './place-service';
import type { VisionAssessmentResult, VisionService } from './vision-service';

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

export interface PersistedFootageDecision extends FootageVerificationDecision {
  id: string;
  inputHash: string;
  provider: string;
  model: string;
  cached: boolean;
}

type VisionAdapter = Pick<VisionService, 'configured' | 'assess'>;

export class FootageVerificationService {
  constructor(
    private readonly db: AppDatabase,
    private readonly settings: () => AppSettings,
    private readonly places: PlaceService,
    private readonly vision: VisionAdapter
  ) {}

  async verifyScene(
    projectId: string,
    sceneId: string,
    assetId: string,
    assetFileId: string
  ): Promise<PersistedFootageDecision> {
    const row = this.db.raw.prepare(`
      SELECT s.*, a.country AS asset_country, a.city AS asset_city,
        a.location_name AS asset_location, a.location_granularity AS asset_granularity,
        a.verification_status AS asset_verification_status,
        f.sha256, f.contact_sheet_path
      FROM project_scenes s
      JOIN assets a ON a.id = ?
      JOIN asset_files f ON f.id = ? AND f.asset_id = a.id
      WHERE s.id = ? AND s.project_id = ?
    `).get(assetId, assetFileId, sceneId, projectId) as Record<string, unknown> | undefined;
    if (!row) throw new Error('Footage verification target was not found.');

    this.places.syncAsset(assetId);
    let requiredPlaceId = row.required_place_id ? String(row.required_place_id) : null;
    if (!requiredPlaceId) {
      requiredPlaceId = this.places.ensureHierarchy({
        country: row.required_country ? String(row.required_country) : null,
        city: row.required_city ? String(row.required_city) : null,
        location: row.required_location ? String(row.required_location) : null,
        granularity: (row.required_granularity ?? 'unknown') as Granularity
      })?.id ?? null;
      if (requiredPlaceId) {
        this.db.raw.prepare('UPDATE project_scenes SET required_place_id = ? WHERE id = ?')
          .run(requiredPlaceId, sceneId);
      }
    }

    const requiredObjects = jsonArray(row.required_objects_json);
    const requiredActivities = jsonArray(row.required_activities_json);
    const preferredShots = jsonArray(row.preferred_shots_json);
    const geographyRequired = Boolean(
      row.required_country || row.required_city || row.required_location || requiredPlaceId
    );
    const metadataGeographyCompatible = geographySatisfies({
      country: row.asset_country ? String(row.asset_country) : null,
      city: row.asset_city ? String(row.asset_city) : null,
      location: row.asset_location ? String(row.asset_location) : null,
      granularity: (row.asset_granularity ?? 'unknown') as Granularity
    }, {
      country: row.required_country ? String(row.required_country) : null,
      city: row.required_city ? String(row.required_city) : null,
      location: row.required_location ? String(row.required_location) : null,
      granularity: (row.required_granularity ?? 'unknown') as Granularity
    });
    const canonicalGeographyCompatible = this.places.assetSatisfiesPlace(assetId, requiredPlaceId);
    const humanGeographyVerified = this.places.humanVerifiedForAsset(assetId)
      || row.asset_verification_status === 'human_verified';
    const providerConfigured = this.vision.configured();
    const policyInput = {
      metadataGeographyCompatible,
      canonicalGeographyCompatible,
      geographyRequired,
      humanGeographyVerified,
      providerConfigured,
      minimumConfidence: this.settings().visionMinimumConfidence,
      requiredObjects,
      requiredActivities
    };

    let result: VisionAssessmentResult | null = null;
    let assessment: VisionFootageAssessment | null = null;
    let decision = decideFootageVerification(policyInput);
    const contactSheetPath = row.contact_sheet_path ? String(row.contact_sheet_path) : '';
    let provider = providerConfigured ? this.settings().visionProvider : 'local_policy';
    let model = providerConfigured ? this.settings().visionModel : 'none';
    let cached = false;
    let providerError: string | null = null;
    const localInput = {
      sceneId,
      assetId,
      assetFileId,
      assetSha256: String(row.sha256),
      narration: String(row.narration),
      requiredCountry: row.required_country ? String(row.required_country) : null,
      requiredCity: row.required_city ? String(row.required_city) : null,
      requiredLocation: row.required_location ? String(row.required_location) : null,
      requiredGranularity: String(row.required_granularity ?? 'unknown'),
      requiredObjects,
      requiredActivities,
      preferredShots,
      visualTreatment: String(row.visual_treatment)
    };
    let inputHash = createHash('sha256').update(JSON.stringify({ policy: localInput })).digest('hex');

    if (decision.status === 'provider_required' && providerConfigured && contactSheetPath && existsSync(contactSheetPath)) {
      try {
        result = await this.vision.assess({
          projectId,
          ...localInput,
          contactSheetPath
        });
        assessment = result.assessment;
        provider = result.provider;
        model = result.model;
        inputHash = result.inputHash;
        cached = result.cached;
        decision = decideFootageVerification({ ...policyInput, assessment });
      } catch (error) {
        providerError = error instanceof Error ? error.message : String(error);
        decision = {
          status: 'error',
          geographyStatus: geographyRequired ? 'unknown' : 'not_required',
          semanticStatus: requiredObjects.length || requiredActivities.length ? 'unknown' : 'not_required',
          confidence: 0,
          reasons: [`Semantic verification failed closed: ${providerError}`]
        };
      }
    } else if (decision.status === 'provider_required' && providerConfigured && (!contactSheetPath || !existsSync(contactSheetPath))) {
      decision = {
        status: 'error',
        geographyStatus: geographyRequired ? 'unknown' : 'not_required',
        semanticStatus: requiredObjects.length || requiredActivities.length ? 'unknown' : 'not_required',
        confidence: 0,
        reasons: ['Semantic verification requires a generated contact sheet, but none is available.']
      };
    }

    const observedPlace = assessment
      ? this.places.findExisting({
          country: assessment.geography.country,
          city: assessment.geography.city,
          location: assessment.geography.location,
          granularity: assessment.geography.granularity
        })
      : null;
    if (
      assessment
      && assessment.geography.confidence >= this.settings().visionMinimumConfidence
      && (observedPlace || (assessment.geography.verdict === 'match' && requiredPlaceId))
    ) {
      this.places.recordVisionAssertion({
        assetId,
        placeId: observedPlace?.id ?? requiredPlaceId!,
        confidence: assessment.geography.confidence,
        evidenceRef: inputHash,
        evidence: {
          verdict: assessment.geography.verdict,
          evidence: assessment.geography.evidence,
          sceneId,
          assetFileId
        }
      });
    }

    if (decision.status === 'conflict' && row.asset_verification_status !== 'human_verified') {
      this.db.raw.prepare(`
        UPDATE assets SET verification_status = 'conflict', updated_at = ? WHERE id = ?
      `).run(new Date().toISOString(), assetId);
    } else if (decision.status === 'verified' && row.asset_verification_status !== 'human_verified' && assessment) {
      this.db.raw.prepare(`
        UPDATE assets SET verification_status = 'ai_suggested',
          location_confidence = max(location_confidence, ?), updated_at = ? WHERE id = ?
      `).run(assessment.geography.confidence, new Date().toISOString(), assetId);
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.raw.prepare(`
      INSERT INTO footage_verifications(
        id, project_id, scene_id, asset_id, asset_file_id, provider, model,
        input_hash, status, geography_status, semantic_status, confidence,
        required_place_id, observed_place_id, assessment_json, evidence_json, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scene_id, asset_file_id, input_hash) DO UPDATE SET
        provider = excluded.provider,
        model = excluded.model,
        status = excluded.status,
        geography_status = excluded.geography_status,
        semantic_status = excluded.semantic_status,
        confidence = excluded.confidence,
        required_place_id = excluded.required_place_id,
        observed_place_id = excluded.observed_place_id,
        assessment_json = excluded.assessment_json,
        evidence_json = excluded.evidence_json,
        created_at = excluded.created_at
    `).run(
      id, projectId, sceneId, assetId, assetFileId, provider, model, inputHash,
      decision.status, decision.geographyStatus, decision.semanticStatus, decision.confidence,
      requiredPlaceId, observedPlace?.id ?? null, JSON.stringify(assessment ?? {}), JSON.stringify({
        reasons: decision.reasons,
        metadataGeographyCompatible,
        canonicalGeographyCompatible,
        humanGeographyVerified,
        providerConfigured,
        cached,
        providerError
      }), now
    );
    const receipt = this.db.raw.prepare(`
      SELECT id FROM footage_verifications
      WHERE scene_id = ? AND asset_file_id = ? AND input_hash = ?
    `).get(sceneId, assetFileId, inputHash) as { id: string };
    this.updateFileReceipt(assetFileId, sceneId, {
      verificationId: receipt.id,
      status: decision.status,
      geographyStatus: decision.geographyStatus,
      semanticStatus: decision.semanticStatus,
      confidence: decision.confidence,
      inputHash,
      provider,
      model,
      verifiedAt: now
    });
    return { ...decision, id: receipt.id, inputHash, provider, model, cached };
  }

  latestStatus(sceneId: string, assetFileId: string): string | null {
    const row = this.db.raw.prepare(`
      SELECT status FROM footage_verifications
      WHERE scene_id = ? AND asset_file_id = ?
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(sceneId, assetFileId) as { status: string } | undefined;
    return row?.status ?? null;
  }

  private updateFileReceipt(assetFileId: string, sceneId: string, receipt: Record<string, unknown>): void {
    const row = this.db.raw.prepare(`
      SELECT visual_verification_json FROM asset_files WHERE id = ?
    `).get(assetFileId) as { visual_verification_json: string | null };
    const current = jsonObject(row.visual_verification_json);
    const scenes = current.scenes && typeof current.scenes === 'object' && !Array.isArray(current.scenes)
      ? current.scenes as Record<string, unknown>
      : {};
    scenes[sceneId] = receipt;
    this.db.raw.prepare(`
      UPDATE asset_files SET visual_verification_json = ? WHERE id = ?
    `).run(JSON.stringify({ ...current, scenes }), assetFileId);
  }
}
