import { describe, expect, it } from 'vitest';
import { decideFootageVerification, type VisionFootageAssessment } from '@shared/footage-verification';

function assessment(overrides: Partial<VisionFootageAssessment> = {}): VisionFootageAssessment {
  return {
    geography: {
      verdict: 'match',
      confidence: 0.95,
      country: 'France',
      city: 'Paris',
      location: 'Eiffel Tower',
      granularity: 'landmark',
      evidence: ['Recognizable Eiffel Tower structure']
    },
    objects: [],
    activities: [],
    disallowedContent: [],
    technicalConcerns: [],
    summary: 'The frames support the requested scene.',
    ...overrides
  };
}

const base = {
  metadataGeographyCompatible: true,
  canonicalGeographyCompatible: true,
  geographyRequired: true,
  humanGeographyVerified: false,
  providerConfigured: true,
  minimumConfidence: 0.8,
  requiredObjects: [] as string[],
  requiredActivities: [] as string[]
};

describe('semantic footage verification policy', () => {
  it('never lets visual similarity override incompatible canonical geography', () => {
    expect(decideFootageVerification({
      ...base,
      canonicalGeographyCompatible: false,
      assessment: assessment()
    })).toMatchObject({ status: 'conflict', geographyStatus: 'mismatch' });
  });

  it('preserves human geographic evidence when no semantic requirement remains', () => {
    expect(decideFootageVerification({
      ...base,
      humanGeographyVerified: true,
      providerConfigured: false
    })).toMatchObject({ status: 'verified', confidence: 1 });
  });

  it('fails closed when semantic evidence is required but no provider result exists', () => {
    expect(decideFootageVerification({
      ...base,
      humanGeographyVerified: true,
      providerConfigured: false,
      requiredObjects: ['cathedral']
    })).toMatchObject({ status: 'provider_required', semanticStatus: 'unknown' });
  });

  it('accepts only high-confidence geography and required visual matches', () => {
    expect(decideFootageVerification({
      ...base,
      requiredObjects: ['tower'],
      requiredActivities: ['walking'],
      assessment: assessment({
        objects: [{ requirement: 'tower', present: true, confidence: 0.94, evidence: 'Tower fills the frame' }],
        activities: [{ requirement: 'walking', present: true, confidence: 0.9, evidence: 'People are walking' }]
      })
    })).toMatchObject({ status: 'verified', semanticStatus: 'match' });
  });

  it('rejects high-confidence missing requirements and geography conflicts', () => {
    expect(decideFootageVerification({
      ...base,
      requiredObjects: ['tower'],
      assessment: assessment({
        objects: [{ requirement: 'tower', present: false, confidence: 0.93, evidence: 'No tower visible' }]
      })
    })).toMatchObject({ status: 'rejected', semanticStatus: 'mismatch' });

    expect(decideFootageVerification({
      ...base,
      assessment: assessment({
        geography: {
          verdict: 'mismatch',
          confidence: 0.98,
          country: 'Italy',
          city: 'Rome',
          location: 'Colosseum',
          granularity: 'landmark',
          evidence: ['The Colosseum is visible']
        }
      })
    })).toMatchObject({ status: 'conflict', geographyStatus: 'mismatch' });
  });
});
