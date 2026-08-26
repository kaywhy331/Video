import { createHash } from 'node:crypto';
import {
  PRODUCTION_PILOT_EVIDENCE_KIND,
  PRODUCTION_PILOT_HARNESS
} from '../../scripts/production-pilot-evidence.mjs';
import type {
  ProductionPilotEvidenceInput,
  ProductionPilotProjectEvidence
} from '../../scripts/production-pilot-evidence.mjs';
import type { ValidationSource } from '../../scripts/validation-source.mjs';

export function pilotDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function artifact(value: string) {
  return {
    sha256: pilotDigest(value),
    sizeBytes: 1_000 + value.length
  };
}

function project(index: number): ProductionPilotProjectEvidence {
  const scheduled = index === 1;
  const finalBytes = `final-${index}`;
  const manifestContent = `manifest-content-${index}`;
  return {
    projectIdHash: pilotDigest(`project-${index}`),
    destinationKeyHash: pilotDigest(`destination-${((index - 1) % 3) + 1}`),
    state: scheduled ? 'SCHEDULED' : 'WAITING_FINAL_APPROVAL',
    createdAt: `2026-08-${String(10 + index).padStart(2, '0')}T12:00:00.000Z`,
    updatedAt: `2026-08-${String(10 + index).padStart(2, '0')}T18:00:00.000Z`,
    scheduler: {
      createdRunCount: 1,
      triggers: ['timer'],
      projectionSha256: pilotDigest(`scheduler-${index}`)
    },
    research: {
      activeHttpSourceCount: 4,
      acceptedMaterialClaimCount: 3,
      citedAcceptedMaterialClaimCount: 3,
      successfulTavilyCallCount: 2,
      successfulLanguageCallCount: 3,
      finalScriptProvider: 'openai_compatible',
      finalScriptLocked: true
    },
    acquisition: {
      activeItemCount: 2,
      completedItemCount: 2,
      envatoItemCount: 2,
      selectedFootageSceneCount: 2,
      verifiedFootageSceneCount: 2,
      graphicSceneCount: 1,
      sceneCount: 3,
      licensedAssetCount: 2,
      certificateArtifacts: [1, 2].map(assetIndex => ({
        keyHash: pilotDigest(`certificate-asset-${index}-${assetIndex}`),
        ...artifact(`certificate-${index}-${assetIndex}`)
      })),
      sourceArtifacts: [1, 2].map(assetIndex => ({
        keyHash: pilotDigest(`source-asset-${index}-${assetIndex}`),
        ...artifact(`source-${index}-${assetIndex}`)
      }))
    },
    narration: {
      provider: index % 2 ? 'windows_sapi' : 'http_tts',
      sectionCount: 2,
      readySectionCount: 2,
      providerReceiptCount: 2,
      timingMethods: ['provider_word'],
      audioArtifacts: [1, 2].map(sectionIndex => ({
        keyHash: pilotDigest(`narration-section-${index}-${sectionIndex}`),
        ...artifact(`narration-${index}-${sectionIndex}`)
      }))
    },
    render: {
      renderIdHash: pilotDigest(`render-${index}`),
      kind: 'final',
      state: 'SUCCEEDED',
      storedSha256: pilotDigest(finalBytes),
      artifact: artifact(finalBytes),
      storedManifestSha256: pilotDigest(manifestContent),
      manifestArtifact: {
        ...artifact(`manifest-file-${index}`),
        contentSha256: pilotDigest(manifestContent)
      },
      captionArtifacts: ['srt', 'vtt'].map(kind => ({
        keyHash: pilotDigest(`caption-${kind}`),
        ...artifact(`caption-${index}-${kind}`)
      })),
      probe: {
        durationMs: 300_000,
        width: 1_920,
        height: 1_080,
        frameRate: 30,
        videoCodec: 'h264',
        audioCodec: 'aac'
      }
    },
    qc: {
      resultCount: 12,
      passedCount: 12,
      failedCount: 0,
      failedBlockerHighCount: 0
    },
    publication: {
      recordCount: 1,
      currentRecordCount: 1,
      remoteVideoCount: 1,
      videoIdHash: pilotDigest(`video-${index}`),
      channelIdHash: pilotDigest('channel-1'),
      channelBindingConfirmed: true,
      privacyStatus: 'private',
      processingStatus: 'succeeded',
      snapshotStatus: 'current',
      captionPresent: true,
      thumbnailUploaded: true,
      packageSelected: true,
      approvalHashPresent: true,
      approvedAt: index <= 4 ? `2026-08-${String(10 + index).padStart(2, '0')}T19:00:00.000Z` : null,
      scheduledAt: scheduled ? '2026-09-01T16:00:00.000Z' : null,
      publishedAt: null,
      requestedScheduleFallback: false,
      thumbnailArtifact: artifact(`thumbnail-${index}`)
    },
    exceptions: { openBlockerHighCount: 0 },
    audit: {
      entryCount: 30,
      projectionSha256: pilotDigest(`audit-${index}`),
      operatorActions: index <= 4
        ? ['license.batch_attested', 'youtube.keep_private']
        : ['license.batch_attested']
    }
  };
}

export function qualifyingProductionPilotEvidence(options: {
  source?: ValidationSource;
  appVersion?: string;
} = {}): ProductionPilotEvidenceInput {
  return {
    schemaVersion: 1,
    evidenceKind: PRODUCTION_PILOT_EVIDENCE_KIND,
    generatedAt: '2026-08-26T20:00:00.000Z',
    harness: PRODUCTION_PILOT_HARNESS,
    mode: 'qualification',
    appVersion: options.appVersion ?? '0.1.0-alpha.7',
    runId: pilotDigest('pilot-run'),
    source: options.source ?? {
      commit: 'a'.repeat(40),
      tree: 'b'.repeat(40),
      ref: 'main',
      repository: 'owner/repository',
      workflowCommit: null,
      runId: null,
      runAttempt: null,
      dirty: false
    },
    environment: {
      platform: 'win32',
      release: '10.0.26100',
      architecture: 'x64',
      node: '22.22.0',
      ci: false,
      deviceClass: 'operator-desktop-x64'
    },
    database: {
      schemaVersion: 24,
      integrity: 'ok',
      artifact: artifact('database')
    },
    catalog: {
      assetCount: 26_000,
      completedImportCount: 1,
      largestCompletedImportRows: 26_000,
      sourceSha256s: [pilotDigest('catalog-source')]
    },
    projects: [1, 2, 3, 4, 5].map(project)
  };
}
