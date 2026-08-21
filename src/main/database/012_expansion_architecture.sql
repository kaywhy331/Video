CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  short_code TEXT NOT NULL UNIQUE,
  default_language_code TEXT NOT NULL DEFAULT 'en',
  default_voice_id TEXT,
  youtube_channel_id TEXT,
  youtube_channel_title TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
  policy_json TEXT NOT NULL DEFAULT '{}',
  external_qualification TEXT NOT NULL DEFAULT 'unverified'
    CHECK(external_qualification IN ('unverified','qualified','blocked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_channels_one_default ON channels(is_default) WHERE is_default = 1;

CREATE TABLE language_voice_profiles (
  id TEXT PRIMARY KEY,
  language_code TEXT NOT NULL,
  language_name TEXT NOT NULL,
  voice_provider TEXT NOT NULL,
  voice_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
  settings_json TEXT NOT NULL DEFAULT '{}',
  external_qualification TEXT NOT NULL DEFAULT 'unverified'
    CHECK(external_qualification IN ('unverified','qualified','blocked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(language_code, voice_provider, voice_id)
);

CREATE TABLE provider_registry (
  id TEXT PRIMARY KEY,
  provider_key TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  capability TEXT NOT NULL CHECK(capability IN (
    'stock','llm','vision','tts','keyword_metrics','research','uploader','analytics','local_ai','render_worker'
  )),
  implementation TEXT NOT NULL,
  configured INTEGER NOT NULL DEFAULT 0 CHECK(configured IN (0,1)),
  available INTEGER NOT NULL DEFAULT 0 CHECK(available IN (0,1)),
  external_qualification TEXT NOT NULL DEFAULT 'unverified'
    CHECK(external_qualification IN ('unverified','qualified','blocked','not_required')),
  capability_json TEXT NOT NULL DEFAULT '{}',
  last_checked_at TEXT,
  status_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_provider_registry_capability ON provider_registry(capability, provider_key);

CREATE TABLE output_profiles (
  id TEXT PRIMARY KEY,
  profile_key TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  width INTEGER NOT NULL CHECK(width > 0),
  height INTEGER NOT NULL CHECK(height > 0),
  orientation TEXT NOT NULL CHECK(orientation IN ('landscape','portrait','square')),
  frame_rate REAL NOT NULL CHECK(frame_rate > 0),
  video_codec TEXT NOT NULL,
  audio_codec TEXT NOT NULL,
  qualification_policy_json TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_output_profiles_one_default ON output_profiles(is_default) WHERE is_default = 1;

ALTER TABLE projects ADD COLUMN channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL;
ALTER TABLE projects ADD COLUMN language_voice_profile_id TEXT REFERENCES language_voice_profiles(id) ON DELETE SET NULL;
ALTER TABLE projects ADD COLUMN output_profile_id TEXT REFERENCES output_profiles(id) ON DELETE SET NULL;
ALTER TABLE projects ADD COLUMN channel_snapshot_json TEXT;
ALTER TABLE projects ADD COLUMN language_voice_snapshot_json TEXT;
ALTER TABLE projects ADD COLUMN output_profile_snapshot_json TEXT;

CREATE TABLE keyword_metric_observations (
  id TEXT PRIMARY KEY,
  topic_candidate_id TEXT REFERENCES topic_candidates(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  provider TEXT NOT NULL,
  metric_type TEXT NOT NULL,
  value REAL,
  geography_code TEXT,
  language_code TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
  youtube_native INTEGER NOT NULL CHECK(youtube_native IN (0,1)),
  raw_metadata_json TEXT NOT NULL DEFAULT '{}',
  source_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_keyword_metrics_candidate
  ON keyword_metric_observations(topic_candidate_id, keyword, collected_at DESC);

CREATE TABLE google_sheets_sync_configs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  spreadsheet_id TEXT NOT NULL,
  sheet_range TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  validation_template_id TEXT REFERENCES catalog_validation_templates(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(spreadsheet_id, sheet_range)
);

CREATE TABLE google_sheets_sync_runs (
  id TEXT PRIMARY KEY,
  config_id TEXT REFERENCES google_sheets_sync_configs(id) ON DELETE SET NULL,
  spreadsheet_id TEXT NOT NULL,
  sheet_range TEXT NOT NULL,
  source_sha256 TEXT,
  materialized_path TEXT,
  preview_id TEXT REFERENCES catalog_import_previews(id) ON DELETE SET NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('staged','up_to_date','blocked','failed')),
  diff_json TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX idx_sheets_sync_runs_created ON google_sheets_sync_runs(created_at DESC);

CREATE TABLE analytics_collection_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  video_id TEXT NOT NULL,
  snapshot_day INTEGER NOT NULL CHECK(snapshot_day IN (1,3,7,28,90)),
  provider TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','complete','failed')),
  analytics_snapshot_id TEXT REFERENCES analytics_snapshots(id) ON DELETE SET NULL,
  request_json TEXT NOT NULL DEFAULT '{}',
  response_hash TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX idx_analytics_collection_runs_project
  ON analytics_collection_runs(project_id, snapshot_day, created_at DESC);

INSERT INTO channels(
  id, name, short_code, default_language_code, active, is_default,
  policy_json, external_qualification, created_at, updated_at
) VALUES(
  'channel-default', 'Default channel', 'TRAVEL', 'en', 1, 1,
  '{"publishing":"private_first","multiChannelPublishingQualified":false}',
  'unverified', datetime('now'), datetime('now')
);

INSERT INTO language_voice_profiles(
  id, language_code, language_name, voice_provider, voice_id, display_name,
  active, is_default, settings_json, external_qualification, created_at, updated_at
) VALUES(
  'language-en-default', 'en', 'English', 'windows_sapi', 'system-default',
  'English · system default', 1, 1, '{}', 'unverified', datetime('now'), datetime('now')
);

INSERT INTO output_profiles(
  id, profile_key, display_name, width, height, orientation, frame_rate,
  video_codec, audio_codec, qualification_policy_json, active, is_default,
  created_at, updated_at
) VALUES
  ('output-landscape-1080', 'landscape_1080p', 'Landscape 1080p', 1920, 1080, 'landscape', 30, 'h264', 'aac',
   '{"minimumRetainedWidth":1920,"minimumRetainedHeight":1080,"fallbackProfileKey":null}', 1, 1, datetime('now'), datetime('now')),
  ('output-landscape-4k', 'landscape_4k', 'Qualified landscape 4K', 3840, 2160, 'landscape', 30, 'h264', 'aac',
   '{"minimumRetainedWidth":3840,"minimumRetainedHeight":2160,"fallbackProfileKey":"landscape_1080p"}', 1, 0, datetime('now'), datetime('now')),
  ('output-vertical-1080', 'vertical_1080p', 'Vertical / Shorts 1080p', 1080, 1920, 'portrait', 30, 'h264', 'aac',
   '{"minimumRetainedWidth":1080,"minimumRetainedHeight":1920,"fallbackProfileKey":null,"cropRetentionMinimum":0.72}', 1, 0, datetime('now'), datetime('now'));

INSERT INTO provider_registry(
  id, provider_key, display_name, capability, implementation, configured,
  available, external_qualification, capability_json, created_at, updated_at
) VALUES
  ('provider-envato-manual', 'envato_manual', 'Envato manual acquisition', 'stock', 'manual_handoff', 1, 1, 'unverified', '{"readOnlyCatalog":true,"downloadAutomation":false}', datetime('now'), datetime('now')),
  ('provider-llm-mock', 'llm_mock', 'Local deterministic language fixture', 'llm', 'mock', 1, 1, 'not_required', '{"network":false,"productionContent":false}', datetime('now'), datetime('now')),
  ('provider-llm-openai', 'openai_compatible', 'OpenAI-compatible language model', 'llm', 'http', 0, 0, 'unverified', '{}', datetime('now'), datetime('now')),
  ('provider-vision-openai', 'openai_compatible_vision', 'OpenAI-compatible vision', 'vision', 'http', 0, 0, 'unverified', '{}', datetime('now'), datetime('now')),
  ('provider-tts-sapi', 'windows_sapi', 'Windows SAPI', 'tts', 'local_windows', 1, 0, 'unverified', '{}', datetime('now'), datetime('now')),
  ('provider-tts-http', 'http_tts', 'Generic HTTP TTS', 'tts', 'http', 0, 0, 'unverified', '{}', datetime('now'), datetime('now')),
  ('provider-research-tavily', 'tavily', 'Tavily Search and Extract', 'research', 'http', 0, 0, 'unverified', '{}', datetime('now'), datetime('now')),
  ('provider-youtube-upload', 'youtube', 'YouTube Data API', 'uploader', 'google_oauth', 0, 0, 'unverified', '{"privateFirst":true}', datetime('now'), datetime('now')),
  ('provider-youtube-analytics', 'youtube_analytics', 'YouTube Analytics API', 'analytics', 'google_oauth', 0, 0, 'unverified', '{}', datetime('now'), datetime('now')),
  ('provider-keyword-manual', 'keyword_manual', 'Manual/API-neutral keyword evidence', 'keyword_metrics', 'manual_import', 1, 1, 'not_required', '{"truthfulLabels":true}', datetime('now'), datetime('now')),
  ('provider-sheets-readonly', 'google_sheets_readonly', 'Google Sheets read-only sync', 'stock', 'google_api', 0, 0, 'unverified', '{"writeAccess":false,"stagesOnly":true}', datetime('now'), datetime('now')),
  ('provider-local-ai', 'local_ai_registry', 'Local AI provider contract', 'local_ai', 'registry_only', 0, 0, 'unverified', '{"runtimeImplemented":false}', datetime('now'), datetime('now')),
  ('provider-render-worker', 'remote_render_worker', 'Multi-machine render worker', 'render_worker', 'registry_only', 0, 0, 'unverified', '{"runtimeImplemented":false}', datetime('now'), datetime('now'));
