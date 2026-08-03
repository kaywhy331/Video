-- VideoFactory Desktop
-- Core SQLite schema baseline, version 1.0
-- Application migrations should split this file into numbered, forward-only migrations.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  youtube_channel_id TEXT,
  language_code TEXT NOT NULL DEFAULT 'en',
  country_code TEXT,
  editorial_profile_json TEXT NOT NULL DEFAULT '{}',
  publishing_policy_json TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS source_imports (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN ('xlsx','csv','google_sheets','other')),
  source_name TEXT NOT NULL,
  source_path_or_ref TEXT,
  file_sha256 TEXT,
  mapping_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('staged','applied','failed','cancelled')),
  row_count INTEGER NOT NULL DEFAULT 0,
  inserted_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  conflict_count INTEGER NOT NULL DEFAULT 0,
  report_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  applied_at TEXT
);

CREATE TABLE IF NOT EXISTS authors (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_author_key TEXT,
  name TEXT NOT NULL,
  profile_url TEXT,
  allowed INTEGER NOT NULL DEFAULT 1 CHECK (allowed IN (0,1)),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(provider, provider_author_key)
);

CREATE TABLE IF NOT EXISTS places (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  place_type TEXT NOT NULL CHECK (place_type IN ('country','region','city','neighborhood','landmark','feature')),
  parent_id TEXT REFERENCES places(id) ON DELETE SET NULL,
  country_code TEXT,
  latitude REAL,
  longitude REAL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  provider_refs_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_places_parent ON places(parent_id);
CREATE INDEX IF NOT EXISTS idx_places_normalized_name ON places(normalized_name);
CREATE INDEX IF NOT EXISTS idx_places_type_country ON places(place_type, country_code);

CREATE TABLE IF NOT EXISTS source_assets (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'envato_elements',
  provider_asset_id TEXT,
  canonical_page_url TEXT NOT NULL,
  source_row_id TEXT,
  author_id TEXT REFERENCES authors(id) ON DELETE SET NULL,
  title_raw TEXT,
  title_effective TEXT,
  description_raw TEXT,
  description_effective TEXT,
  raw_attributes TEXT,
  raw_tags TEXT,
  raw_extracted_data TEXT,
  raw_row_json TEXT NOT NULL,
  declared_duration_ms INTEGER,
  declared_width INTEGER,
  declared_height INTEGER,
  declared_file_size_bytes INTEGER,
  declared_frame_rate_num INTEGER,
  declared_frame_rate_den INTEGER,
  declared_codec TEXT,
  declared_alpha INTEGER CHECK (declared_alpha IN (0,1) OR declared_alpha IS NULL),
  declared_looped INTEGER CHECK (declared_looped IN (0,1) OR declared_looped IS NULL),
  orientation TEXT CHECK (orientation IN ('horizontal','vertical','square','unknown') OR orientation IS NULL),
  thumbnail_url TEXT,
  availability_status TEXT NOT NULL DEFAULT 'unknown' CHECK (availability_status IN ('unknown','available','unavailable','possibly_removed','excluded')),
  metadata_quality_score REAL NOT NULL DEFAULT 0 CHECK (metadata_quality_score BETWEEN 0 AND 100),
  excluded INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0,1)),
  first_import_id TEXT REFERENCES source_imports(id) ON DELETE SET NULL,
  last_import_id TEXT REFERENCES source_imports(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(provider, canonical_page_url),
  UNIQUE(provider, provider_asset_id)
);

CREATE INDEX IF NOT EXISTS idx_source_assets_author ON source_assets(author_id);
CREATE INDEX IF NOT EXISTS idx_source_assets_availability ON source_assets(availability_status, excluded);
CREATE INDEX IF NOT EXISTS idx_source_assets_orientation ON source_assets(orientation);

CREATE TABLE IF NOT EXISTS asset_metadata_revisions (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES source_assets(id) ON DELETE CASCADE,
  field_name TEXT NOT NULL,
  raw_value_json TEXT,
  normalized_value_json TEXT,
  ai_value_json TEXT,
  human_value_json TEXT,
  effective_value_json TEXT,
  effective_source TEXT NOT NULL CHECK (effective_source IN ('raw','normalized','ai','human')),
  confidence REAL CHECK (confidence BETWEEN 0 AND 1),
  verification_status TEXT NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified','accepted','verified','rejected','conflict')),
  evidence_json TEXT NOT NULL DEFAULT '{}',
  import_id TEXT REFERENCES source_imports(id) ON DELETE SET NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('import','system','model','human')),
  actor_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_metadata_revisions_asset_field ON asset_metadata_revisions(asset_id, field_name, created_at DESC);

CREATE TABLE IF NOT EXISTS asset_place_assertions (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES source_assets(id) ON DELETE CASCADE,
  place_id TEXT NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  granularity TEXT NOT NULL CHECK (granularity IN ('country','region','city','neighborhood','landmark','feature')),
  evidence_type TEXT NOT NULL CHECK (evidence_type IN ('imported','uploader_metadata','geocoder','vision','human')),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  verification_status TEXT NOT NULL CHECK (verification_status IN ('unverified','accepted','verified','rejected','conflict')),
  evidence_ref TEXT,
  is_effective INTEGER NOT NULL DEFAULT 0 CHECK (is_effective IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_asset_places_asset ON asset_place_assertions(asset_id, is_effective);
CREATE INDEX IF NOT EXISTS idx_asset_places_place ON asset_place_assertions(place_id, verification_status, confidence);

CREATE TABLE IF NOT EXISTS asset_tags (
  asset_id TEXT NOT NULL REFERENCES source_assets(id) ON DELETE CASCADE,
  tag_type TEXT NOT NULL CHECK (tag_type IN ('item_tag','activity','shot','scene','object','time_of_day','style','camera_motion','weather','other')),
  value TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'imported' CHECK (source IN ('imported','normalized','vision','human')),
  confidence REAL CHECK (confidence BETWEEN 0 AND 1),
  verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0,1)),
  PRIMARY KEY (asset_id, tag_type, normalized_value, source)
);

CREATE INDEX IF NOT EXISTS idx_asset_tags_lookup ON asset_tags(tag_type, normalized_value, asset_id);

CREATE VIRTUAL TABLE IF NOT EXISTS asset_search USING fts5(
  asset_id UNINDEXED,
  title,
  description,
  tags,
  country,
  region,
  city,
  location,
  activity,
  shot,
  scene,
  objects,
  time_of_day,
  style,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS asset_files (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL UNIQUE,
  canonical_path TEXT NOT NULL UNIQUE,
  original_filename TEXT,
  file_extension TEXT,
  file_size_bytes INTEGER NOT NULL,
  mapped_asset_id TEXT REFERENCES source_assets(id) ON DELETE SET NULL,
  mapping_confidence REAL CHECK (mapping_confidence BETWEEN 0 AND 1),
  mapping_evidence_json TEXT NOT NULL DEFAULT '{}',
  media_status TEXT NOT NULL DEFAULT 'ingested' CHECK (media_status IN ('ingested','processing','ready','quarantined','missing','corrupt')),
  ffprobe_json TEXT,
  duration_ms INTEGER,
  width INTEGER,
  height INTEGER,
  frame_rate_num INTEGER,
  frame_rate_den INTEGER,
  codec_name TEXT,
  codec_profile TEXT,
  pixel_format TEXT,
  color_space TEXT,
  color_transfer TEXT,
  color_primaries TEXT,
  bit_depth INTEGER,
  has_audio INTEGER CHECK (has_audio IN (0,1) OR has_audio IS NULL),
  audio_sample_rate INTEGER,
  audio_channels INTEGER,
  rotation_degrees INTEGER NOT NULL DEFAULT 0,
  alpha_present INTEGER CHECK (alpha_present IN (0,1) OR alpha_present IS NULL),
  analysis_version TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_asset_files_asset ON asset_files(mapped_asset_id);
CREATE INDEX IF NOT EXISTS idx_asset_files_status ON asset_files(media_status);

CREATE TABLE IF NOT EXISTS media_derivatives (
  id TEXT PRIMARY KEY,
  asset_file_id TEXT NOT NULL REFERENCES asset_files(id) ON DELETE CASCADE,
  derivative_type TEXT NOT NULL CHECK (derivative_type IN ('proxy','keyframe','contact_sheet','hover_preview','audio_extract','normalized_segment','other')),
  path TEXT NOT NULL UNIQUE,
  sha256 TEXT,
  profile_id TEXT,
  input_hash TEXT NOT NULL,
  pipeline_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('building','ready','failed','stale')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_derivatives_file_type ON media_derivatives(asset_file_id, derivative_type, status);

CREATE TABLE IF NOT EXISTS asset_segments (
  id TEXT PRIMARY KEY,
  asset_file_id TEXT NOT NULL REFERENCES asset_files(id) ON DELETE CASCADE,
  start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
  end_ms INTEGER NOT NULL CHECK (end_ms > start_ms),
  duration_ms INTEGER GENERATED ALWAYS AS (end_ms - start_ms) VIRTUAL,
  segment_type TEXT NOT NULL DEFAULT 'candidate' CHECK (segment_type IN ('candidate','shot','selected','rejected')),
  visual_quality_score REAL CHECK (visual_quality_score BETWEEN 0 AND 100),
  stability_score REAL CHECK (stability_score BETWEEN 0 AND 100),
  crop_16_9_score REAL CHECK (crop_16_9_score BETWEEN 0 AND 100),
  effective_width_16_9 INTEGER,
  effective_height_16_9 INTEGER,
  visual_metadata_json TEXT NOT NULL DEFAULT '{}',
  perceptual_hash TEXT,
  duplicate_cluster_id TEXT,
  verification_status TEXT NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified','accepted','verified','rejected','conflict')),
  analysis_version TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(asset_file_id, start_ms, end_ms, analysis_version)
);

CREATE INDEX IF NOT EXISTS idx_segments_file ON asset_segments(asset_file_id, verification_status);
CREATE INDEX IF NOT EXISTS idx_segments_duplicate ON asset_segments(duplicate_cluster_id);

CREATE TABLE IF NOT EXISTS topic_candidates (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  primary_keyword TEXT,
  keyword_set_json TEXT NOT NULL DEFAULT '[]',
  viewer_promise TEXT NOT NULL,
  required_places_json TEXT NOT NULL DEFAULT '[]',
  proposed_outline_json TEXT NOT NULL DEFAULT '{}',
  visual_coverage_score REAL NOT NULL DEFAULT 0,
  demand_score REAL NOT NULL DEFAULT 0,
  competition_score REAL NOT NULL DEFAULT 0,
  location_confidence_score REAL NOT NULL DEFAULT 0,
  channel_fit_score REAL NOT NULL DEFAULT 0,
  production_efficiency_score REAL NOT NULL DEFAULT 0,
  opportunity_score REAL NOT NULL DEFAULT 0,
  feasibility_status TEXT NOT NULL CHECK (feasibility_status IN ('pass','fail','needs_review')),
  rejection_reasons_json TEXT NOT NULL DEFAULT '[]',
  score_features_json TEXT NOT NULL DEFAULT '{}',
  generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_topics_channel_score ON topic_candidates(channel_id, feasibility_status, opportunity_score DESC);

CREATE TABLE IF NOT EXISTS keyword_metrics (
  id TEXT PRIMARY KEY,
  channel_id TEXT REFERENCES channels(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  provider TEXT NOT NULL,
  metric_type TEXT NOT NULL,
  geography TEXT,
  language_code TEXT,
  value_numeric REAL,
  value_json TEXT NOT NULL DEFAULT '{}',
  confidence REAL CHECK (confidence BETWEEN 0 AND 1),
  is_youtube_native INTEGER NOT NULL DEFAULT 0 CHECK (is_youtube_native IN (0,1)),
  collected_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_keyword_metrics_lookup ON keyword_metrics(keyword, provider, geography, language_code, collected_at DESC);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE RESTRICT,
  project_code TEXT NOT NULL UNIQUE,
  title_working TEXT NOT NULL,
  topic_candidate_id TEXT REFERENCES topic_candidates(id) ON DELETE SET NULL,
  mode TEXT NOT NULL CHECK (mode IN ('autopilot','guided','recovery')),
  state TEXT NOT NULL,
  state_reason TEXT,
  target_duration_ms INTEGER,
  target_aspect_ratio TEXT NOT NULL DEFAULT '16:9',
  policy_snapshot_json TEXT NOT NULL,
  active_script_version_id TEXT,
  active_render_manifest_id TEXT,
  final_render_id TEXT,
  youtube_publication_id TEXT,
  project_lock_owner TEXT,
  project_lock_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_projects_state ON projects(state, updated_at);
CREATE INDEX IF NOT EXISTS idx_projects_channel ON projects(channel_id, created_at DESC);

CREATE TABLE IF NOT EXISTS research_sources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT,
  publisher TEXT,
  published_at TEXT,
  accessed_at TEXT NOT NULL DEFAULT (datetime('now')),
  source_type TEXT,
  content_summary TEXT,
  content_hash TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(project_id, url)
);

CREATE TABLE IF NOT EXISTS fact_claims (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  place_id TEXT REFERENCES places(id) ON DELETE SET NULL,
  claim_text TEXT NOT NULL,
  category TEXT,
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  stability TEXT NOT NULL CHECK (stability IN ('stable','time_sensitive')),
  valid_as_of TEXT,
  status TEXT NOT NULL CHECK (status IN ('proposed','accepted','conflict','rejected')),
  source_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_fact_claims_project ON fact_claims(project_id, status);

CREATE TABLE IF NOT EXISTS script_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES script_versions(id) ON DELETE SET NULL,
  version_number INTEGER NOT NULL,
  script_type TEXT NOT NULL CHECK (script_type IN ('provisional','final')),
  status TEXT NOT NULL CHECK (status IN ('draft','validated','locked','superseded')),
  title TEXT,
  full_text TEXT NOT NULL,
  structure_json TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  generation_reason TEXT,
  provider_call_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  locked_at TEXT,
  UNIQUE(project_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_script_versions_project ON script_versions(project_id, status, version_number DESC);

CREATE TABLE IF NOT EXISTS script_sections (
  id TEXT PRIMARY KEY,
  script_version_id TEXT NOT NULL REFERENCES script_versions(id) ON DELETE CASCADE,
  sequence_no INTEGER NOT NULL,
  chapter_no INTEGER NOT NULL,
  title TEXT,
  text TEXT NOT NULL,
  target_duration_ms INTEGER,
  UNIQUE(script_version_id, sequence_no)
);

CREATE TABLE IF NOT EXISTS narration_beats (
  id TEXT PRIMARY KEY,
  script_section_id TEXT NOT NULL REFERENCES script_sections(id) ON DELETE CASCADE,
  sequence_no INTEGER NOT NULL,
  narration_text TEXT NOT NULL,
  target_duration_ms INTEGER NOT NULL,
  actual_start_ms INTEGER,
  actual_end_ms INTEGER,
  claim_ids_json TEXT NOT NULL DEFAULT '[]',
  pronunciation_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','coverage_validated','final','superseded')),
  UNIQUE(script_section_id, sequence_no)
);

CREATE TABLE IF NOT EXISTS scene_contracts (
  id TEXT PRIMARY KEY,
  narration_beat_id TEXT NOT NULL UNIQUE REFERENCES narration_beats(id) ON DELETE CASCADE,
  contract_version INTEGER NOT NULL,
  contract_json TEXT NOT NULL,
  required_place_id TEXT REFERENCES places(id) ON DELETE SET NULL,
  required_granularity TEXT CHECK (required_granularity IN ('country','region','city','neighborhood','landmark','feature') OR required_granularity IS NULL),
  max_visual_shot_ms INTEGER NOT NULL DEFAULT 7000 CHECK (max_visual_shot_ms <= 7000),
  target_shot_count INTEGER NOT NULL DEFAULT 1,
  verification_status TEXT NOT NULL DEFAULT 'provisional' CHECK (verification_status IN ('provisional','metadata_validated','footage_validated','blocked')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shot_candidates (
  id TEXT PRIMARY KEY,
  scene_contract_id TEXT NOT NULL REFERENCES scene_contracts(id) ON DELETE CASCADE,
  source_asset_id TEXT NOT NULL REFERENCES source_assets(id) ON DELETE CASCADE,
  asset_segment_id TEXT REFERENCES asset_segments(id) ON DELETE CASCADE,
  candidate_rank INTEGER,
  candidate_score REAL NOT NULL,
  score_components_json TEXT NOT NULL,
  explanation_json TEXT NOT NULL DEFAULT '[]',
  candidate_stage TEXT NOT NULL CHECK (candidate_stage IN ('metadata','downloaded','verified')),
  status TEXT NOT NULL DEFAULT 'eligible' CHECK (status IN ('eligible','selected','alternate','rejected','unavailable')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(scene_contract_id, source_asset_id, asset_segment_id, candidate_stage)
);

CREATE INDEX IF NOT EXISTS idx_shot_candidates_contract ON shot_candidates(scene_contract_id, status, candidate_score DESC);

CREATE TABLE IF NOT EXISTS acquisition_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_asset_id TEXT NOT NULL REFERENCES source_assets(id) ON DELETE RESTRICT,
  action_type TEXT NOT NULL CHECK (action_type IN ('download','license_only')),
  role TEXT NOT NULL CHECK (role IN ('primary','alternate','hero')),
  priority INTEGER NOT NULL DEFAULT 100,
  state TEXT NOT NULL,
  envato_project_name TEXT NOT NULL,
  scene_contract_ids_json TEXT NOT NULL DEFAULT '[]',
  expected_metadata_json TEXT NOT NULL DEFAULT '{}',
  active_window_started_at TEXT,
  detected_path TEXT,
  mapped_file_id TEXT REFERENCES asset_files(id) ON DELETE SET NULL,
  mapping_confidence REAL CHECK (mapping_confidence BETWEEN 0 AND 1),
  failure_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, source_asset_id, action_type)
);

CREATE INDEX IF NOT EXISTS idx_acquisition_project_state ON acquisition_items(project_id, state, priority);

CREATE TABLE IF NOT EXISTS project_asset_licenses (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_asset_id TEXT NOT NULL REFERENCES source_assets(id) ON DELETE RESTRICT,
  envato_project_name TEXT NOT NULL,
  license_status TEXT NOT NULL CHECK (license_status IN ('not_required','pending','operator_attested','certificate_attached','verified','conflict')),
  license_code TEXT,
  certificate_path TEXT,
  attested_at TEXT,
  verified_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, source_asset_id)
);

CREATE TABLE IF NOT EXISTS selected_visual_shots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scene_contract_id TEXT NOT NULL REFERENCES scene_contracts(id) ON DELETE CASCADE,
  sequence_no INTEGER NOT NULL,
  asset_segment_id TEXT NOT NULL REFERENCES asset_segments(id) ON DELETE RESTRICT,
  source_asset_id TEXT NOT NULL REFERENCES source_assets(id) ON DELETE RESTRICT,
  source_file_id TEXT NOT NULL REFERENCES asset_files(id) ON DELETE RESTRICT,
  timeline_start_ms INTEGER,
  timeline_end_ms INTEGER,
  source_in_ms INTEGER NOT NULL,
  source_out_ms INTEGER NOT NULL,
  treatment TEXT NOT NULL CHECK (treatment IN ('full_screen','inset','split_screen','background','graphic_support')),
  crop_json TEXT NOT NULL DEFAULT '{}',
  transform_json TEXT NOT NULL DEFAULT '{}',
  transition_json TEXT NOT NULL DEFAULT '{}',
  selection_score REAL,
  selection_reason_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'selected' CHECK (status IN ('selected','locked','replaced','rejected')),
  UNIQUE(project_id, sequence_no),
  CHECK (source_out_ms > source_in_ms),
  CHECK ((source_out_ms - source_in_ms) <= 7000)
);

CREATE INDEX IF NOT EXISTS idx_selected_shots_contract ON selected_visual_shots(scene_contract_id, status);

CREATE TABLE IF NOT EXISTS voice_assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  script_version_id TEXT NOT NULL REFERENCES script_versions(id) ON DELETE CASCADE,
  script_section_id TEXT REFERENCES script_sections(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT,
  voice_id TEXT NOT NULL,
  settings_json TEXT NOT NULL,
  input_hash TEXT NOT NULL UNIQUE,
  audio_path TEXT,
  timing_path TEXT,
  duration_ms INTEGER,
  status TEXT NOT NULL CHECK (status IN ('queued','generating','ready','failed','stale')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS render_manifests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  manifest_json TEXT NOT NULL,
  manifest_hash TEXT NOT NULL UNIQUE,
  script_version_id TEXT NOT NULL REFERENCES script_versions(id) ON DELETE RESTRICT,
  output_profile_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','validated','locked','superseded')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, version_number)
);

CREATE TABLE IF NOT EXISTS renders (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  render_manifest_id TEXT NOT NULL REFERENCES render_manifests(id) ON DELETE RESTRICT,
  render_type TEXT NOT NULL CHECK (render_type IN ('scene_preview','range_preview','draft','final_1080p','final_4k')),
  profile_id TEXT NOT NULL,
  output_path TEXT,
  output_sha256 TEXT,
  duration_ms INTEGER,
  width INTEGER,
  height INTEGER,
  codec TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued','rendering','validating','ready','failed','stale')),
  ffmpeg_version TEXT,
  command_redacted TEXT,
  diagnostics_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_renders_project_type ON renders(project_id, render_type, status);

CREATE TABLE IF NOT EXISTS qc_results (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  render_id TEXT REFERENCES renders(id) ON DELETE CASCADE,
  check_id TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('blocker','high','medium','low')),
  status TEXT NOT NULL CHECK (status IN ('pass','fail','warning','skipped')),
  evidence_json TEXT NOT NULL DEFAULT '{}',
  repair_class TEXT CHECK (repair_class IN ('automatic','alternate','regenerate_range','acquisition','operator','fatal') OR repair_class IS NULL),
  repair_attempted INTEGER NOT NULL DEFAULT 0 CHECK (repair_attempted IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_qc_project_status ON qc_results(project_id, status, severity);

CREATE TABLE IF NOT EXISTS youtube_publications (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE RESTRICT,
  final_render_id TEXT NOT NULL REFERENCES renders(id) ON DELETE RESTRICT,
  youtube_video_id TEXT UNIQUE,
  upload_session_ref_encrypted TEXT,
  upload_status TEXT NOT NULL CHECK (upload_status IN ('not_started','uploading','uploaded','processing','ready_private','scheduled','published','failed','manual_studio_action')),
  privacy_status TEXT CHECK (privacy_status IN ('private','unlisted','public') OR privacy_status IS NULL),
  title TEXT,
  description TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  chapters_json TEXT NOT NULL DEFAULT '[]',
  thumbnail_path TEXT,
  thumbnail_sha256 TEXT,
  caption_path TEXT,
  caption_sha256 TEXT,
  playlist_id TEXT,
  contains_synthetic_media INTEGER NOT NULL DEFAULT 0 CHECK (contains_synthetic_media IN (0,1)),
  made_for_kids INTEGER NOT NULL DEFAULT 0 CHECK (made_for_kids IN (0,1)),
  scheduled_at TEXT,
  published_at TEXT,
  api_metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS analytics_snapshots (
  id TEXT PRIMARY KEY,
  youtube_publication_id TEXT NOT NULL REFERENCES youtube_publications(id) ON DELETE CASCADE,
  snapshot_date TEXT NOT NULL,
  period_days INTEGER,
  metrics_json TEXT NOT NULL,
  collected_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(youtube_publication_id, snapshot_date, period_days)
);

CREATE TABLE IF NOT EXISTS retention_points (
  id TEXT PRIMARY KEY,
  youtube_publication_id TEXT NOT NULL REFERENCES youtube_publications(id) ON DELETE CASCADE,
  snapshot_date TEXT NOT NULL,
  elapsed_ratio REAL NOT NULL CHECK (elapsed_ratio BETWEEN 0 AND 1),
  position_ms INTEGER NOT NULL,
  audience_watch_ratio REAL,
  relative_retention_performance REAL,
  mapped_chapter_no INTEGER,
  mapped_beat_id TEXT REFERENCES narration_beats(id) ON DELETE SET NULL,
  mapped_visual_shot_id TEXT REFERENCES selected_visual_shots(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(youtube_publication_id, snapshot_date, elapsed_ratio)
);

CREATE INDEX IF NOT EXISTS idx_retention_video_position ON retention_points(youtube_publication_id, snapshot_date, position_ms);

CREATE TABLE IF NOT EXISTS provider_calls (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  provider_type TEXT NOT NULL,
  provider_name TEXT NOT NULL,
  operation TEXT NOT NULL,
  model TEXT,
  request_hash TEXT NOT NULL,
  response_hash TEXT,
  request_metadata_json TEXT NOT NULL DEFAULT '{}',
  response_metadata_json TEXT NOT NULL DEFAULT '{}',
  usage_json TEXT NOT NULL DEFAULT '{}',
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','cached')),
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_provider_calls_hash ON provider_calls(provider_name, operation, request_hash, status);
CREATE INDEX IF NOT EXISTS idx_provider_calls_project ON provider_calls(project_id, created_at);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  input_json TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','ready','running','waiting_external','waiting_human','retry_scheduled','succeeded','failed_retryable','failed_permanent','cancelled','stale')),
  priority INTEGER NOT NULL DEFAULT 100,
  progress REAL NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 1),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_run_at TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  checkpoint_json TEXT NOT NULL DEFAULT '{}',
  output_json TEXT NOT NULL DEFAULT '{}',
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT,
  UNIQUE(job_type, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_jobs_dispatch ON jobs(status, next_run_at, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_lease ON jobs(status, lease_expires_at);

CREATE TABLE IF NOT EXISTS job_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL,
  worker_id TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','abandoned')),
  checkpoint_json TEXT NOT NULL DEFAULT '{}',
  error_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(job_id, attempt_no)
);

CREATE TABLE IF NOT EXISTS job_dependencies (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  depends_on_job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  dependency_type TEXT NOT NULL DEFAULT 'success' CHECK (dependency_type IN ('success','completion')),
  PRIMARY KEY (job_id, depends_on_job_id)
);

CREATE TABLE IF NOT EXISTS exceptions (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  exception_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('blocker','high','medium','low')),
  status TEXT NOT NULL CHECK (status IN ('open','acknowledged','resolved','overridden','dismissed')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  recommended_actions_json TEXT NOT NULL DEFAULT '[]',
  resolution_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_exceptions_open ON exceptions(status, severity, created_at);
CREATE INDEX IF NOT EXISTS idx_exceptions_project ON exceptions(project_id, status);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('system','human','model','provider')),
  actor_id TEXT,
  event_type TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  summary TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_events(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_events(entity_type, entity_id, created_at);

-- Application-level integrity notes:
-- 1. projects.active_script_version_id, active_render_manifest_id, final_render_id,
--    and youtube_publication_id are validated by repositories because SQLite cannot
--    add cyclic foreign keys cleanly before all tables exist in a portable migration.
-- 2. The app owns asset_search upserts/deletes transactionally with source asset changes.
-- 3. JSON columns are validated by application schemas before persistence.
