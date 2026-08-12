ALTER TABLE qc_results ADD COLUMN repair_class TEXT;
ALTER TABLE qc_results ADD COLUMN repair_attempted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE qc_results ADD COLUMN repair_action TEXT;
ALTER TABLE renders ADD COLUMN artifact_version INTEGER NOT NULL DEFAULT 1;

UPDATE renders AS current
SET artifact_version = (
  SELECT count(*) FROM renders AS prior
  WHERE prior.project_id = current.project_id
    AND prior.kind = current.kind
    AND (
      prior.created_at < current.created_at
      OR (prior.created_at = current.created_at AND prior.id <= current.id)
    )
);

CREATE TABLE shot_candidates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  scene_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  candidate_rank INTEGER NOT NULL,
  candidate_score REAL NOT NULL,
  score_components_json TEXT NOT NULL DEFAULT '{}',
  explanation_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'eligible',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(scene_id, asset_id),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(scene_id) REFERENCES project_scenes(id) ON DELETE CASCADE,
  FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
);

CREATE INDEX idx_shot_candidates_scene
  ON shot_candidates(scene_id, status, candidate_rank, candidate_score DESC);
CREATE INDEX idx_shot_candidates_asset
  ON shot_candidates(project_id, asset_id, status);

CREATE TABLE repair_attempts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  scene_id TEXT,
  render_id TEXT,
  qc_result_id TEXT,
  failure_code TEXT NOT NULL,
  repair_class TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  maximum_attempts INTEGER NOT NULL,
  source_asset_id TEXT,
  replacement_asset_id TEXT,
  replacement_file_id TEXT,
  replacement_segment_id TEXT,
  source_artifact_version INTEGER,
  target_state TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(scene_id) REFERENCES project_scenes(id) ON DELETE CASCADE,
  FOREIGN KEY(render_id) REFERENCES renders(id) ON DELETE SET NULL,
  FOREIGN KEY(qc_result_id) REFERENCES qc_results(id) ON DELETE SET NULL,
  FOREIGN KEY(source_asset_id) REFERENCES assets(id) ON DELETE SET NULL,
  FOREIGN KEY(replacement_asset_id) REFERENCES assets(id) ON DELETE SET NULL,
  FOREIGN KEY(replacement_file_id) REFERENCES asset_files(id) ON DELETE SET NULL,
  FOREIGN KEY(replacement_segment_id) REFERENCES media_segments(id) ON DELETE SET NULL
);

CREATE INDEX idx_repair_attempts_project
  ON repair_attempts(project_id, status, created_at DESC);
CREATE INDEX idx_repair_attempts_failure
  ON repair_attempts(project_id, scene_id, failure_code, attempt_number DESC);
