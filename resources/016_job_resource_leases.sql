CREATE TABLE IF NOT EXISTS job_resource_leases (
  resource_key TEXT PRIMARY KEY,
  holder_job_id TEXT NOT NULL,
  lease_owner TEXT NOT NULL,
  lease_until TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(holder_job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_job_resource_holder
  ON job_resource_leases(holder_job_id);
