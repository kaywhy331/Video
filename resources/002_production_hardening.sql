ALTER TABLE projects ADD COLUMN resume_state TEXT;
ALTER TABLE asset_files ADD COLUMN visual_verification_json TEXT;
ALTER TABLE publication_records ADD COLUMN synthetic_media INTEGER NOT NULL DEFAULT 0;

CREATE TABLE project_scene_claims (
  scene_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  PRIMARY KEY(scene_id, claim_id),
  FOREIGN KEY(scene_id) REFERENCES project_scenes(id) ON DELETE CASCADE,
  FOREIGN KEY(claim_id) REFERENCES fact_claims(id) ON DELETE CASCADE
);

CREATE INDEX idx_scene_claims_claim ON project_scene_claims(claim_id);

CREATE TRIGGER publication_final_hash_insert
BEFORE INSERT ON publication_records
WHEN EXISTS (
  SELECT 1 FROM publication_records WHERE final_sha256 = NEW.final_sha256
)
BEGIN
  SELECT RAISE(ABORT, 'duplicate publication final hash');
END;

CREATE TRIGGER publication_final_hash_update
BEFORE UPDATE OF final_sha256 ON publication_records
WHEN EXISTS (
  SELECT 1 FROM publication_records
  WHERE final_sha256 = NEW.final_sha256 AND id <> OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'duplicate publication final hash');
END;

CREATE TABLE backup_runs (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  integrity_result TEXT NOT NULL,
  missing_originals_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
