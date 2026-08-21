ALTER TABLE projects ADD COLUMN pending_lifecycle_action TEXT
  CHECK(pending_lifecycle_action IS NULL OR pending_lifecycle_action = 'pause');

CREATE INDEX idx_projects_pending_lifecycle
  ON projects(pending_lifecycle_action, locked_by_job_id, created_at);
