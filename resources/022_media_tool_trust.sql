CREATE TABLE media_tool_trust (
  role TEXT PRIMARY KEY CHECK(role IN ('ffmpeg','ffprobe')),
  configured_path TEXT NOT NULL,
  canonical_path TEXT,
  sha256 TEXT CHECK(sha256 IS NULL OR length(sha256) = 64),
  size_bytes INTEGER,
  signature_status TEXT NOT NULL DEFAULT 'unavailable' CHECK(signature_status IN (
    'valid', 'unsigned', 'invalid', 'unknown', 'unavailable'
  )),
  signature_subject TEXT,
  status TEXT NOT NULL CHECK(status IN (
    'confirmation_required', 'trusted', 'changed', 'missing',
    'role_mismatch', 'probe_failed', 'revoked'
  )),
  trusted_at TEXT,
  trusted_app_version TEXT,
  version_output TEXT,
  probed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_media_tool_trust_status
  ON media_tool_trust(status, role);
