import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  Database,
  FileDown,
  FileSpreadsheet,
  Filter,
  Grid3X3,
  Image,
  Inbox,
  Layers3,
  List,
  Map as MapIcon,
  MapPin,
  Merge,
  Pencil,
  RefreshCw,
  Search,
  Split,
  Upload,
  X
} from 'lucide-react';
import type {
  CanonicalPlace,
  CatalogAsset,
  CatalogImportPreview,
  CatalogImportResult,
  CatalogSearchRequest,
  CatalogSearchResult,
  CatalogStats,
  CoverageCluster,
  MetadataAssertion,
  MetadataRevision
} from '@shared/types';
import { Button, EmptyState, MetricCard, Panel, StatusPill } from '../components/ui';

type LibraryMode = 'grid' | 'table' | 'coverage' | 'map' | 'inbox';
type TriState = 'all' | 'yes' | 'no';

const EMPTY_RESULT: CatalogSearchResult = {
  rows: [],
  total: 0,
  page: 1,
  pageSize: 50,
  facets: { countries: [], cities: [], locations: [], authors: [] }
};

const FIELD_LABELS: Record<string, string> = {
  sourceRowId: 'Source row ID', canonicalPageUrl: 'Asset URL', authorName: 'Author',
  rawAttributes: 'Attributes', rawTags: 'Tags', title: 'Title', description: 'Description',
  rawExtractedData: 'Extracted data', country: 'Country', city: 'City',
  locationName: 'Exact location', activity: 'Activity', shotType: 'Shot type',
  sceneDescription: 'Scene', objects: 'Objects', timeOfDay: 'Time of day', style: 'Style',
  declaredDuration: 'Duration', thumbnailUrl: 'Thumbnail', declaredResolution: 'Resolution',
  declaredFileSize: 'File size', declaredFrameRate: 'Frame rate', declaredAlpha: 'Alpha channel',
  declaredLooped: 'Looped', declaredCodec: 'Codec', orientation: 'Orientation'
};

const SEARCHABLE_FIELDS: Array<{ value: NonNullable<CatalogSearchRequest['metadataField']>; label: string }> = [
  { value: 'providerAssetId', label: 'Provider asset ID' }, { value: 'sourceRowId', label: 'Source row ID' },
  { value: 'canonicalPageUrl', label: 'Canonical URL' }, { value: 'authorName', label: 'Author' },
  { value: 'title', label: 'Title' }, { value: 'description', label: 'Description' },
  { value: 'rawAttributes', label: 'Attributes' }, { value: 'rawTags', label: 'Tags' },
  { value: 'country', label: 'Country' }, { value: 'city', label: 'City' },
  { value: 'locationName', label: 'Location' }, { value: 'activity', label: 'Activity' },
  { value: 'shotType', label: 'Shot type' }, { value: 'sceneDescription', label: 'Scene' },
  { value: 'objects', label: 'Objects' }, { value: 'timeOfDay', label: 'Time of day' },
  { value: 'style', label: 'Style' }, { value: 'declaredCodec', label: 'Codec' }
];

function triState(value: TriState): boolean | undefined {
  return value === 'all' ? undefined : value === 'yes';
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function LibraryView({
  initialStats,
  onRefresh,
  setError
}: {
  initialStats: CatalogStats;
  onRefresh: () => Promise<void>;
  setError: (message: string | null) => void;
}) {
  const [stats, setStats] = useState(initialStats);
  const [result, setResult] = useState<CatalogSearchResult>(EMPTY_RESULT);
  const [coverage, setCoverage] = useState<CoverageCluster[]>([]);
  const [places, setPlaces] = useState<CanonicalPlace[]>([]);
  const [inbox, setInbox] = useState<MetadataAssertion[]>([]);
  const [mode, setMode] = useState<LibraryMode>('table');
  const [query, setQuery] = useState('');
  const [country, setCountry] = useState('');
  const [city, setCity] = useState('');
  const [downloaded, setDownloaded] = useState<TriState>('all');
  const [used, setUsed] = useState<TriState>('all');
  const [licensed, setLicensed] = useState<TriState>('all');
  const [verification, setVerification] = useState('');
  const [confidence, setConfidence] = useState('');
  const [mediaStatus, setMediaStatus] = useState('');
  const [orientation, setOrientation] = useState('');
  const [metadataField, setMetadataField] = useState<CatalogSearchRequest['metadataField']>();
  const [metadataValue, setMetadataValue] = useState('');
  const [page, setPage] = useState(1);
  const [preview, setPreview] = useState<CatalogImportPreview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [mappingDirty, setMappingDirty] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [activeImportOperationId, setActiveImportOperationId] = useState<string | null>(null);
  const [importCancellationRequested, setImportCancellationRequested] = useState(false);
  const [lastImport, setLastImport] = useState<CatalogImportResult | null>(null);
  const [selectedAsset, setSelectedAsset] = useState<CatalogAsset | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [reviewBusy, setReviewBusy] = useState<string | null>(null);

  const request = useMemo<CatalogSearchRequest>(() => ({
    query: query || undefined,
    country: country || undefined,
    city: city || undefined,
    orientation: orientation as CatalogAsset['orientation'] || undefined,
    verificationStatus: verification as CatalogAsset['verificationStatus'] || undefined,
    minimumLocationConfidence: confidence ? Number(confidence) : undefined,
    downloaded: triState(downloaded),
    used: triState(used),
    licensed: triState(licensed),
    mediaStatus: mediaStatus as CatalogAsset['mediaStatus'] || undefined,
    metadataField: metadataField && metadataValue.trim() ? metadataField : undefined,
    metadataValue: metadataField && metadataValue.trim() ? metadataValue.trim() : undefined,
    page,
    pageSize: 50,
    sortBy: 'updated',
    sortDirection: 'desc'
  }), [
    query, country, city, orientation, verification, confidence, downloaded,
    used, licensed, mediaStatus, metadataField, metadataValue, page
  ]);

  async function loadCatalog(): Promise<void> {
    setResult(await window.videoFactory.catalog.search(request));
  }

  async function loadSummary(): Promise<void> {
    const [clusters, catalogStats] = await Promise.all([
      window.videoFactory.catalog.coverage(100),
      window.videoFactory.catalog.stats()
    ]);
    setCoverage(clusters);
    setStats(catalogStats);
  }

  async function load(): Promise<void> {
    await Promise.all([loadCatalog(), loadSummary()]);
  }

  async function loadEvidence(): Promise<void> {
    const [nextPlaces, nextInbox] = await Promise.all([
      window.videoFactory.places.list(),
      window.videoFactory.catalog.metadataInbox()
    ]);
    setPlaces(nextPlaces);
    setInbox(nextInbox);
  }

  useEffect(() => {
    let current = true;
    const timer = setTimeout(() => {
      void window.videoFactory.catalog.search(request).then(catalog => {
        if (current) setResult(catalog);
      }).catch(error => {
        if (current) setError(error instanceof Error ? error.message : String(error));
      });
    }, 220);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [request]);

  useEffect(() => {
    if (mode === 'coverage' || mode === 'map') {
      void loadSummary().catch(error => setError(error instanceof Error ? error.message : String(error)));
    }
    if (mode === 'map' || mode === 'inbox') {
      void loadEvidence().catch(error => setError(error instanceof Error ? error.message : String(error)));
    }
  }, [mode]);

  useEffect(() => {
    const openStagedSheetPreview = async (): Promise<void> => {
      const runs = await window.videoFactory.expansion.googleSheetsRuns();
      const staged = runs.find(run => run.status === 'staged' && run.previewId);
      if (!staged?.previewId) return;
      const next = await window.videoFactory.expansion.googleSheetsPreview(staged.previewId);
      setPreview(next);
      setMapping(next.mapping);
      setMappingDirty(false);
    };
    void openStagedSheetPreview().catch(error => setError(error instanceof Error ? error.message : String(error)));
  }, []);

  function resetPage(): void {
    setPage(1);
  }

  async function chooseImport(): Promise<void> {
    const operationId = crypto.randomUUID();
    setImportBusy(true);
    setActiveImportOperationId(operationId);
    setImportCancellationRequested(false);
    setError(null);
    try {
      const next = await window.videoFactory.catalog.chooseImport(operationId);
      if (next) {
        setPreview(next);
        setMapping(next.mapping);
        setMappingDirty(false);
        setLastImport(null);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.toLowerCase().includes('cancel')) setError(message);
    } finally {
      setImportBusy(false);
      setActiveImportOperationId(null);
      setImportCancellationRequested(false);
    }
  }

  async function recalculateImport(sheetName = preview?.selectedSheet): Promise<void> {
    if (!preview || !sheetName) return;
    const operationId = crypto.randomUUID();
    setImportBusy(true);
    setActiveImportOperationId(operationId);
    setImportCancellationRequested(false);
    setError(null);
    try {
      const next = await window.videoFactory.catalog.previewImport({
        filePath: preview.filePath,
        sheetName,
        mapping: sheetName === preview.selectedSheet ? mapping : undefined,
        operationId
      });
      setPreview(next);
      setMapping(next.mapping);
      setMappingDirty(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.toLowerCase().includes('cancel')) setError(message);
    } finally {
      setImportBusy(false);
      setActiveImportOperationId(null);
      setImportCancellationRequested(false);
    }
  }

  async function cancelImport(): Promise<void> {
    if (activeImportOperationId) {
      setImportCancellationRequested(true);
      await window.videoFactory.catalog.cancelOperation(activeImportOperationId);
      return;
    }
    if (!preview) return;
    try {
      await window.videoFactory.catalog.cancelImport(preview.previewId);
    } finally {
      setPreview(null);
      setMappingDirty(false);
    }
  }

  async function commitImport(): Promise<void> {
    if (!preview || mappingDirty) return;
    const operationId = crypto.randomUUID();
    setImportBusy(true);
    setActiveImportOperationId(operationId);
    setImportCancellationRequested(false);
    setError(null);
    try {
      const receipt = await window.videoFactory.catalog.commitImport({
        previewId: preview.previewId,
        filePath: preview.filePath,
        sheetName: preview.selectedSheet,
        mapping,
        operationId
      });
      setLastImport(receipt);
      setPreview(null);
      await Promise.all([load(), loadEvidence(), onRefresh()]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.toLowerCase().includes('cancel')) setError(message);
    } finally {
      setImportBusy(false);
      setActiveImportOperationId(null);
      setImportCancellationRequested(false);
    }
  }

  async function exportFiltered(): Promise<void> {
    setError(null);
    try {
      await window.videoFactory.catalog.exportFiltered({ ...request, page: 1, pageSize: 500 });
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }

  async function reviewSuggestion(assertionId: string, decision: 'accept' | 'reject'): Promise<void> {
    setReviewBusy(assertionId);
    setError(null);
    try {
      await window.videoFactory.catalog.reviewSuggestion(assertionId, decision);
      await Promise.all([load(), loadEvidence()]);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setReviewBusy(null);
    }
  }

  function toggleAsset(assetId: string): void {
    setSelectedIds(current => {
      const next = new Set(current);
      if (next.has(assetId)) next.delete(assetId); else next.add(assetId);
      return next;
    });
  }

  const maxPage = Math.max(1, Math.ceil(result.total / result.pageSize));
  const pageSelected = result.rows.length > 0 && result.rows.every(asset => selectedIds.has(asset.id));

  return (
    <div className="view-stack">
      <div className="page-heading">
        <div>
          <div className="eyebrow"><Database size={14} /> FOOTAGE INTELLIGENCE</div>
          <h1>Ground every production decision in catalog evidence.</h1>
          <p>Inspect metadata layers, curate places, measure coverage, and export exactly the working set you filtered.</p>
        </div>
        <div className="heading-actions">
          <Button variant="secondary" onClick={() => void exportFiltered()}><FileDown size={16} /> Export filtered</Button>
          {activeImportOperationId ? (
            <Button
              variant="ghost"
              disabled={importCancellationRequested}
              onClick={() => void cancelImport()}
            >
              <X size={16} /> {importCancellationRequested ? 'Cancelling safely…' : 'Cancel import'}
            </Button>
          ) : null}
          <Button busy={importBusy} onClick={() => void chooseImport()}><Upload size={16} /> Import catalog</Button>
        </div>
      </div>

      {lastImport ? (
        <div className="catalog-receipt" role="status">
          <Check size={16} />
          <strong>Import committed</strong>
          <span>{lastImport.inserted} new · {lastImport.updated} changed · {lastImport.conflicts} conflicts · {lastImport.missing} missing · {lastImport.invalid} invalid</span>
          <button onClick={() => setLastImport(null)} aria-label="Dismiss import receipt"><X size={14} /></button>
        </div>
      ) : null}

      <div className="metric-grid">
        <MetricCard label="Assets" value={stats.totalAssets.toLocaleString()} detail={`${stats.imports} catalog import(s)`} />
        <MetricCard label="Downloaded" value={stats.downloadedAssets.toLocaleString()} detail="Originals stored once by hash" />
        <MetricCard label="Verified" value={stats.verifiedAssets.toLocaleString()} detail="Human-confirmed geography" />
        <MetricCard label="Coverage" value={stats.locations.toLocaleString()} detail={`${stats.cities} cities · ${stats.countries} countries`} />
      </div>

      <Panel className="library-workspace">
        <div className="library-mode-tabs" role="tablist" aria-label="Library view">
          {([
            ['grid', Grid3X3, 'Grid'], ['table', List, 'Table'], ['coverage', Layers3, 'Coverage'],
            ['map', MapIcon, 'Map'], ['inbox', Inbox, `Metadata inbox${inbox.length ? ` (${inbox.length})` : ''}`]
          ] as const).map(([value, Icon, label]) => (
            <button key={value} role="tab" aria-selected={mode === value} className={mode === value ? 'active' : ''} onClick={() => setMode(value)}>
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>

        <div className="catalog-toolbar">
          <label className="search-input">
            <Search size={16} />
            <input aria-label="Search catalog" value={query} onChange={event => { setQuery(event.target.value); resetPage(); }} placeholder="Search title, geography, objects, activity, scene, style…" />
          </label>
          <label><Filter size={14} />
            <select aria-label="Country" value={country} onChange={event => { setCountry(event.target.value); setCity(''); resetPage(); }}>
              <option value="">All countries</option>
              {result.facets.countries.map(item => <option key={item.value} value={item.value}>{item.value} ({item.count})</option>)}
            </select>
          </label>
          <label><MapPin size={14} />
            <select aria-label="City" value={city} onChange={event => { setCity(event.target.value); resetPage(); }}>
              <option value="">All cities</option>
              {result.facets.cities.map(item => <option key={item.value} value={item.value}>{item.value} ({item.count})</option>)}
            </select>
          </label>
        </div>

        <div className="catalog-filter-grid">
          <label><span>Local file</span><select value={downloaded} onChange={event => { setDownloaded(event.target.value as TriState); resetPage(); }}><option value="all">Any</option><option value="yes">Downloaded</option><option value="no">Metadata only</option></select></label>
          <label><span>Use history</span><select value={used} onChange={event => { setUsed(event.target.value as TriState); resetPage(); }}><option value="all">Any</option><option value="yes">Used</option><option value="no">Unused</option></select></label>
          <label><span>License history</span><select value={licensed} onChange={event => { setLicensed(event.target.value as TriState); resetPage(); }}><option value="all">Any</option><option value="yes">Licensed</option><option value="no">Unlicensed</option></select></label>
          <label><span>Verification</span><select value={verification} onChange={event => { setVerification(event.target.value); resetPage(); }}><option value="">Any</option>{['unverified','metadata','ai_suggested','human_verified','conflict'].map(value => <option key={value}>{value}</option>)}</select></label>
          <label><span>Confidence</span><select value={confidence} onChange={event => { setConfidence(event.target.value); resetPage(); }}><option value="">Any</option><option value="0.5">50%+</option><option value="0.8">80%+</option><option value="1">Verified 100%</option></select></label>
          <label><span>Media status</span><select value={mediaStatus} onChange={event => { setMediaStatus(event.target.value); resetPage(); }}><option value="">Any</option>{['metadata_only','downloaded','analyzed','usable_1080p','usable_4k'].map(value => <option key={value}>{value}</option>)}</select></label>
          <label><span>Orientation</span><select value={orientation} onChange={event => { setOrientation(event.target.value); resetPage(); }}><option value="">Any</option>{['landscape','portrait','square','unknown'].map(value => <option key={value}>{value}</option>)}</select></label>
          <label><span>Metadata field</span><select value={metadataField ?? ''} onChange={event => { setMetadataField((event.target.value || undefined) as CatalogSearchRequest['metadataField']); resetPage(); }}><option value="">None</option>{SEARCHABLE_FIELDS.map(field => <option key={field.value} value={field.value}>{field.label}</option>)}</select></label>
          <label className="metadata-value-filter"><span>Contains</span><input value={metadataValue} disabled={!metadataField} onChange={event => { setMetadataValue(event.target.value); resetPage(); }} placeholder="Filter selected metadata field" /></label>
        </div>

        <div className="library-result-bar">
          <span>{result.total.toLocaleString()} matching assets</span>
          {selectedIds.size ? <strong>{selectedIds.size.toLocaleString()} selected across pages</strong> : null}
          <div>
            {selectedIds.size ? <Button variant="secondary" onClick={() => setBulkOpen(true)}>Bulk edit</Button> : null}
            {selectedIds.size ? <Button variant="ghost" onClick={() => setSelectedIds(new Set())}>Clear selection</Button> : null}
            {mode === 'grid' || mode === 'table' ? (
              <div className="table-pagination">
                <button disabled={page <= 1} onClick={() => setPage(value => value - 1)}>Previous</button>
                <span>{page} / {maxPage}</span>
                <button disabled={page >= maxPage} onClick={() => setPage(value => value + 1)}>Next</button>
              </div>
            ) : null}
          </div>
        </div>

        {mode === 'grid' ? <AssetGrid assets={result.rows} selectedIds={selectedIds} onToggle={toggleAsset} onEdit={setSelectedAsset} /> : null}
        {mode === 'table' ? <AssetTable assets={result.rows} selectedIds={selectedIds} pageSelected={pageSelected} onToggle={toggleAsset} onTogglePage={() => setSelectedIds(current => {
          const next = new Set(current);
          for (const asset of result.rows) pageSelected ? next.delete(asset.id) : next.add(asset.id);
          return next;
        })} onEdit={setSelectedAsset} /> : null}
        {mode === 'coverage' ? <CoverageView clusters={coverage} onFilter={cluster => { setCountry(cluster.country ?? ''); setCity(cluster.city ?? ''); setMode('grid'); resetPage(); }} /> : null}
        {mode === 'map' ? <PlaceMapView places={places} selectedAssetIds={[...selectedIds]} onChanged={async () => { await Promise.all([load(), loadEvidence()]); }} setError={setError} /> : null}
        {mode === 'inbox' ? <MetadataInbox assertions={inbox} busyId={reviewBusy} onReview={reviewSuggestion} /> : null}
      </Panel>

      {preview ? (
        <ImportPreviewModal
          preview={preview}
          mapping={mapping}
          dirty={mappingDirty}
          busy={importBusy}
          setMapping={(field, column) => { setMapping(current => ({ ...current, [field]: column })); setMappingDirty(true); }}
          onSheet={sheet => void recalculateImport(sheet)}
          onRecalculate={() => void recalculateImport()}
          onCancel={() => void cancelImport()}
          onCommit={() => void commitImport()}
        />
      ) : null}

      {selectedAsset ? (
        <AssetEditDrawer asset={selectedAsset} onClose={() => setSelectedAsset(null)} onSaved={async () => {
          setSelectedAsset(null);
          await Promise.all([load(), loadEvidence(), onRefresh()]);
        }} setError={setError} />
      ) : null}

      {bulkOpen ? (
        <BulkEditDrawer assetIds={[...selectedIds]} onClose={() => setBulkOpen(false)} onSaved={async () => {
          setBulkOpen(false);
          setSelectedIds(new Set());
          await Promise.all([load(), loadEvidence(), onRefresh()]);
        }} setError={setError} />
      ) : null}
    </div>
  );
}

function AssetGrid({ assets, selectedIds, onToggle, onEdit }: {
  assets: CatalogAsset[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  onEdit: (asset: CatalogAsset) => void;
}) {
  if (!assets.length) return <EmptyState title="No assets match" body="Adjust the working-set filters or import a catalog." />;
  return (
    <div className="catalog-card-grid">
      {assets.map(asset => (
        <article key={asset.id} className={`catalog-asset-card ${selectedIds.has(asset.id) ? 'selected' : ''}`}>
          <button className="asset-card-select" aria-label={`Select ${asset.title}`} aria-pressed={selectedIds.has(asset.id)} onClick={() => onToggle(asset.id)}>{selectedIds.has(asset.id) ? <Check size={13} /> : null}</button>
          <div className="asset-card-image">{asset.thumbnailUrl ? <img src={asset.thumbnailUrl} alt="" /> : <Image size={22} />}</div>
          <div className="asset-card-body">
            <strong>{asset.title}</strong>
            <span><MapPin size={11} /> {asset.locationName ?? asset.city ?? asset.country ?? 'Unspecified'}</span>
            <div className="asset-card-pills"><StatusPill value={asset.mediaStatus} /><StatusPill value={asset.verificationStatus} /></div>
            <small>{asset.shotType ?? asset.activity ?? 'No shot classification'} · {Math.round(asset.locationConfidence * 100)}% confidence</small>
          </div>
          <button className="icon-button asset-card-edit" aria-label={`Edit ${asset.title}`} onClick={() => onEdit(asset)}><Pencil size={14} /></button>
        </article>
      ))}
    </div>
  );
}

function AssetTable({ assets, selectedIds, pageSelected, onToggle, onTogglePage, onEdit }: {
  assets: CatalogAsset[];
  selectedIds: Set<string>;
  pageSelected: boolean;
  onToggle: (id: string) => void;
  onTogglePage: () => void;
  onEdit: (asset: CatalogAsset) => void;
}) {
  if (!assets.length) return <EmptyState title="No assets match" body="Adjust the working-set filters or import a catalog." />;
  return (
    <div className="catalog-table-wrap">
      <table className="catalog-table catalog-table-selectable">
        <thead><tr>
          <th><input type="checkbox" checked={pageSelected} onChange={onTogglePage} aria-label="Select this page" /></th>
          <th>Preview</th><th>Asset</th><th>Geography</th><th>Visual metadata</th><th>Technical / rights</th><th>Status</th><th />
        </tr></thead>
        <tbody>{assets.map(asset => (
          <tr key={asset.id} className={selectedIds.has(asset.id) ? 'selected' : ''}>
            <td><input type="checkbox" checked={selectedIds.has(asset.id)} onChange={() => onToggle(asset.id)} aria-label={`Select ${asset.title}`} /></td>
            <td><div className="catalog-thumb">{asset.thumbnailUrl ? <img src={asset.thumbnailUrl} alt="" /> : <Image size={18} />}</div></td>
            <td><strong>{asset.title}</strong><span>{asset.authorName ?? 'Unknown author'}</span></td>
            <td><strong>{asset.locationName ?? asset.city ?? asset.country ?? 'Unspecified'}</strong><span>{Math.round(asset.locationConfidence * 100)}% · {asset.locationGranularity}</span></td>
            <td><strong>{asset.shotType ?? asset.activity ?? '—'}</strong><span>{asset.objects ?? asset.sceneDescription ?? 'No object metadata'}</span></td>
            <td><strong>{asset.declaredWidth && asset.declaredHeight ? `${asset.declaredWidth}×${asset.declaredHeight}` : 'Unknown resolution'}</strong><span>{asset.usedProjectCount} use(s) · {asset.licensedProjectCount} licensed</span></td>
            <td><StatusPill value={asset.mediaStatus} /><small>{asset.verificationStatus.replaceAll('_', ' ')}</small></td>
            <td><button className="icon-button" aria-label={`Edit ${asset.title}`} onClick={() => onEdit(asset)}><Pencil size={15} /></button></td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function CoverageView({ clusters, onFilter }: { clusters: CoverageCluster[]; onFilter: (cluster: CoverageCluster) => void }) {
  if (!clusters.length) return <EmptyState title="No coverage evidence" body="Coverage appears after a catalog import." />;
  return (
    <div className="coverage-matrix-wrap">
      <table className="coverage-matrix">
        <thead><tr><th>Destination cluster</th><th>Assets / shots</th><th>Shot balance</th><th>Variety</th><th>Resolution / confidence</th><th>Risk / gaps</th></tr></thead>
        <tbody>{clusters.map(cluster => (
          <tr key={cluster.key} onClick={() => onFilter(cluster)}>
            <td><strong>{cluster.locationName ?? cluster.city ?? cluster.country ?? 'Unknown'}</strong><span>{[cluster.city, cluster.country].filter(Boolean).join(', ')}</span><b>{Math.round(cluster.coverageScore)} coverage</b></td>
            <td><strong>{cluster.assetCount} assets</strong><span>{cluster.estimatedUniqueShots} estimated shots</span><span>{cluster.uniqueActivities} activities · {cluster.representedObjects.length} objects</span></td>
            <td><span>Aerial {cluster.shotBalance.aerial}</span><span>Wide {cluster.shotBalance.wide}</span><span>Medium {cluster.shotBalance.medium}</span><span>Detail {cluster.shotBalance.detail}</span></td>
            <td><span>Day {cluster.variety.day}</span><span>Night {cluster.variety.night}</span><span>Weather {cluster.variety.weather}</span><span>Portrait {cluster.portraitCount}</span></td>
            <td><span>1080p {cluster.fullHdEligibleCount}</span><span>4K {cluster.fourKCount}</span><span>Verified {cluster.exactConfidenceDistribution.verified}</span><span>Strong {cluster.exactConfidenceDistribution.strong}</span></td>
            <td><strong>{Math.round(cluster.repetitionRisk * 100)}% repetition risk</strong><span>{cluster.missingVisualCategories.length ? cluster.missingVisualCategories.join(', ') : 'No structural gaps detected'}</span></td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function PlaceMapView({ places, selectedAssetIds, onChanged, setError }: {
  places: CanonicalPlace[];
  selectedAssetIds: string[];
  onChanged: () => Promise<void>;
  setError: (message: string | null) => void;
}) {
  const [sources, setSources] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState('');
  const [mergeReason, setMergeReason] = useState('');
  const [splitSource, setSplitSource] = useState('');
  const [splitName, setSplitName] = useState('');
  const [splitType, setSplitType] = useState<CanonicalPlace['type']>('landmark');
  const [splitParent, setSplitParent] = useState('');
  const [splitReason, setSplitReason] = useState('');
  const [busy, setBusy] = useState(false);
  const located = places.filter(place => place.latitude !== null && place.longitude !== null);

  async function mergePlaces(): Promise<void> {
    setBusy(true); setError(null);
    try {
      await window.videoFactory.places.merge({ sourcePlaceIds: [...sources], targetPlaceId: target, reason: mergeReason });
      setSources(new Set()); setTarget(''); setMergeReason('');
      await onChanged();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function splitPlace(): Promise<void> {
    setBusy(true); setError(null);
    try {
      await window.videoFactory.places.split({
        sourcePlaceId: splitSource, assetIds: selectedAssetIds, name: splitName,
        type: splitType, parentId: splitParent || null, aliases: [], reason: splitReason
      });
      setSplitSource(''); setSplitName(''); setSplitParent(''); setSplitReason('');
      await onChanged();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  return (
    <div className="place-workspace">
      <div className="place-map-card">
        <div className="place-map-header"><strong>Coordinate evidence</strong><span>{located.length} of {places.length} canonical places have coordinates</span></div>
        <div className="evidence-map" aria-label="Canonical places with coordinate evidence">
          <div className="equator" />
          {located.map(place => (
            <button key={place.id} title={`${place.name} · ${place.latitude}, ${place.longitude}`} style={{ left: `${((place.longitude! + 180) / 360) * 100}%`, top: `${((90 - place.latitude!) / 180) * 100}%` }} onClick={() => setTarget(place.id)}><span>{place.name}</span></button>
          ))}
          {!located.length ? <div className="map-empty">No coordinate-backed places yet. Names remain grounded in the hierarchy and are never plotted speculatively.</div> : null}
        </div>
        <div className="place-list">
          {places.slice(0, 250).map(place => (
            <label key={place.id} className={sources.has(place.id) ? 'selected' : ''}>
              <input type="checkbox" checked={sources.has(place.id)} disabled={place.id === target} onChange={() => setSources(current => { const next = new Set(current); if (next.has(place.id)) next.delete(place.id); else next.add(place.id); return next; })} />
              <span><strong>{place.name}</strong><small>{place.type} · {place.assetCount} asset assertion(s){place.aliases.length ? ` · aliases: ${place.aliases.join(', ')}` : ''}</small></span>
            </label>
          ))}
        </div>
      </div>
      <div className="place-operation-stack">
        <section><div className="eyebrow"><Merge size={13} /> MERGE LOCATIONS</div><p>Tick duplicate source places, then preserve their evidence and aliases under one target.</p>
          <label><span>Target place</span><select value={target} onChange={event => { setTarget(event.target.value); setSources(current => { const next = new Set(current); next.delete(event.target.value); return next; }); }}><option value="">Choose target</option>{places.map(place => <option key={place.id} value={place.id}>{place.name} · {place.type}</option>)}</select></label>
          <label><span>Audit reason</span><textarea value={mergeReason} onChange={event => setMergeReason(event.target.value)} /></label>
          <Button busy={busy} disabled={!target || !sources.size || !mergeReason.trim()} onClick={() => void mergePlaces()}>Merge {sources.size || ''} source{sources.size === 1 ? '' : 's'}</Button>
        </section>
        <section><div className="eyebrow"><Split size={13} /> SPLIT LOCATION</div><p>Move the assets selected in Grid/Table into a newly evidenced place. Current selection: {selectedAssetIds.length}.</p>
          <label><span>Source place</span><select value={splitSource} onChange={event => setSplitSource(event.target.value)}><option value="">Choose source</option>{places.map(place => <option key={place.id} value={place.id}>{place.name} · {place.type}</option>)}</select></label>
          <label><span>New name</span><input value={splitName} onChange={event => setSplitName(event.target.value)} /></label>
          <div className="split-place-fields"><label><span>Type</span><select value={splitType} onChange={event => setSplitType(event.target.value as CanonicalPlace['type'])}>{['country','region','city','neighborhood','landmark','feature'].map(value => <option key={value}>{value}</option>)}</select></label><label><span>Parent</span><select value={splitParent} onChange={event => setSplitParent(event.target.value)}><option value="">Root</option>{places.map(place => <option key={place.id} value={place.id}>{place.name}</option>)}</select></label></div>
          <label><span>Audit reason</span><textarea value={splitReason} onChange={event => setSplitReason(event.target.value)} /></label>
          <Button busy={busy} disabled={!splitSource || !splitName.trim() || !selectedAssetIds.length || !splitReason.trim()} onClick={() => void splitPlace()}>Split selected assets</Button>
        </section>
      </div>
    </div>
  );
}

function MetadataInbox({ assertions, busyId, onReview }: {
  assertions: MetadataAssertion[];
  busyId: string | null;
  onReview: (id: string, decision: 'accept' | 'reject') => Promise<void>;
}) {
  if (!assertions.length) return <EmptyState title="Metadata inbox is clear" body="AI suggestions appear here until an operator accepts or rejects them." />;
  return (
    <div className="metadata-inbox-list">
      {assertions.map(assertion => (
        <article key={assertion.id}>
          <div><span className="field-label">{assertion.fieldName}</span><strong>{assertion.assetTitle ?? assertion.assetId}</strong><p>{displayValue(assertion.value)}</p></div>
          <div className="assertion-provenance"><span>{assertion.provider} / {assertion.model}</span><span>{assertion.confidence === null ? 'No confidence' : `${Math.round(assertion.confidence * 100)}% confidence`}</span><small>{assertion.evidenceRef ?? 'No external evidence reference'}</small></div>
          <div className="inbox-actions"><Button variant="ghost" busy={busyId === assertion.id} onClick={() => void onReview(assertion.id, 'reject')}>Reject</Button><Button busy={busyId === assertion.id} onClick={() => void onReview(assertion.id, 'accept')}><Check size={14} /> Accept</Button></div>
        </article>
      ))}
    </div>
  );
}

function ImportPreviewModal({ preview, mapping, dirty, busy, setMapping, onSheet, onRecalculate, onCancel, onCommit }: {
  preview: CatalogImportPreview;
  mapping: Record<string, string | null>;
  dirty: boolean;
  busy: boolean;
  setMapping: (field: string, column: string | null) => void;
  onSheet: (sheet: string) => void;
  onRecalculate: () => void;
  onCancel: () => void;
  onCommit: () => void;
}) {
  const diff = preview.diff;
  return (
    <div className="modal-backdrop">
      <div className="import-modal import-evidence-modal">
        <header><div><span className="field-label">STAGED IMPORT · NO CATALOG CHANGES YET</span><h2>{preview.filePath.split(/[\\/]/).pop()}</h2><p>{preview.rowCount.toLocaleString()} source rows</p></div><button className="icon-button" onClick={onCancel}><X size={20} /></button></header>
        <div className="import-diff-grid">
          {([['New', diff.inserted], ['Changed', diff.changed], ['Conflicts', diff.conflicts], ['Missing', diff.missing], ['Unchanged', diff.unchanged], ['Invalid', diff.invalid]] as const).map(([label, value]) => <div key={label} className={label === 'Conflicts' || label === 'Invalid' ? 'warning' : ''}><span>{label}</span><strong>{value.toLocaleString()}</strong></div>)}
        </div>
        <div className="import-preview-controls"><label><span>Worksheet</span><select value={preview.selectedSheet} onChange={event => onSheet(event.target.value)}>{preview.sheetNames.map(sheet => <option key={sheet}>{sheet}</option>)}</select></label>{dirty ? <div className="mapping-stale"><RefreshCw size={15} /><span>Mapping changed. Recalculate the diff before commit.</span><Button busy={busy} onClick={onRecalculate}>Recalculate diff</Button></div> : <div className="mapping-current"><Check size={15} /> Diff matches this exact source hash, worksheet, and mapping.</div>}</div>
        {preview.warnings.length ? <div className="import-warning-list">{preview.warnings.map(warning => <span key={warning}>{warning}</span>)}</div> : null}
        <div className="mapping-grid">{Object.entries(mapping).map(([field, column]) => <label key={field}><span>{FIELD_LABELS[field] ?? field}</span><select value={column ?? ''} onChange={event => setMapping(field, event.target.value || null)}><option value="">Not mapped</option>{preview.columns.map(option => <option key={option} value={option}>{option}</option>)}</select></label>)}</div>
        <details className="import-evidence-details"><summary>Review representative changes and source rows</summary><div className="import-samples"><section><strong>New</strong>{diff.sampleInserted.map(value => <span key={value}>{value}</span>)}</section><section><strong>Changed</strong>{diff.sampleChanged.map(value => <span key={value}>{value}</span>)}</section><section><strong>Conflicts</strong>{diff.sampleConflicts.map(value => <span key={value}>{value}</span>)}</section><section><strong>Missing (retained)</strong>{diff.sampleMissing.map(value => <span key={value}>{value}</span>)}</section></div><div className="raw-row-preview">{preview.sampleRows.slice(0, 3).map((row, index) => <pre key={index}>{JSON.stringify(row, null, 2)}</pre>)}</div></details>
        <div className="import-summary"><FileSpreadsheet size={18} /><span>Commit is atomic. Raw rows and dispositions are retained as evidence; human overrides remain effective; missing rows are never deleted.</span></div>
        <footer><Button variant="ghost" onClick={onCancel}>Cancel staging</Button><Button busy={busy} disabled={dirty} onClick={onCommit}><Check size={16} /> Commit exact staged diff</Button></footer>
      </div>
    </div>
  );
}

function BulkEditDrawer({ assetIds, onClose, onSaved, setError }: {
  assetIds: string[];
  onClose: () => void;
  onSaved: () => Promise<void>;
  setError: (message: string | null) => void;
}) {
  const [field, setField] = useState<'style' | 'activity' | 'shotType' | 'timeOfDay' | 'availabilityStatus' | 'verificationStatus' | 'excluded'>('style');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('Bulk catalog curation');
  const [busy, setBusy] = useState(false);
  async function save(): Promise<void> {
    setBusy(true); setError(null);
    try {
      const normalized: unknown = field === 'excluded' ? value === 'true' : value || null;
      await window.videoFactory.catalog.bulkUpdate({ assetIds, patch: { [field]: normalized }, reason });
      await onSaved();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return (
    <div className="drawer-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}><aside className="asset-editor compact-editor"><header><div><span className="field-label">BULK METADATA OVERRIDE</span><h2>{assetIds.length.toLocaleString()} selected assets</h2></div><button className="icon-button" onClick={onClose}><X size={20} /></button></header><div className="asset-editor-form"><label><span>Field</span><select value={field} onChange={event => { setField(event.target.value as typeof field); setValue(''); }}>{['style','activity','shotType','timeOfDay','availabilityStatus','verificationStatus','excluded'].map(option => <option key={option} value={option}>{FIELD_LABELS[option] ?? option}</option>)}</select></label><label><span>Value</span>{field === 'excluded' ? <select value={value} onChange={event => setValue(event.target.value)}><option value="">Choose</option><option value="true">Excluded</option><option value="false">Included</option></select> : field === 'availabilityStatus' ? <select value={value} onChange={event => setValue(event.target.value)}><option value="">Choose</option>{['unknown','available','unavailable'].map(option => <option key={option}>{option}</option>)}</select> : field === 'verificationStatus' ? <select value={value} onChange={event => setValue(event.target.value)}><option value="">Choose</option>{['unverified','metadata','ai_suggested','human_verified','conflict'].map(option => <option key={option}>{option}</option>)}</select> : <input value={value} onChange={event => setValue(event.target.value)} />}</label><label className="full"><span>Audit reason</span><textarea value={reason} onChange={event => setReason(event.target.value)} /></label></div><footer><Button variant="ghost" onClick={onClose}>Cancel</Button><Button busy={busy} disabled={!value || !reason.trim()} onClick={() => void save()}><Check size={16} /> Apply verified override</Button></footer></aside></div>
  );
}

function AssetEditDrawer({ asset, onClose, onSaved, setError }: {
  asset: CatalogAsset;
  onClose: () => void;
  onSaved: () => Promise<void>;
  setError: (message: string | null) => void;
}) {
  const [form, setForm] = useState({
    title: asset.title, description: asset.description ?? '', country: asset.country ?? '', city: asset.city ?? '',
    locationName: asset.locationName ?? '', activity: asset.activity ?? '', shotType: asset.shotType ?? '',
    sceneDescription: asset.sceneDescription ?? '', objects: asset.objects ?? '', timeOfDay: asset.timeOfDay ?? '',
    style: asset.style ?? '', orientation: asset.orientation, locationGranularity: asset.locationGranularity,
    locationConfidence: asset.locationConfidence, verificationStatus: asset.verificationStatus
  });
  const [busy, setBusy] = useState(false);
  const [revisions, setRevisions] = useState<MetadataRevision[]>([]);
  const [assertions, setAssertions] = useState<MetadataAssertion[]>([]);

  async function loadEvidence(): Promise<void> {
    const [nextRevisions, nextAssertions] = await Promise.all([
      window.videoFactory.catalog.revisions(asset.id), window.videoFactory.catalog.metadataAssertions(asset.id)
    ]);
    setRevisions(nextRevisions); setAssertions(nextAssertions);
  }
  useEffect(() => { void loadEvidence().catch(() => { setRevisions([]); setAssertions([]); }); }, [asset.id]);

  async function save(): Promise<void> {
    setBusy(true); setError(null);
    try {
      await window.videoFactory.catalog.updateAsset({ assetId: asset.id, patch: {
        ...form, description: form.description || null, country: form.country || null, city: form.city || null,
        locationName: form.locationName || null, activity: form.activity || null, shotType: form.shotType || null,
        sceneDescription: form.sceneDescription || null, objects: form.objects || null,
        timeOfDay: form.timeOfDay || null, style: form.style || null
      }, reason: 'Library metadata correction' });
      await onSaved();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function review(assertionId: string, decision: 'accept' | 'reject'): Promise<void> {
    setBusy(true); setError(null);
    try { await window.videoFactory.catalog.reviewSuggestion(assertionId, decision); await loadEvidence(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  const visibleAssertions = assertions.filter(assertion => assertion.effective || assertion.layer === 'human' || assertion.layer === 'ai').slice(0, 120);
  return (
    <div className="drawer-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}><aside className="asset-editor evidence-editor"><header><div><span className="field-label">METADATA EVIDENCE & OVERRIDE</span><h2>{asset.title}</h2></div><button className="icon-button" onClick={onClose}><X size={20} /></button></header>
      <div className="asset-editor-form">
        <label className="full"><span>Title</span><input value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} /></label><label className="full"><span>Description</span><textarea value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} /></label>
        <label><span>Country</span><input value={form.country} onChange={event => setForm({ ...form, country: event.target.value })} /></label><label><span>City</span><input value={form.city} onChange={event => setForm({ ...form, city: event.target.value })} /></label><label className="full"><span>Exact location</span><input value={form.locationName} onChange={event => setForm({ ...form, locationName: event.target.value })} /></label>
        <label><span>Activity</span><input value={form.activity} onChange={event => setForm({ ...form, activity: event.target.value })} /></label><label><span>Shot type</span><input value={form.shotType} onChange={event => setForm({ ...form, shotType: event.target.value })} /></label><label className="full"><span>Scene</span><input value={form.sceneDescription} onChange={event => setForm({ ...form, sceneDescription: event.target.value })} /></label><label className="full"><span>Objects</span><input value={form.objects} onChange={event => setForm({ ...form, objects: event.target.value })} /></label>
        <label><span>Time of day</span><input value={form.timeOfDay} onChange={event => setForm({ ...form, timeOfDay: event.target.value })} /></label><label><span>Style</span><input value={form.style} onChange={event => setForm({ ...form, style: event.target.value })} /></label>
        <label><span>Granularity</span><select value={form.locationGranularity} onChange={event => setForm({ ...form, locationGranularity: event.target.value as typeof form.locationGranularity })}>{['country','region','city','neighborhood','landmark','feature','unknown'].map(value => <option key={value}>{value}</option>)}</select></label>
        <label><span>Verification</span><select value={form.verificationStatus} onChange={event => setForm({ ...form, verificationStatus: event.target.value as typeof form.verificationStatus })}>{['unverified','metadata','ai_suggested','human_verified','conflict'].map(value => <option key={value}>{value}</option>)}</select></label>
        <label className="full"><span>Location confidence: {Math.round(form.locationConfidence * 100)}%</span><input type="range" min="0" max="1" step="0.01" value={form.locationConfidence} onChange={event => setForm({ ...form, locationConfidence: Number(event.target.value) })} /></label>
      </div>
      <div className="metadata-layer-list"><span className="field-label">EFFECTIVE & REVIEWABLE ASSERTIONS</span>{visibleAssertions.map(assertion => <div key={assertion.id} className={`metadata-layer-row layer-${assertion.layer}`}><span>{assertion.layer}</span><div><strong>{assertion.fieldName}: {displayValue(assertion.value)}</strong><small>{assertion.source} · {assertion.verificationState}{assertion.confidence === null ? '' : ` · ${Math.round(assertion.confidence * 100)}%`}{assertion.effective ? ' · effective' : ''}</small></div>{assertion.layer === 'ai' && assertion.verificationState === 'proposed' ? <div><button onClick={() => void review(assertion.id, 'reject')}>Reject</button><button onClick={() => void review(assertion.id, 'accept')}>Accept</button></div> : null}</div>)}</div>
      {revisions.length ? <div className="revision-list"><span className="field-label">RECENT CHANGES</span>{revisions.slice(0, 12).map(revision => <div key={revision.id} className="revision-row"><div><strong>{revision.fieldName}</strong><span>{revision.reason ?? 'Operator edit'} · {new Date(revision.createdAt).toLocaleString()}</span></div><Button variant="ghost" disabled={Boolean(revision.revertedAt)} onClick={() => void (async () => { setBusy(true); setError(null); try { await window.videoFactory.catalog.revertRevision(revision.id); await onSaved(); } catch (error) { setError(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } })()}>{revision.revertedAt ? 'Reverted' : 'Undo'}</Button></div>)}</div> : null}
      <footer><Button variant="ghost" onClick={onClose}>Cancel</Button><Button busy={busy} onClick={() => void save()}><Check size={16} /> Save verified override</Button></footer>
    </aside></div>
  );
}
