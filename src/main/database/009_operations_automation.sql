CREATE TABLE settings_profile_operations (
  id TEXT PRIMARY KEY,
  operation TEXT NOT NULL CHECK(operation IN ('export','import')),
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  applied_keys_json TEXT NOT NULL DEFAULT '[]',
  warnings_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE INDEX idx_settings_profile_operations_created
  ON settings_profile_operations(created_at DESC);

CREATE TABLE update_checks (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL CHECK(channel IN ('stable','prerelease')),
  current_version TEXT NOT NULL,
  latest_version TEXT,
  release_url TEXT,
  available INTEGER NOT NULL DEFAULT 0 CHECK(available IN (0,1)),
  status TEXT NOT NULL CHECK(status IN ('current','available','unpublished','error')),
  error TEXT,
  checked_at TEXT NOT NULL
);

CREATE INDEX idx_update_checks_created ON update_checks(checked_at DESC);

CREATE TABLE catalog_validation_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  source_pattern TEXT NOT NULL DEFAULT '*',
  required_fields_json TEXT NOT NULL DEFAULT '[]',
  identity_fields_json TEXT NOT NULL DEFAULT '["canonicalPageUrl","sourceRowId"]',
  minimum_rows INTEGER NOT NULL DEFAULT 1 CHECK(minimum_rows >= 0),
  maximum_invalid_ratio REAL NOT NULL DEFAULT 0.05 CHECK(maximum_invalid_ratio BETWEEN 0 AND 1),
  built_in INTEGER NOT NULL DEFAULT 0 CHECK(built_in IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO catalog_validation_templates(
  id, name, description, source_pattern, required_fields_json,
  identity_fields_json, minimum_rows, maximum_invalid_ratio, built_in,
  created_at, updated_at
) VALUES
  ('envato-default', 'Envato catalog', 'Requires a title plus a durable URL or source-row identity.', '*',
    '["title"]', '["canonicalPageUrl","sourceRowId"]', 1, 0.05, 1, datetime('now'), datetime('now')),
  ('strict-grounding', 'Strict geographic grounding', 'Requires country metadata for location-led catalogs.', '*',
    '["title","country"]', '["canonicalPageUrl","sourceRowId"]', 1, 0.01, 1, datetime('now'), datetime('now')),
  ('technical-library', 'Technical media library', 'Requires declared resolution for technical qualification imports.', '*',
    '["title","declaredResolution"]', '["canonicalPageUrl","sourceRowId"]', 1, 0.02, 1, datetime('now'), datetime('now'));

CREATE TABLE catalog_refresh_runs (
  id TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  source_sha256 TEXT,
  template_id TEXT REFERENCES catalog_validation_templates(id) ON DELETE SET NULL,
  preview_id TEXT REFERENCES catalog_import_previews(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK(status IN ('staged','up_to_date','blocked','failed')),
  diff_json TEXT NOT NULL DEFAULT '{}',
  validation_json TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_catalog_refresh_runs_source
  ON catalog_refresh_runs(source_path, created_at DESC);
