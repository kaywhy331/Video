import type { Granularity } from './geography';

export type VerificationVerdict = 'match' | 'mismatch' | 'unknown';

export interface VisionRequirementAssessment {
  requirement: string;
  present: boolean | null;
  confidence: number;
  evidence: string;
}

export interface VisionFootageAssessment {
  geography: {
    verdict: VerificationVerdict;
    confidence: number;
    country: string | null;
    city: string | null;
    location: string | null;
    granularity: Granularity;
    evidence: string[];
  };
  objects: VisionRequirementAssessment[];
  activities: VisionRequirementAssessment[];
  disallowedContent: string[];
  technicalConcerns: string[];
  summary: string;
}

export type FootageVerificationStatus =
  | 'verified'
  | 'rejected'
  | 'conflict'
  | 'provider_required'
  | 'uncertain'
  | 'error';

export interface FootageVerificationDecision {
  status: FootageVerificationStatus;
  geographyStatus: VerificationVerdict | 'not_required';
  semanticStatus: VerificationVerdict | 'not_required';
  confidence: number;
  reasons: string[];
}

function normalizedRequirement(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('en-US').replace(/\s+/g, ' ');
}

function requirementDecision(
  required: string[],
  observed: VisionRequirementAssessment[],
  minimumConfidence: number,
  label: string
): { status: VerificationVerdict | 'not_required'; confidence: number; reasons: string[] } {
  if (!required.length) return { status: 'not_required', confidence: 1, reasons: [] };
  const byRequirement = new Map(observed.map(item => [normalizedRequirement(item.requirement), item]));
  let confidence = 1;
  const reasons: string[] = [];
  let unknown = false;
  for (const requirement of required) {
    const assessment = byRequirement.get(normalizedRequirement(requirement));
    if (!assessment || assessment.present === null || assessment.confidence < minimumConfidence) {
      unknown = true;
      confidence = Math.min(confidence, assessment?.confidence ?? 0);
      reasons.push(`${label} could not be verified: ${requirement}`);
      continue;
    }
    confidence = Math.min(confidence, assessment.confidence);
    if (!assessment.present) {
      reasons.push(`${label} is missing: ${requirement}`);
      return { status: 'mismatch', confidence, reasons };
    }
  }
  return { status: unknown ? 'unknown' : 'match', confidence, reasons };
}

export function decideFootageVerification(input: {
  metadataGeographyCompatible: boolean;
  canonicalGeographyCompatible: boolean | null;
  geographyRequired: boolean;
  humanGeographyVerified: boolean;
  providerConfigured: boolean;
  minimumConfidence: number;
  requiredObjects: string[];
  requiredActivities: string[];
  assessment?: VisionFootageAssessment | null;
}): FootageVerificationDecision {
  if (!input.metadataGeographyCompatible || input.canonicalGeographyCompatible === false) {
    return {
      status: 'conflict',
      geographyStatus: 'mismatch',
      semanticStatus: 'unknown',
      confidence: 1,
      reasons: ['Canonical or catalog geography is incompatible with the current scene contract.']
    };
  }

  const semanticRequirements = input.requiredObjects.length + input.requiredActivities.length;
  if (!input.assessment) {
    if (input.humanGeographyVerified && semanticRequirements === 0) {
      return {
        status: 'verified',
        geographyStatus: input.geographyRequired ? 'match' : 'not_required',
        semanticStatus: 'not_required',
        confidence: 1,
        reasons: ['Human-verified geographic evidence satisfies this scene and no semantic requirements remain.']
      };
    }
    return {
      status: 'provider_required',
      geographyStatus: input.geographyRequired && !input.humanGeographyVerified ? 'unknown' : 'match',
      semanticStatus: semanticRequirements ? 'unknown' : 'not_required',
      confidence: 0,
      reasons: [input.providerConfigured
        ? 'Semantic provider evidence is required but no valid assessment is available.'
        : 'Configure a semantic vision provider or add human-verified evidence before this footage can be used.']
    };
  }

  const geography = input.geographyRequired
    ? input.assessment.geography.verdict
    : 'not_required';
  if (
    input.geographyRequired
    && input.assessment.geography.verdict === 'mismatch'
    && input.assessment.geography.confidence >= input.minimumConfidence
  ) {
    return {
      status: 'conflict',
      geographyStatus: 'mismatch',
      semanticStatus: 'unknown',
      confidence: input.assessment.geography.confidence,
      reasons: ['Visual evidence contradicts the required geography.', ...input.assessment.geography.evidence]
    };
  }

  const geographyVerified = !input.geographyRequired
    || input.humanGeographyVerified
    || (
      input.assessment.geography.verdict === 'match'
      && input.assessment.geography.confidence >= input.minimumConfidence
    );
  const objects = requirementDecision(
    input.requiredObjects,
    input.assessment.objects,
    input.minimumConfidence,
    'Required object'
  );
  const activities = requirementDecision(
    input.requiredActivities,
    input.assessment.activities,
    input.minimumConfidence,
    'Required activity'
  );
  const semanticStatus = objects.status === 'mismatch' || activities.status === 'mismatch'
    ? 'mismatch'
    : objects.status === 'unknown' || activities.status === 'unknown'
      ? 'unknown'
      : objects.status === 'not_required' && activities.status === 'not_required'
        ? 'not_required'
        : 'match';
  const confidence = Math.min(
    geographyVerified ? (input.geographyRequired && !input.humanGeographyVerified
      ? input.assessment.geography.confidence
      : 1) : input.assessment.geography.confidence,
    objects.confidence,
    activities.confidence
  );
  const reasons = [...objects.reasons, ...activities.reasons];

  if (input.assessment.disallowedContent.length) {
    return {
      status: 'rejected',
      geographyStatus: geography,
      semanticStatus: 'mismatch',
      confidence,
      reasons: [`Disallowed visual content was detected: ${input.assessment.disallowedContent.join(', ')}`]
    };
  }
  if (semanticStatus === 'mismatch') {
    return { status: 'rejected', geographyStatus: geography, semanticStatus, confidence, reasons };
  }
  if (!geographyVerified || semanticStatus === 'unknown') {
    return {
      status: 'uncertain',
      geographyStatus: geographyVerified ? 'match' : 'unknown',
      semanticStatus,
      confidence,
      reasons: [
        ...reasons,
        ...(!geographyVerified ? ['Visual geography did not meet the configured confidence threshold.'] : [])
      ]
    };
  }
  return {
    status: 'verified',
    geographyStatus: input.geographyRequired ? 'match' : 'not_required',
    semanticStatus,
    confidence,
    reasons: [
      input.humanGeographyVerified
        ? 'Human geographic evidence retained precedence.'
        : 'Visual geography meets the configured threshold.',
      ...(semanticStatus === 'match' ? ['All required objects and activities are visually supported.'] : [])
    ]
  };
}
