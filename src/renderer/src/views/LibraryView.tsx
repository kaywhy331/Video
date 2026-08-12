import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  Database,
  FileSpreadsheet,
  Filter,
  Image,
  MapPin,
  Pencil,
  Search,
  Upload,
  X
} from 'lucide-react';
import type {
  CatalogAsset,
  CatalogImportPreview,
  CatalogSearchResult,
  CatalogStats,
  CoverageCluster,
  MetadataRevision
} from '@shared/types';
import { Button, EmptyState, MetricCard, Panel, StatusPill } from '../components/ui';

const EMPTY_RESULT: CatalogSearchResult = {
  rows: [],
  total: 0,
  page: 1,
  pageSize: 50,
  facets: { countries: [], cities: [], locations: [], authors: [] }
};

const FIELD_LABELS: Record<string, string> = {
  sourceRowId: 'Source row ID',
  canonicalPageUrl: 'Asset URL',
  authorName: 'Author',
  rawAttributes: 'Attributes',
  rawTags: 'Tags',
  title: 'Title',
  description: 'Description',
  rawExtractedData: 'Extracted data',
  country: 'Country',
  city: 'City',
  locationName: 'Exact location',
  activity: 'Activity',
  shotType: 'Shot type',
  sceneDescription: 'Scene',
  objects: 'Objects',
  timeOfDay: 'Time of day',
  style: 'Style',
  declaredDuration: 'Duration',
  thumbnailUrl: 'Thumbnail',
  declaredResolution: 'Resolution',
  declaredFileSize: 'File size',
  declaredFrameRate: 'Frame rate',
  declaredAlpha: 'Alpha channel',
  declaredLooped: 'Looped',
  declaredCodec: 'Codec',
  orientation: 'Orientation'
};

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
  const [query, setQuery] = useState('');
  const [country, setCountry] = useState('');
  const [city, setCity] = useState('');
  const [downloaded, setDownloaded] = useState<'all' | 'yes' | 'no'>('all');
  const [page, setPage] = useState(1);
  const [preview, setPreview] = useState<CatalogImportPreview | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [selected, setSelected] = useState<CatalogAsset | null>(null);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});

  async function load(): Promise<void> {
    const [catalog, clusters, catalogStats] = await Promise.all([
      window.videoFactory.catalog.search({
        query: query || undefined,
        country: country || undefined,
        city: city || undefined,
        downloaded: downloaded === 'all' ? undefined : downloaded === 'yes',
        page,
        pageSize: 50,
        sortBy: 'updated',
        sortDirection: 'desc'
      }),
      window.videoFactory.catalog.coverage(40),
      window.videoFactory.catalog.stats()
    ]);
    setResult(catalog);
    setCoverage(clusters);
    setStats(catalogStats);
  }

  useEffect(() => {
    const timer = setTimeout(() => void load().catch(error => setError(error instanceof Error ? error.message : String(error))), 220);
    return () => clearTimeout(timer);
  }, [query, country, city, downloaded, page]);

  async function chooseImport(): Promise<void> {
    setImportBusy(true);
    setError(null);
    try {
      const next = await window.videoFactory.catalog.chooseImport();
      if (next) {
        setPreview(next);
        setMapping(next.mapping);
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setImportBusy(false);
    }
  }

  async function commitImport(): Promise<void> {
    if (!preview) return;
    setImportBusy(true);
    setError(null);
    try {
      await window.videoFactory.catalog.commitImport({
        filePath: preview.filePath,
        sheetName: preview.selectedSheet,
        mapping
      });
      setPreview(null);
      await load();
      await onRefresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setImportBusy(false);
    }
  }

  const maxPage = Math.max(1, Math.ceil(result.total / result.pageSize));
  const topCoverage = useMemo(() => coverage.slice(0, 8), [coverage]);

  return (
    <div className="view-stack">
      <div className="page-heading">
        <div>
          <div className="eyebrow"><Database size={14} /> FOOTAGE INTELLIGENCE</div>
          <h1>Your spreadsheet is the planning brain—not the media vault.</h1>
          <p>Search all metadata instantly, correct uncertain records, and see which destinations have enough visual coverage to support a video.</p>
        </div>
        <Button busy={importBusy} onClick={() => void chooseImport()}><Upload size={16} /> Import spreadsheet</Button>
      </div>

      <div className="metric-grid">
        <MetricCard label="Assets" value={stats.totalAssets.toLocaleString()} detail={`${stats.imports} catalog import(s)`} />
        <MetricCard label="Downloaded" value={stats.downloadedAssets.toLocaleString()} detail="Originals stored once by hash" />
        <MetricCard label="Verified" value={stats.verifiedAssets.toLocaleString()} detail="Human-confirmed location metadata" />
        <MetricCard label="Coverage" value={stats.locations.toLocaleString()} detail={`${stats.cities} cities · ${stats.countries} countries`} />
      </div>

      <Panel title="Strongest destination clusters" subtitle="Coverage is scored before keyword opportunity">
        {topCoverage.length ? (
          <div className="coverage-scroll">
            {topCoverage.map(cluster => (
              <button
                key={cluster.key}
                className="coverage-card"
                onClick={() => {
                  setCountry(cluster.country ?? '');
                  setCity(cluster.city ?? '');
                  setPage(1);
                }}
              >
                <div className="coverage-score">{Math.round(cluster.coverageScore)}</div>
                <strong>{cluster.locationName ?? cluster.city ?? cluster.country}</strong>
                <span>{cluster.assetCount} assets · {cluster.uniqueShotTypes} shot types</span>
                <div className="coverage-bars">
                  <i style={{ width: `${Math.min(100, cluster.assetCount)}%` }} />
                </div>
              </button>
            ))}
          </div>
        ) : <div className="muted-row">Coverage appears after a catalog import.</div>}
      </Panel>

      <Panel
        title="Catalog"
        subtitle={`${result.total.toLocaleString()} matching assets`}
        action={
          <div className="table-pagination">
            <button disabled={page <= 1} onClick={() => setPage(value => value - 1)}>Previous</button>
            <span>{page} / {maxPage}</span>
            <button disabled={page >= maxPage} onClick={() => setPage(value => value + 1)}>Next</button>
          </div>
        }
      >
        <div className="catalog-toolbar">
          <label className="search-input">
            <Search size={16} />
            <input value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} placeholder="Search title, location, activity, objects, style…" />
          </label>
          <label>
            <Filter size={14} />
            <select value={country} onChange={event => { setCountry(event.target.value); setCity(''); setPage(1); }}>
              <option value="">All countries</option>
              {result.facets.countries.map(item => <option key={item.value} value={item.value}>{item.value} ({item.count})</option>)}
            </select>
          </label>
          <label>
            <MapPin size={14} />
            <select value={city} onChange={event => { setCity(event.target.value); setPage(1); }}>
              <option value="">All cities</option>
              {result.facets.cities.map(item => <option key={item.value} value={item.value}>{item.value} ({item.count})</option>)}
            </select>
          </label>
          <select value={downloaded} onChange={event => { setDownloaded(event.target.value as typeof downloaded); setPage(1); }}>
            <option value="all">All file states</option>
            <option value="yes">Downloaded locally</option>
            <option value="no">Metadata only</option>
          </select>
        </div>

        {result.rows.length ? (
          <div className="catalog-table-wrap">
            <table className="catalog-table">
              <thead>
                <tr>
                  <th>Preview</th>
                  <th>Asset</th>
                  <th>Geography</th>
                  <th>Visual metadata</th>
                  <th>Technical</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {result.rows.map(asset => (
                  <tr key={asset.id}>
                    <td>
                      <div className="catalog-thumb">
                        {asset.thumbnailUrl ? <img src={asset.thumbnailUrl} alt="" /> : <Image size={18} />}
                      </div>
                    </td>
                    <td>
                      <strong>{asset.title}</strong>
                      <span>{asset.authorName ?? 'Unknown author'}</span>
                    </td>
                    <td>
                      <strong>{asset.locationName ?? asset.city ?? asset.country ?? 'Unspecified'}</strong>
                      <span>{[asset.city, asset.country].filter(Boolean).join(', ')}</span>
                    </td>
                    <td>
                      <strong>{asset.shotType ?? asset.activity ?? '—'}</strong>
                      <span>{asset.objects ?? asset.sceneDescription ?? 'No object metadata'}</span>
                    </td>
                    <td>
                      <strong>{asset.declaredWidth && asset.declaredHeight ? `${asset.declaredWidth}×${asset.declaredHeight}` : 'Unknown'}</strong>
                      <span>{asset.declaredFrameRate ? `${asset.declaredFrameRate.toFixed(2)} fps` : ''} {asset.orientation}</span>
                    </td>
                    <td>
                      <StatusPill value={asset.localFileId ? 'downloaded' : 'metadata only'} />
                      <small>{asset.verificationStatus.replaceAll('_', ' ')}</small>
                    </td>
                    <td><button className="icon-button" onClick={() => setSelected(asset)}><Pencil size={15} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No assets match" body="Adjust the search or import the current spreadsheet." />
        )}
      </Panel>

      {preview ? (
        <div className="modal-backdrop">
          <div className="import-modal">
            <header>
              <div>
                <span className="field-label">IMPORT PREVIEW</span>
                <h2>{preview.filePath.split(/[\\/]/).pop()}</h2>
                <p>{preview.rowCount.toLocaleString()} rows · worksheet {preview.selectedSheet}</p>
              </div>
              <button className="icon-button" onClick={() => setPreview(null)}><X size={20} /></button>
            </header>
            <div className="mapping-grid">
              {Object.entries(mapping).map(([field, column]) => (
                <label key={field}>
                  <span>{FIELD_LABELS[field] ?? field}</span>
                  <select
                    value={column ?? ''}
                    onChange={event => setMapping(current => ({
                      ...current,
                      [field]: event.target.value || null
                    }))}
                  >
                    <option value="">Not mapped</option>
                    {preview.columns.map(option => <option key={option} value={option}>{option}</option>)}
                  </select>
                </label>
              ))}
            </div>
            <div className="import-summary">
              <FileSpreadsheet size={18} />
              <span>Raw rows are preserved. Human corrections survive future imports. “Not Found” values become structured nulls.</span>
            </div>
            <footer>
              <Button variant="ghost" onClick={() => setPreview(null)}>Cancel</Button>
              <Button busy={importBusy} onClick={() => void commitImport()}><Check size={16} /> Import catalog</Button>
            </footer>
          </div>
        </div>
      ) : null}

      {selected ? (
        <AssetEditDrawer
          asset={selected}
          onClose={() => setSelected(null)}
          onSaved={async () => {
            setSelected(null);
            await load();
            await onRefresh();
          }}
          setError={setError}
        />
      ) : null}
    </div>
  );
}

function AssetEditDrawer({
  asset,
  onClose,
  onSaved,
  setError
}: {
  asset: CatalogAsset;
  onClose: () => void;
  onSaved: () => Promise<void>;
  setError: (message: string | null) => void;
}) {
  const [form, setForm] = useState({
    title: asset.title,
    description: asset.description ?? '',
    country: asset.country ?? '',
    city: asset.city ?? '',
    locationName: asset.locationName ?? '',
    activity: asset.activity ?? '',
    shotType: asset.shotType ?? '',
    sceneDescription: asset.sceneDescription ?? '',
    objects: asset.objects ?? '',
    timeOfDay: asset.timeOfDay ?? '',
    style: asset.style ?? '',
    orientation: asset.orientation,
    locationGranularity: asset.locationGranularity,
    locationConfidence: asset.locationConfidence,
    verificationStatus: asset.verificationStatus
  });
  const [busy, setBusy] = useState(false);
  const [revisions, setRevisions] = useState<MetadataRevision[]>([]);

  useEffect(() => {
    void window.videoFactory.catalog.revisions(asset.id).then(setRevisions).catch(() => setRevisions([]));
  }, [asset.id]);

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await window.videoFactory.catalog.updateAsset({
        assetId: asset.id,
        patch: {
          ...form,
          description: form.description || null,
          country: form.country || null,
          city: form.city || null,
          locationName: form.locationName || null,
          activity: form.activity || null,
          shotType: form.shotType || null,
          sceneDescription: form.sceneDescription || null,
          objects: form.objects || null,
          timeOfDay: form.timeOfDay || null,
          style: form.style || null
        },
        reason: 'Library metadata correction'
      });
      await onSaved();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="drawer-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}>
      <aside className="asset-editor">
        <header>
          <div><span className="field-label">METADATA OVERRIDE</span><h2>{asset.title}</h2></div>
          <button className="icon-button" onClick={onClose}><X size={20} /></button>
        </header>
        <div className="asset-editor-form">
          <label className="full"><span>Title</span><input value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} /></label>
          <label className="full"><span>Description</span><textarea value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} /></label>
          <label><span>Country</span><input value={form.country} onChange={event => setForm({ ...form, country: event.target.value })} /></label>
          <label><span>City</span><input value={form.city} onChange={event => setForm({ ...form, city: event.target.value })} /></label>
          <label className="full"><span>Exact location</span><input value={form.locationName} onChange={event => setForm({ ...form, locationName: event.target.value })} /></label>
          <label><span>Activity</span><input value={form.activity} onChange={event => setForm({ ...form, activity: event.target.value })} /></label>
          <label><span>Shot type</span><input value={form.shotType} onChange={event => setForm({ ...form, shotType: event.target.value })} /></label>
          <label className="full"><span>Scene</span><input value={form.sceneDescription} onChange={event => setForm({ ...form, sceneDescription: event.target.value })} /></label>
          <label className="full"><span>Objects</span><input value={form.objects} onChange={event => setForm({ ...form, objects: event.target.value })} /></label>
          <label><span>Time of day</span><input value={form.timeOfDay} onChange={event => setForm({ ...form, timeOfDay: event.target.value })} /></label>
          <label><span>Style</span><input value={form.style} onChange={event => setForm({ ...form, style: event.target.value })} /></label>
          <label>
            <span>Granularity</span>
            <select value={form.locationGranularity} onChange={event => setForm({ ...form, locationGranularity: event.target.value as typeof form.locationGranularity })}>
              {['country','region','city','neighborhood','landmark','feature','unknown'].map(value => <option key={value}>{value}</option>)}
            </select>
          </label>
          <label>
            <span>Verification</span>
            <select value={form.verificationStatus} onChange={event => setForm({ ...form, verificationStatus: event.target.value as typeof form.verificationStatus })}>
              {['unverified','metadata','ai_suggested','human_verified','conflict'].map(value => <option key={value}>{value}</option>)}
            </select>
          </label>
          <label className="full">
            <span>Location confidence: {Math.round(form.locationConfidence * 100)}%</span>
            <input type="range" min="0" max="1" step="0.01" value={form.locationConfidence} onChange={event => setForm({ ...form, locationConfidence: Number(event.target.value) })} />
          </label>
        </div>
        {revisions.length ? (
          <div className="revision-list">
            <span className="field-label">RECENT CHANGES</span>
            {revisions.slice(0, 8).map(revision => (
              <div key={revision.id} className="revision-row">
                <div>
                  <strong>{revision.fieldName}</strong>
                  <span>{revision.reason ?? 'Operator edit'} · {new Date(revision.createdAt).toLocaleString()}</span>
                </div>
                <Button
                  variant="ghost"
                  disabled={Boolean(revision.revertedAt)}
                  onClick={() => void (async () => {
                    setBusy(true);
                    setError(null);
                    try {
                      await window.videoFactory.catalog.revertRevision(revision.id);
                      await onSaved();
                    } catch (error) {
                      setError(error instanceof Error ? error.message : String(error));
                    } finally {
                      setBusy(false);
                    }
                  })()}
                >
                  {revision.revertedAt ? 'Reverted' : 'Undo'}
                </Button>
              </div>
            ))}
          </div>
        ) : null}
        <footer>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button busy={busy} onClick={() => void save()}><Check size={16} /> Save verified override</Button>
        </footer>
      </aside>
    </div>
  );
}
