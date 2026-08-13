CREATE TABLE project_export_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  export_path TEXT NOT NULL,
  options_json TEXT NOT NULL DEFAULT '{}',
  manifest_path TEXT,
  manifest_sha256 TEXT,
  artifact_count INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  missing_files_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK(status IN ('running','complete','partial','failed')),
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX idx_project_export_runs_project
  ON project_export_runs(project_id, created_at DESC);

CREATE TABLE derivative_rebuild_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  checked_originals INTEGER NOT NULL DEFAULT 0,
  rebuilt_proxies INTEGER NOT NULL DEFAULT 0,
  rebuilt_contact_sheets INTEGER NOT NULL DEFAULT 0,
  rebuilt_voice_timings INTEGER NOT NULL DEFAULT 0,
  rebuilt_editing_layers INTEGER NOT NULL DEFAULT 0,
  rebuilt_caption_files INTEGER NOT NULL DEFAULT 0,
  stale_render_fragments INTEGER NOT NULL DEFAULT 0,
  missing_originals_json TEXT NOT NULL DEFAULT '[]',
  missing_voice_json TEXT NOT NULL DEFAULT '[]',
  failures_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK(status IN ('running','complete','partial','failed')),
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX idx_derivative_rebuild_runs_project
  ON derivative_rebuild_runs(project_id, created_at DESC);
