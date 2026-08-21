import { describe, expect, it } from 'vitest';
import { buildAcquisitionManifest } from '@shared/acquisition-manifest';

describe('minimal ordered acquisition manifest', () => {
  it('[ACQ-001] deduplicates downloads and labels primary, alternate, hero, and license-only work', () => {
    const manifest = buildAcquisitionManifest([
      { sceneOrdinal: 1, assetId: 'primary', score: 90, reasons: ['scene 1'], role: 'selected' },
      { sceneOrdinal: 2, assetId: 'primary', score: 94, reasons: ['scene 2'], role: 'selected' },
      { sceneOrdinal: 1, assetId: 'alternate', score: 82, reasons: ['backup'], role: 'alternate' },
      { sceneOrdinal: 3, assetId: 'hero', score: 99, reasons: ['hook'], role: 'hero' },
      { sceneOrdinal: 4, assetId: 'local', score: 88, reasons: ['already local'], role: 'selected' }
    ], [
      { id: 'primary', localFileId: null, canonicalPageUrl: 'https://elements.envato.com/primary' },
      { id: 'alternate', localFileId: null, canonicalPageUrl: 'https://elements.envato.com/alternate' },
      { id: 'hero', localFileId: null, canonicalPageUrl: 'https://elements.envato.com/hero' },
      { id: 'local', localFileId: 'file-local', canonicalPageUrl: null }
    ]);

    expect(manifest).toEqual([
      expect.objectContaining({
        ordinal: 1, assetId: 'primary', role: 'primary', state: 'READY_TO_OPEN',
        requiredSceneOrdinals: [1, 2], matchScore: 94
      }),
      expect.objectContaining({ ordinal: 2, assetId: 'alternate', role: 'alternate' }),
      expect.objectContaining({ ordinal: 3, assetId: 'hero', role: 'hero' }),
      expect.objectContaining({
        ordinal: 4, assetId: 'local', role: 'license_only', state: 'LICENSE_ONLY_PENDING',
        sourceUrl: 'urn:videofactory:catalog:local'
      })
    ]);
    expect(manifest.filter(item => item.state === 'READY_TO_OPEN')).toHaveLength(3);
  });
});
