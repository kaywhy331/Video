ALTER TABLE script_versions ADD COLUMN script_type TEXT NOT NULL DEFAULT 'provisional'
  CHECK (script_type IN ('provisional','final'));
ALTER TABLE script_versions ADD COLUMN locked_at TEXT;
UPDATE script_versions SET locked_at = created_at WHERE locked = 1;

ALTER TABLE project_scenes ADD COLUMN pronunciation_json TEXT NOT NULL DEFAULT '{}';

ALTER TABLE renders ADD COLUMN scope_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE renders ADD COLUMN base_render_id TEXT REFERENCES renders(id) ON DELETE SET NULL;
ALTER TABLE repair_attempts ADD COLUMN range_start_ordinal INTEGER;
ALTER TABLE repair_attempts ADD COLUMN range_end_ordinal INTEGER;

CREATE TABLE voice_assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  voice_id TEXT NOT NULL,
  settings_json TEXT NOT NULL,
  pronunciation_hash TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  text TEXT NOT NULL,
  audio_path TEXT,
  timing_path TEXT,
  duration_ms INTEGER,
  timing_method TEXT,
  status TEXT NOT NULL CHECK (status IN ('generating','ready','failed','stale')),
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, input_hash)
);

CREATE INDEX idx_voice_assets_project
  ON voice_assets(project_id, status, updated_at DESC);

CREATE TABLE narration_sections (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  script_version_id TEXT NOT NULL REFERENCES script_versions(id) ON DELETE CASCADE,
  voice_asset_id TEXT NOT NULL REFERENCES voice_assets(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL,
  chapter TEXT,
  scene_ids_json TEXT NOT NULL,
  text TEXT NOT NULL,
  pronunciation_json TEXT NOT NULL DEFAULT '{}',
  duration_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ready','stale','failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(script_version_id, ordinal)
);

CREATE INDEX idx_narration_sections_project
  ON narration_sections(project_id, script_version_id, ordinal);

CREATE TABLE narration_words (
  id TEXT PRIMARY KEY,
  section_id TEXT NOT NULL REFERENCES narration_sections(id) ON DELETE CASCADE,
  scene_id TEXT NOT NULL REFERENCES project_scenes(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  word TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  timing_method TEXT NOT NULL,
  CHECK (start_ms >= 0),
  CHECK (end_ms > start_ms),
  UNIQUE(section_id, ordinal)
);

CREATE INDEX idx_narration_words_scene
  ON narration_words(scene_id, start_ms, ordinal);

CREATE TABLE render_fragments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scene_id TEXT NOT NULL REFERENCES project_scenes(id) ON DELETE CASCADE,
  profile TEXT NOT NULL,
  input_hash TEXT NOT NULL UNIQUE,
  output_path TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  source_artifact_version INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('ready','stale','failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_render_fragments_scene
  ON render_fragments(project_id, scene_id, profile, status, updated_at DESC);
