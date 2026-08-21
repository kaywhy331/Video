CREATE TABLE music_tracks (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL UNIQUE,
  original_path TEXT NOT NULL,
  original_file_name TEXT NOT NULL,
  title TEXT NOT NULL,
  provider TEXT NOT NULL,
  license_type TEXT NOT NULL,
  license_reference TEXT NOT NULL,
  license_document_path TEXT,
  license_verified_at TEXT NOT NULL,
  mood_json TEXT NOT NULL DEFAULT '[]',
  tempo_bpm REAL,
  duration_ms INTEGER NOT NULL CHECK(duration_ms > 0),
  loopable INTEGER NOT NULL DEFAULT 1 CHECK(loopable IN (0,1)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  raw_probe_json TEXT NOT NULL DEFAULT '{}',
  imported_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_music_tracks_enabled ON music_tracks(enabled, imported_at DESC);

CREATE TABLE project_music_selections (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  music_track_id TEXT NOT NULL REFERENCES music_tracks(id) ON DELETE RESTRICT,
  selected_by TEXT NOT NULL CHECK(selected_by IN ('automatic','human')),
  target_gain_db REAL NOT NULL DEFAULT -24,
  ducking_db REAL NOT NULL DEFAULT -12,
  fade_in_ms INTEGER NOT NULL DEFAULT 750 CHECK(fade_in_ms >= 250),
  fade_out_ms INTEGER NOT NULL DEFAULT 1000 CHECK(fade_out_ms >= 250),
  license_snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_project_music_track ON project_music_selections(music_track_id, project_id);

CREATE TABLE storage_cleanup_runs (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL CHECK(trigger IN ('manual','disk_pressure','startup')),
  status TEXT NOT NULL CHECK(status IN ('planned','not_needed','complete','partial','failed')),
  free_bytes_before INTEGER,
  free_bytes_after INTEGER,
  target_free_bytes INTEGER NOT NULL,
  candidate_bytes INTEGER NOT NULL DEFAULT 0,
  removed_bytes INTEGER NOT NULL DEFAULT 0,
  removed_count INTEGER NOT NULL DEFAULT 0,
  skipped_json TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE storage_cleanup_items (
  id TEXT PRIMARY KEY,
  cleanup_run_id TEXT NOT NULL REFERENCES storage_cleanup_runs(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK(category IN ('proxy','contact_sheet','segment_preview','render_fragment')),
  entity_id TEXT NOT NULL,
  path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  removed INTEGER NOT NULL DEFAULT 0 CHECK(removed IN (0,1)),
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_storage_cleanup_items_run ON storage_cleanup_items(cleanup_run_id, removed);
