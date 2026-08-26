ALTER TABLE jobs ADD COLUMN transition_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN manual_attempt_grants INTEGER NOT NULL DEFAULT 0;

CREATE TABLE job_retry_reconciliations (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  job_transition_version INTEGER NOT NULL,
  job_type TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN (
    'no_remote_effect',
    'remote_session_reused',
    'remote_effect_reused',
    'identity_mismatch'
  )),
  publication_id TEXT,
  video_id TEXT,
  input_hash TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

CREATE INDEX idx_job_retry_reconciliation_job
  ON job_retry_reconciliations(job_id, job_transition_version);

CREATE INDEX idx_job_retry_reconciliation_outcome
  ON job_retry_reconciliations(outcome, created_at);
