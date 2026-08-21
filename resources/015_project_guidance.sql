CREATE TABLE project_guidance (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK(mode IN ('automatic','guided')),
  starting_script TEXT CHECK(starting_script IS NULL OR length(starting_script) <= 20000),
  starting_script_sha256 TEXT,
  requested_destination_key TEXT,
  requested_topic_id TEXT,
  requested_target_duration_ms INTEGER
    CHECK(requested_target_duration_ms IS NULL OR requested_target_duration_ms BETWEEN 60000 AND 1800000),
  resolved_destination_key TEXT NOT NULL,
  resolved_destination TEXT NOT NULL,
  resolved_topic_title TEXT NOT NULL,
  resolved_target_duration_ms INTEGER NOT NULL
    CHECK(resolved_target_duration_ms BETWEEN 60000 AND 1800000),
  constraints_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK((starting_script IS NULL) = (starting_script_sha256 IS NULL))
);

CREATE TRIGGER project_guidance_immutable
BEFORE UPDATE ON project_guidance
BEGIN
  SELECT RAISE(ABORT, 'project guidance provenance is immutable');
END;
