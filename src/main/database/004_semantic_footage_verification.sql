CREATE TABLE places (
  id TEXT PRIMARY KEY,
  stable_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  place_type TEXT NOT NULL CHECK (
    place_type IN ('country','region','city','neighborhood','landmark','feature')
  ),
  parent_id TEXT,
  country_code TEXT,
  latitude REAL,
  longitude REAL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  provider_refs_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(parent_id) REFERENCES places(id) ON DELETE SET NULL
);

CREATE INDEX idx_places_parent ON places(parent_id);
CREATE INDEX idx_places_name ON places(normalized_name, place_type);

CREATE TABLE asset_place_assertions (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  place_id TEXT NOT NULL,
  granularity TEXT NOT NULL CHECK (
    granularity IN ('country','region','city','neighborhood','landmark','feature')
  ),
  evidence_type TEXT NOT NULL CHECK (
    evidence_type IN ('imported','uploader_metadata','geocoder','vision','human')
  ),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  verification_status TEXT NOT NULL CHECK (
    verification_status IN ('unverified','accepted','verified','rejected','conflict')
  ),
  evidence_ref TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  is_effective INTEGER NOT NULL DEFAULT 0 CHECK (is_effective IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE,
  FOREIGN KEY(place_id) REFERENCES places(id) ON DELETE CASCADE,
  UNIQUE(asset_id, place_id, evidence_type)
);

CREATE INDEX idx_asset_places_asset
  ON asset_place_assertions(asset_id, is_effective, verification_status, confidence DESC);
CREATE INDEX idx_asset_places_place
  ON asset_place_assertions(place_id, verification_status, confidence DESC);

ALTER TABLE project_scenes ADD COLUMN required_place_id TEXT REFERENCES places(id) ON DELETE SET NULL;

CREATE TABLE footage_verifications (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  scene_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  asset_file_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('verified','rejected','conflict','provider_required','uncertain','error')
  ),
  geography_status TEXT NOT NULL CHECK (
    geography_status IN ('match','mismatch','unknown','not_required')
  ),
  semantic_status TEXT NOT NULL CHECK (
    semantic_status IN ('match','mismatch','unknown','not_required')
  ),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  required_place_id TEXT,
  observed_place_id TEXT,
  assessment_json TEXT NOT NULL DEFAULT '{}',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(scene_id) REFERENCES project_scenes(id) ON DELETE CASCADE,
  FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE,
  FOREIGN KEY(asset_file_id) REFERENCES asset_files(id) ON DELETE CASCADE,
  FOREIGN KEY(required_place_id) REFERENCES places(id) ON DELETE SET NULL,
  FOREIGN KEY(observed_place_id) REFERENCES places(id) ON DELETE SET NULL,
  UNIQUE(scene_id, asset_file_id, input_hash)
);

CREATE INDEX idx_footage_verifications_scene
  ON footage_verifications(project_id, scene_id, created_at DESC);
CREATE INDEX idx_footage_verifications_file
  ON footage_verifications(asset_file_id, status, created_at DESC);
