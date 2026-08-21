CREATE TABLE autopilot_scheduler_state (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  state TEXT NOT NULL DEFAULT 'paused' CHECK(state IN ('running','paused','blocked')),
  reason_code TEXT,
  reason TEXT,
  next_run_at TEXT,
  last_run_at TEXT,
  last_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  evaluated_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO autopilot_scheduler_state(
  id, enabled, state, reason_code, reason, next_run_at, last_run_at,
  last_project_id, evaluated_at, updated_at
) VALUES(1, 0, 'paused', 'operator_disabled', 'Automatic project creation is disabled.', NULL, NULL, NULL, datetime('now'), datetime('now'));

CREATE TABLE scheduler_runs (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL CHECK(trigger IN ('timer','manual','settings','startup')),
  outcome TEXT NOT NULL CHECK(outcome IN ('created','not_due','paused','blocked','failed')),
  reason_code TEXT,
  reason TEXT,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX idx_scheduler_runs_created ON scheduler_runs(created_at DESC);

ALTER TABLE analytics_snapshots ADD COLUMN captured_at TEXT;
ALTER TABLE analytics_snapshots ADD COLUMN source TEXT NOT NULL DEFAULT 'youtube_api'
  CHECK(source IN ('youtube_api','manual_import'));
ALTER TABLE analytics_snapshots ADD COLUMN source_hash TEXT;

CREATE TABLE retention_mappings (
  id TEXT PRIMARY KEY,
  analytics_snapshot_id TEXT NOT NULL REFERENCES analytics_snapshots(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  position_ms INTEGER NOT NULL CHECK(position_ms >= 0),
  elapsed_ratio REAL NOT NULL CHECK(elapsed_ratio BETWEEN 0 AND 1),
  audience_watch_ratio REAL CHECK(audience_watch_ratio IS NULL OR audience_watch_ratio >= 0),
  relative_retention REAL,
  scene_id TEXT REFERENCES project_scenes(id) ON DELETE SET NULL,
  scene_ordinal INTEGER,
  chapter TEXT,
  visual_treatment TEXT,
  shot_length_ms INTEGER,
  source_kind TEXT,
  location_name TEXT,
  voice_words_per_minute REAL,
  mapping_evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(analytics_snapshot_id, position_ms)
);

CREATE INDEX idx_retention_mappings_project
  ON retention_mappings(project_id, scene_ordinal, position_ms);

CREATE TABLE learning_recommendations (
  id TEXT PRIMARY KEY,
  metric_key TEXT NOT NULL,
  scope_json TEXT NOT NULL DEFAULT '{}',
  before_value_json TEXT NOT NULL,
  proposed_value_json TEXT NOT NULL,
  current_value_json TEXT NOT NULL,
  rationale TEXT NOT NULL,
  evidence_snapshot_ids_json TEXT NOT NULL DEFAULT '[]',
  evidence_video_count INTEGER NOT NULL DEFAULT 0,
  evidence_total_views INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('proposed','applied','rejected','rolled_back')),
  applied_at TEXT,
  rolled_back_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_learning_recommendations_status
  ON learning_recommendations(status, created_at DESC);
