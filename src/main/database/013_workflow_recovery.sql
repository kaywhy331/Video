ALTER TABLE scheduler_runs RENAME TO scheduler_runs_legacy;

CREATE TABLE scheduler_runs (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL CHECK(trigger IN ('timer','manual','settings','startup')),
  outcome TEXT NOT NULL CHECK(outcome IN ('created','resumed','not_due','paused','blocked','failed')),
  reason_code TEXT,
  reason TEXT,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

INSERT INTO scheduler_runs(
  id, trigger, outcome, reason_code, reason, project_id, evidence_json, created_at
)
SELECT id, trigger, outcome, reason_code, reason, project_id, evidence_json, created_at
FROM scheduler_runs_legacy;

DROP TABLE scheduler_runs_legacy;

CREATE INDEX idx_scheduler_runs_created ON scheduler_runs(created_at DESC);

CREATE TABLE revision_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK(category IN (
    'packaging','caption_typo','voice_pronunciation','script_factual_issue',
    'wrong_or_weak_shot','new_footage_required','major_story_change'
  )),
  note TEXT NOT NULL,
  affected_scene_id TEXT REFERENCES project_scenes(id) ON DELETE SET NULL,
  affected_section_id TEXT REFERENCES narration_sections(id) ON DELETE SET NULL,
  pronunciation_term TEXT,
  pronunciation_value TEXT,
  return_state TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK(status IN ('requested','in_progress','completed','cancelled')),
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX idx_revision_requests_project
  ON revision_requests(project_id, status, created_at DESC);
