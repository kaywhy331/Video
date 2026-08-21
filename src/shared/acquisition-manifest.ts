export interface PlannedAcquisitionSelection {
  sceneOrdinal: number;
  assetId: string;
  score: number;
  reasons: string[];
  role: 'selected' | 'alternate' | 'hero';
}

export interface AcquisitionManifestAsset {
  id: string;
  localFileId: string | null;
  canonicalPageUrl: string | null;
}

export interface AcquisitionManifestEntry {
  assetId: string;
  ordinal: number;
  role: 'primary' | 'alternate' | 'hero' | 'license_only';
  state: 'READY_TO_OPEN' | 'LICENSE_ONLY_PENDING';
  sourceUrl: string;
  requiredSceneOrdinals: number[];
  matchScore: number;
  reasons: string[];
}

export function buildAcquisitionManifest(
  selections: PlannedAcquisitionSelection[],
  assets: AcquisitionManifestAsset[]
): AcquisitionManifestEntry[] {
  const assetsById = new Map(assets.map(asset => [asset.id, asset]));
  const grouped = new Map<string, {
    ordinals: number[];
    score: number;
    reasons: string[];
    selected: boolean;
    hero: boolean;
  }>();
  for (const selection of selections) {
    const current = grouped.get(selection.assetId) ?? {
      ordinals: [],
      score: selection.score,
      reasons: selection.reasons,
      selected: false,
      hero: false
    };
    if (!current.ordinals.includes(selection.sceneOrdinal)) {
      current.ordinals.push(selection.sceneOrdinal);
    }
    current.score = Math.max(current.score, selection.score);
    current.selected ||= selection.role === 'selected' || selection.role === 'hero';
    current.hero ||= selection.role === 'hero';
    grouped.set(selection.assetId, current);
  }

  const manifest: AcquisitionManifestEntry[] = [];
  for (const [assetId, data] of grouped) {
    const asset = assetsById.get(assetId);
    if (!asset) continue;
    const local = Boolean(asset.localFileId);
    if (!local && !asset.canonicalPageUrl) continue;
    manifest.push({
      assetId,
      ordinal: manifest.length + 1,
      role: local
        ? 'license_only'
        : data.hero
          ? 'hero'
          : data.selected
            ? 'primary'
            : 'alternate',
      state: local ? 'LICENSE_ONLY_PENDING' : 'READY_TO_OPEN',
      sourceUrl: asset.canonicalPageUrl ?? `urn:videofactory:catalog:${asset.id}`,
      requiredSceneOrdinals: [...data.ordinals].sort((left, right) => left - right),
      matchScore: data.score,
      reasons: data.reasons
    });
  }
  return manifest;
}
