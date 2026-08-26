DROP TRIGGER IF EXISTS publication_final_hash_insert;
DROP TRIGGER IF EXISTS publication_final_hash_update;

ALTER TABLE publication_records RENAME TO publication_records_legacy;

CREATE TABLE publication_records (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  channel_id TEXT,
  video_id TEXT,
  privacy_status TEXT NOT NULL,
  upload_session_uri TEXT,
  final_render_id TEXT,
  final_sha256 TEXT NOT NULL,
  snapshot_version INTEGER NOT NULL DEFAULT 0,
  snapshot_status TEXT NOT NULL DEFAULT 'legacy_unbound'
    CHECK(snapshot_status IN ('current', 'stale', 'legacy_unbound')),
  processing_status TEXT,
  selected_package_id TEXT,
  caption_id TEXT,
  thumbnail_uploaded INTEGER NOT NULL DEFAULT 0,
  approval_hash TEXT,
  approved_at TEXT,
  scheduled_at TEXT,
  published_at TEXT,
  error TEXT,
  synthetic_media INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(final_render_id) REFERENCES renders(id) ON DELETE SET NULL,
  FOREIGN KEY(selected_package_id) REFERENCES packaging_candidates(id) ON DELETE SET NULL
);

INSERT INTO publication_records(
  id, project_id, channel_id, video_id, privacy_status, upload_session_uri,
  final_render_id, final_sha256, snapshot_version, snapshot_status,
  processing_status, selected_package_id, caption_id, thumbnail_uploaded,
  approval_hash, approved_at, scheduled_at, published_at, error,
  synthetic_media, created_at, updated_at
)
SELECT
  legacy.id,
  legacy.project_id,
  legacy.channel_id,
  legacy.video_id,
  legacy.privacy_status,
  legacy.upload_session_uri,
  CASE WHEN (
    SELECT count(*) FROM renders candidate
    WHERE candidate.project_id = legacy.project_id
      AND candidate.kind = 'final'
      AND candidate.sha256 = legacy.final_sha256
  ) = 1 THEN (
    SELECT candidate.id FROM renders candidate
    WHERE candidate.project_id = legacy.project_id
      AND candidate.kind = 'final'
      AND candidate.sha256 = legacy.final_sha256
    LIMIT 1
  ) ELSE NULL END,
  legacy.final_sha256,
  CASE WHEN (
    SELECT count(*) FROM renders candidate
    WHERE candidate.project_id = legacy.project_id
      AND candidate.kind = 'final'
      AND candidate.sha256 = legacy.final_sha256
  ) = 1 THEN 1 ELSE 0 END,
  CASE
    WHEN (
      SELECT count(*) FROM renders candidate
      WHERE candidate.project_id = legacy.project_id
        AND candidate.kind = 'final'
        AND candidate.sha256 = legacy.final_sha256
    ) <> 1 THEN 'legacy_unbound'
    WHEN (
      SELECT candidate.id FROM renders candidate
      WHERE candidate.project_id = legacy.project_id
        AND candidate.kind = 'final'
        AND candidate.sha256 = legacy.final_sha256
      LIMIT 1
    ) = (SELECT project.final_render_id FROM projects project WHERE project.id = legacy.project_id)
      THEN 'current'
    ELSE 'stale'
  END,
  legacy.processing_status,
  legacy.selected_package_id,
  legacy.caption_id,
  legacy.thumbnail_uploaded,
  CASE WHEN (
    SELECT count(*) FROM renders candidate
    WHERE candidate.project_id = legacy.project_id
      AND candidate.kind = 'final'
      AND candidate.sha256 = legacy.final_sha256
  ) = 1 AND (
    SELECT candidate.id FROM renders candidate
    WHERE candidate.project_id = legacy.project_id
      AND candidate.kind = 'final'
      AND candidate.sha256 = legacy.final_sha256
    LIMIT 1
  ) = (SELECT project.final_render_id FROM projects project WHERE project.id = legacy.project_id)
    THEN legacy.approval_hash ELSE NULL END,
  CASE WHEN (
    SELECT count(*) FROM renders candidate
    WHERE candidate.project_id = legacy.project_id
      AND candidate.kind = 'final'
      AND candidate.sha256 = legacy.final_sha256
  ) = 1 AND (
    SELECT candidate.id FROM renders candidate
    WHERE candidate.project_id = legacy.project_id
      AND candidate.kind = 'final'
      AND candidate.sha256 = legacy.final_sha256
    LIMIT 1
  ) = (SELECT project.final_render_id FROM projects project WHERE project.id = legacy.project_id)
    THEN legacy.approved_at ELSE NULL END,
  legacy.scheduled_at,
  legacy.published_at,
  CASE WHEN (
    SELECT count(*) FROM renders candidate
    WHERE candidate.project_id = legacy.project_id
      AND candidate.kind = 'final'
      AND candidate.sha256 = legacy.final_sha256
  ) <> 1 THEN COALESCE(
    legacy.error,
    'Legacy publication could not be bound to one final render; private re-upload and review are required.'
  ) ELSE legacy.error END,
  legacy.synthetic_media,
  legacy.created_at,
  legacy.updated_at
FROM publication_records_legacy legacy;

UPDATE publication_records
SET privacy_status = 'private',
  approval_hash = NULL,
  approved_at = NULL,
  scheduled_at = NULL,
  published_at = NULL,
  error = COALESCE(
    error,
    CASE snapshot_status
      WHEN 'stale' THEN 'Legacy publication targets a non-active final render; private re-upload and review are required.'
      ELSE 'Legacy publication could not be bound to one final render; private re-upload and review are required.'
    END
  )
WHERE snapshot_status <> 'current';

DROP TABLE publication_records_legacy;

CREATE UNIQUE INDEX idx_publication_snapshot_identity
  ON publication_records(project_id, channel_id, final_render_id, final_sha256)
  WHERE channel_id IS NOT NULL AND final_render_id IS NOT NULL;

CREATE INDEX idx_publication_project_status
  ON publication_records(project_id, snapshot_status, created_at);
