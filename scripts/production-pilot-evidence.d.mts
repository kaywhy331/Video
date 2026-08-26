import type { ValidationSource } from './validation-source.mjs';

export type ProductionPilotMode = 'supporting' | 'qualification';
export type ProductionPilotGateId = 'E2E-001' | 'E2E-002' | 'E2E-005' | 'UX-001';
export type ProductionPilotAcceptance = 'qualified' | 'supporting' | 'failed';

export interface ProductionPilotArtifactEvidence {
  sha256: string;
  sizeBytes: number;
  contentSha256?: string;
}

export interface ProductionPilotKeyedArtifactEvidence extends ProductionPilotArtifactEvidence {
  keyHash: string;
}

export interface ProductionPilotProjectEvidence {
  projectIdHash: string;
  destinationKeyHash: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  scheduler: {
    createdRunCount: number;
    triggers: string[];
    projectionSha256: string;
  };
  research: {
    activeHttpSourceCount: number;
    acceptedMaterialClaimCount: number;
    citedAcceptedMaterialClaimCount: number;
    successfulTavilyCallCount: number;
    successfulLanguageCallCount: number;
    finalScriptProvider: string;
    finalScriptLocked: boolean;
  };
  acquisition: {
    activeItemCount: number;
    completedItemCount: number;
    envatoItemCount: number;
    selectedFootageSceneCount: number;
    verifiedFootageSceneCount: number;
    graphicSceneCount: number;
    sceneCount: number;
    licensedAssetCount: number;
    certificateArtifacts: ProductionPilotKeyedArtifactEvidence[];
    sourceArtifacts: ProductionPilotKeyedArtifactEvidence[];
  };
  narration: {
    provider: string;
    sectionCount: number;
    readySectionCount: number;
    providerReceiptCount: number;
    timingMethods: string[];
    audioArtifacts: ProductionPilotKeyedArtifactEvidence[];
  };
  render: {
    renderIdHash: string;
    kind: 'final';
    state: 'SUCCEEDED';
    storedSha256: string;
    artifact: ProductionPilotArtifactEvidence;
    storedManifestSha256: string;
    manifestArtifact: ProductionPilotArtifactEvidence & { contentSha256: string };
    captionArtifacts: ProductionPilotKeyedArtifactEvidence[];
    probe: {
      durationMs: number;
      width: number;
      height: number;
      frameRate: number;
      videoCodec: string;
      audioCodec: string;
    };
  };
  qc: {
    resultCount: number;
    passedCount: number;
    failedCount: number;
    failedBlockerHighCount: number;
  };
  publication: {
    recordCount: number;
    currentRecordCount: number;
    remoteVideoCount: number;
    videoIdHash: string;
    channelIdHash: string;
    channelBindingConfirmed: boolean;
    privacyStatus: string;
    processingStatus: string;
    snapshotStatus: string;
    captionPresent: boolean;
    thumbnailUploaded: boolean;
    packageSelected: boolean;
    approvalHashPresent: boolean;
    approvedAt: string | null;
    scheduledAt: string | null;
    publishedAt: string | null;
    requestedScheduleFallback: boolean;
    thumbnailArtifact: ProductionPilotArtifactEvidence;
  };
  exceptions: { openBlockerHighCount: number };
  audit: {
    entryCount: number;
    projectionSha256: string;
    operatorActions: string[];
  };
}

export interface ProductionPilotEvidenceInput {
  schemaVersion: 1;
  evidenceKind: 'videofactory-production-pilot';
  generatedAt: string;
  harness: 'videofactory-production-pilot';
  mode: ProductionPilotMode;
  appVersion: string;
  runId: string;
  source: ValidationSource;
  environment: {
    platform: string;
    release: string;
    architecture: string;
    node: string;
    ci: boolean;
    deviceClass: string | null;
  };
  database: {
    schemaVersion: number;
    integrity: string;
    artifact: ProductionPilotArtifactEvidence;
  };
  catalog: {
    assetCount: number;
    completedImportCount: number;
    largestCompletedImportRows: number;
    sourceSha256s: string[];
  };
  projects: ProductionPilotProjectEvidence[];
}

export interface ProductionPilotEvidence extends ProductionPilotEvidenceInput {
  thresholds: typeof PRODUCTION_PILOT_THRESHOLDS;
  derived: Record<string, number>;
  projectAssessments: Array<{
    projectIdHash: string;
    completeProduction: boolean;
    scheduleCompleted: boolean;
    finalApprovalCompleted: boolean;
    routineOnly: boolean;
    checks: Record<string, boolean>;
  }>;
  targetEligibility: {
    eligible: boolean;
    checks: Record<string, boolean>;
    reasons: string[];
  };
  acceptance: Record<ProductionPilotGateId, ProductionPilotAcceptance>;
  fieldCriteriaPassed: boolean;
  externalQualificationPassed: boolean;
}

export const PRODUCTION_PILOT_SCHEMA_VERSION: 1;
export const PRODUCTION_PILOT_EVIDENCE_KIND: 'videofactory-production-pilot';
export const PRODUCTION_PILOT_HARNESS: 'videofactory-production-pilot';
export const PRODUCTION_PILOT_GATE_IDS: readonly ProductionPilotGateId[];
export const PRODUCTION_PILOT_THRESHOLDS: Readonly<{
  catalogRows: number;
  projectCount: number;
  destinationClusters: number;
  routineOnlyProjects: number;
  minimumDurationMs: number;
  maximumDurationMs: number;
  minimumShortSidePixels: number;
  targetFrameRate: number;
  frameRateTolerance: number;
}>;
export function assessProductionPilotEvidence(document: ProductionPilotEvidenceInput): ProductionPilotEvidence;
