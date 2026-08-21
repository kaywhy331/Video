ALTER TABLE catalog_imports ADD COLUMN missing_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE catalog_imports ADD COLUMN preview_id TEXT;
ALTER TABLE catalog_imports ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'
  CHECK(status IN ('running','completed','failed','cancelled'));
ALTER TABLE catalog_imports ADD COLUMN error TEXT;

CREATE TABLE catalog_import_previews (
  id TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  source_name TEXT NOT NULL,
  sheet_name TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  column_mapping_json TEXT NOT NULL,
  diff_json TEXT NOT NULL,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK(status IN ('staged','committed','cancelled','superseded')),
  committed_import_id TEXT REFERENCES catalog_imports(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_catalog_import_previews_source
  ON catalog_import_previews(source_sha256, sheet_name, status, created_at DESC);

CREATE TABLE catalog_import_rows (
  id TEXT PRIMARY KEY,
  preview_id TEXT REFERENCES catalog_import_previews(id) ON DELETE SET NULL,
  import_id TEXT REFERENCES catalog_imports(id) ON DELETE CASCADE,
  row_index INTEGER NOT NULL,
  stable_key TEXT,
  raw_row_json TEXT NOT NULL,
  normalized_json TEXT,
  disposition TEXT NOT NULL CHECK(
    disposition IN ('inserted','changed','conflict','missing','unchanged','invalid','duplicate')
  ),
  asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_catalog_import_rows_import
  ON catalog_import_rows(import_id, row_index);
CREATE INDEX idx_catalog_import_rows_stable
  ON catalog_import_rows(stable_key, disposition);

CREATE TABLE asset_metadata_assertions (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  field_name TEXT NOT NULL,
  layer TEXT NOT NULL CHECK(layer IN ('raw','normalized','ai','human')),
  value_json TEXT,
  source TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  confidence REAL CHECK(confidence IS NULL OR confidence BETWEEN 0 AND 1),
  verification_state TEXT NOT NULL CHECK(
    verification_state IN ('proposed','accepted','rejected','verified','superseded')
  ),
  actor TEXT,
  evidence_ref TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  is_effective INTEGER NOT NULL DEFAULT 0 CHECK(is_effective IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  reviewed_at TEXT
);

CREATE INDEX idx_metadata_assertions_asset
  ON asset_metadata_assertions(asset_id, field_name, layer, verification_state, updated_at DESC);
CREATE INDEX idx_metadata_assertions_review
  ON asset_metadata_assertions(layer, verification_state, created_at);

CREATE TABLE place_operations (
  id TEXT PRIMARY KEY,
  operation TEXT NOT NULL CHECK(operation IN ('merge','split','update')),
  source_place_ids_json TEXT NOT NULL DEFAULT '[]',
  target_place_id TEXT,
  affected_asset_ids_json TEXT NOT NULL DEFAULT '[]',
  before_json TEXT NOT NULL DEFAULT '{}',
  after_json TEXT NOT NULL DEFAULT '{}',
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_place_operations_target
  ON place_operations(target_place_id, created_at DESC);

CREATE TABLE diagnostic_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('pass','warning','fail')),
  report_json TEXT NOT NULL,
  app_version TEXT NOT NULL,
  platform TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_diagnostic_runs_created ON diagnostic_runs(created_at DESC);

CREATE TABLE catalog_exports (
  id TEXT PRIMARY KEY,
  output_path TEXT NOT NULL,
  filter_json TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);
