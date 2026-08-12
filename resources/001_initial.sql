PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS catalog_imports (
  id TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  source_name TEXT NOT NULL,
  sheet_name TEXT,
  source_sha256 TEXT,
  row_count INTEGER NOT NULL DEFAULT 0,
  inserted_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  unchanged_count INTEGER NOT NULL DEFAULT 0,
  conflict_count INTEGER NOT NULL DEFAULT 0,
  invalid_count INTEGER NOT NULL DEFAULT 0,
  column_mapping_json TEXT NOT NULL,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  stable_key TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL DEFAULT 'envato',
  provider_asset_id TEXT,
  source_row_id TEXT,
  canonical_page_url TEXT,
  author_name TEXT,
  title TEXT NOT NULL,
  description TEXT,
  raw_attributes TEXT,
  raw_tags TEXT,
  raw_extracted_data TEXT,
  country TEXT,
  city TEXT,
  location_name TEXT,
  activity TEXT,
  shot_type TEXT,
  scene_description TEXT,
  objects TEXT,
  time_of_day TEXT,
  style TEXT,
  declared_duration_ms INTEGER,
  thumbnail_url TEXT,
  declared_width INTEGER,
  declared_height INTEGER,
  declared_file_size_bytes INTEGER,
  declared_frame_rate REAL,
  declared_alpha INTEGER,
  declared_looped INTEGER,
  declared_codec TEXT,
  orientation TEXT NOT NULL DEFAULT 'unknown',
  location_granularity TEXT NOT NULL DEFAULT 'unknown',
  location_confidence REAL NOT NULL DEFAULT 0.25,
  verification_status TEXT NOT NULL DEFAULT 'unverified',
  availability_status TEXT NOT NULL DEFAULT 'unknown',
  local_file_id TEXT,
  excluded INTEGER NOT NULL DEFAULT 0,
  raw_row_json TEXT NOT NULL,
  import_id TEXT,
  imported_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  human_override_json TEXT,
  FOREIGN KEY(import_id) REFERENCES catalog_imports(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_assets_country ON assets(country);
CREATE INDEX IF NOT EXISTS idx_assets_city ON assets(city);
CREATE INDEX IF NOT EXISTS idx_assets_location ON assets(location_name);
CREATE INDEX IF NOT EXISTS idx_assets_author ON assets(author_name);
CREATE INDEX IF NOT EXISTS idx_assets_orientation ON assets(orientation);
CREATE INDEX IF NOT EXISTS idx_assets_local_file ON assets(local_file_id);
CREATE INDEX IF NOT EXISTS idx_assets_updated ON assets(updated_at);

CREATE VIRTUAL TABLE IF NOT EXISTS assets_fts USING fts5(
  asset_id UNINDEXED,
  title,
  description,
  author_name,
  country,
  city,
  location_name,
  activity,
  shot_type,
  scene_description,
  objects,
  time_of_day,
  style,
  tags,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS assets_ai AFTER INSERT ON assets BEGIN
  INSERT INTO assets_fts(
    asset_id, title, description, author_name, country, city, location_name,
    activity, shot_type, scene_description, objects, time_of_day, style, tags
  ) VALUES (
    new.id, coalesce(new.title,''), coalesce(new.description,''), coalesce(new.author_name,''),
    coalesce(new.country,''), coalesce(new.city,''), coalesce(new.location_name,''),
    coalesce(new.activity,''), coalesce(new.shot_type,''), coalesce(new.scene_description,''),
    coalesce(new.objects,''), coalesce(new.time_of_day,''), coalesce(new.style,''),
    coalesce(new.raw_tags,'')
  );
END;

CREATE TRIGGER IF NOT EXISTS assets_ad AFTER DELETE ON assets BEGIN
  DELETE FROM assets_fts WHERE asset_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS assets_au AFTER UPDATE ON assets BEGIN
  DELETE FROM assets_fts WHERE asset_id = old.id;
  INSERT INTO assets_fts(
    asset_id, title, description, author_name, country, city, location_name,
    activity, shot_type, scene_description, objects, time_of_day, style, tags
  ) VALUES (
    new.id, coalesce(new.title,''), coalesce(new.description,''), coalesce(new.author_name,''),
    coalesce(new.country,''), coalesce(new.city,''), coalesce(new.location_name,''),
    coalesce(new.activity,''), coalesce(new.shot_type,''), coalesce(new.scene_description,''),
    coalesce(new.objects,''), coalesce(new.time_of_day,''), coalesce(new.style,''),
    coalesce(new.raw_tags,'')
  );
END;

CREATE TABLE IF NOT EXISTS asset_metadata_revisions (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  previous_value_json TEXT,
  new_value_json TEXT,
  source TEXT NOT NULL,
  confidence REAL,
  reason TEXT,
  created_at TEXT NOT NULL,
  reverted_at TEXT,
  FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL UNIQUE,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  topic TEXT NOT NULL,
  description TEXT,
  destination_key TEXT,
  destination TEXT,
  state TEXT NOT NULL,
  progress REAL NOT NULL DEFAULT 0,
  envato_project_name TEXT NOT NULL,
  target_duration_ms INTEGER NOT NULL,
  opportunity_score REAL,
  script_version_id TEXT,
  final_render_id TEXT,
  youtube_video_id TEXT,
  locked_by_job_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_projects_state ON projects(state);
CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated_at);

CREATE TABLE IF NOT EXISTS topic_candidates (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  destination_key TEXT NOT NULL,
  title TEXT NOT NULL,
  destination TEXT NOT NULL,
  angle TEXT NOT NULL,
  viewer_promise TEXT NOT NULL,
  keywords_json TEXT NOT NULL,
  coverage_json TEXT NOT NULL,
  demand_score REAL,
  competition_score REAL,
  opportunity_score REAL NOT NULL,
  feasibility TEXT NOT NULL,
  reasons_json TEXT NOT NULL,
  raw_metrics_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS research_sources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  publisher TEXT,
  accessed_at TEXT NOT NULL,
  summary TEXT,
  raw_json TEXT,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS fact_claims (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  text TEXT NOT NULL,
  place_key TEXT,
  category TEXT NOT NULL,
  confidence REAL NOT NULL,
  stability TEXT NOT NULL,
  valid_as_of TEXT,
  source_ids_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS script_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  parent_id TEXT,
  version_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  topic TEXT NOT NULL,
  summary TEXT,
  script_json TEXT NOT NULL,
  generation_reason TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  locked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(parent_id) REFERENCES script_versions(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS project_scenes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  script_version_id TEXT,
  ordinal INTEGER NOT NULL,
  chapter TEXT,
  narration TEXT NOT NULL,
  target_duration_ms INTEGER NOT NULL,
  required_country TEXT,
  required_city TEXT,
  required_location TEXT,
  required_granularity TEXT NOT NULL,
  required_objects_json TEXT NOT NULL,
  required_activities_json TEXT NOT NULL,
  preferred_shots_json TEXT NOT NULL,
  visual_treatment TEXT NOT NULL,
  selected_asset_id TEXT,
  selected_file_id TEXT,
  selected_segment_id TEXT,
  score REAL,
  score_explanation_json TEXT NOT NULL DEFAULT '[]',
  verification_state TEXT NOT NULL,
  start_ms INTEGER,
  end_ms INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, ordinal),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(script_version_id) REFERENCES script_versions(id) ON DELETE SET NULL,
  FOREIGN KEY(selected_asset_id) REFERENCES assets(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_scenes_project ON project_scenes(project_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_scenes_asset ON project_scenes(selected_asset_id);

CREATE TABLE IF NOT EXISTS acquisition_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  role TEXT NOT NULL,
  state TEXT NOT NULL,
  license_state TEXT NOT NULL DEFAULT 'PENDING',
  source_url TEXT NOT NULL,
  required_scene_ordinals_json TEXT NOT NULL,
  match_score REAL NOT NULL,
  reasons_json TEXT NOT NULL,
  active_at TEXT,
  detected_path TEXT,
  mapped_file_id TEXT,
  mapping_confidence REAL,
  mapping_evidence_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, asset_id),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_acq_project_state ON acquisition_items(project_id, state);
CREATE INDEX IF NOT EXISTS idx_acq_active ON acquisition_items(active_at);

CREATE TABLE IF NOT EXISTS project_licenses (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  license_state TEXT NOT NULL,
  envato_project_name TEXT NOT NULL,
  certificate_path TEXT,
  operator_attested_at TEXT,
  verified_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, asset_id),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS asset_files (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  sha256 TEXT NOT NULL UNIQUE,
  original_path TEXT NOT NULL,
  proxy_path TEXT,
  contact_sheet_path TEXT,
  original_file_name TEXT NOT NULL,
  file_size_bytes INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  frame_rate REAL NOT NULL,
  codec TEXT NOT NULL,
  pixel_format TEXT,
  color_space TEXT,
  audio_present INTEGER NOT NULL DEFAULT 0,
  raw_ffprobe_json TEXT NOT NULL,
  pipeline_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_asset_files_asset ON asset_files(asset_id);

CREATE TABLE IF NOT EXISTS media_segments (
  id TEXT PRIMARY KEY,
  asset_file_id TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  quality_score REAL NOT NULL,
  black_frame_risk REAL NOT NULL DEFAULT 0,
  freeze_risk REAL NOT NULL DEFAULT 0,
  effective_width INTEGER NOT NULL,
  effective_height INTEGER NOT NULL,
  eligible_1080p INTEGER NOT NULL,
  eligible_4k INTEGER NOT NULL,
  preview_path TEXT,
  analysis_json TEXT NOT NULL DEFAULT '{}',
  pipeline_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(asset_file_id) REFERENCES asset_files(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_segments_file ON media_segments(asset_file_id);
CREATE INDEX IF NOT EXISTS idx_segments_1080 ON media_segments(eligible_1080p);

CREATE TABLE IF NOT EXISTS render_manifests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  script_version_id TEXT,
  profile TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS renders (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  profile TEXT NOT NULL,
  state TEXT NOT NULL,
  manifest_id TEXT,
  manifest_path TEXT,
  output_path TEXT,
  sha256 TEXT,
  duration_ms INTEGER,
  width INTEGER,
  height INTEGER,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(project_id, kind, profile, sha256),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(manifest_id) REFERENCES render_manifests(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS packaging_candidates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  title TEXT NOT NULL,
  angle TEXT NOT NULL,
  viewer_promise TEXT NOT NULL,
  thumbnail_path TEXT,
  thumbnail_frame_ms INTEGER,
  description TEXT NOT NULL,
  chapters TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  risk_status TEXT NOT NULL,
  selected INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, ordinal),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS qc_results (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  render_id TEXT,
  category TEXT NOT NULL,
  code TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(render_id) REFERENCES renders(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_qc_project ON qc_results(project_id, status, severity);

CREATE TABLE IF NOT EXISTS publication_records (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  channel_id TEXT,
  video_id TEXT,
  privacy_status TEXT NOT NULL,
  upload_session_uri TEXT,
  final_sha256 TEXT NOT NULL,
  processing_status TEXT,
  selected_package_id TEXT,
  caption_id TEXT,
  thumbnail_uploaded INTEGER NOT NULL DEFAULT 0,
  approval_hash TEXT,
  approved_at TEXT,
  scheduled_at TEXT,
  published_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(final_sha256, channel_id),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(selected_package_id) REFERENCES packaging_candidates(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  type TEXT NOT NULL,
  state TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  progress REAL NOT NULL DEFAULT 0,
  phase TEXT,
  input_json TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  output_json TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  available_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_until TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs(state, available_at, priority);
CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id, state);

CREATE TABLE IF NOT EXISTS job_dependencies (
  job_id TEXT NOT NULL,
  depends_on_job_id TEXT NOT NULL,
  PRIMARY KEY(job_id, depends_on_job_id),
  FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  FOREIGN KEY(depends_on_job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS provider_calls (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  job_id TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  operation TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  output_hash TEXT,
  request_id TEXT,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  retry_count INTEGER NOT NULL DEFAULT 0,
  response_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(provider, model, operation, input_hash),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL,
  FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS exceptions (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  severity TEXT NOT NULL,
  stage TEXT NOT NULL,
  code TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  recommended_action TEXT,
  safe_alternatives_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'OPEN',
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution_json TEXT,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_exceptions_status ON exceptions(status, severity);
CREATE INDEX IF NOT EXISTS idx_exceptions_project ON exceptions(project_id, status);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  before_json TEXT,
  after_json TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS analytics_snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  snapshot_day INTEGER NOT NULL,
  metrics_json TEXT NOT NULL,
  retention_json TEXT,
  collected_at TEXT NOT NULL,
  UNIQUE(project_id, snapshot_day),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);
