ALTER TABLE provider_health RENAME TO provider_health_v19;

CREATE TABLE provider_health (
  provider TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN (
    'healthy',
    'auth_invalid',
    'quota_exhausted',
    'unavailable',
    'invalid_endpoint',
    'endpoint_untrusted',
    'credential_origin_mismatch',
    'timeout',
    'provider_failure'
  )),
  status_code INTEGER,
  message TEXT,
  checked_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

INSERT INTO provider_health(
  provider, status, status_code, message, checked_at, metadata_json
)
SELECT provider, status, status_code, message, checked_at, metadata_json
FROM provider_health_v19;

DROP TABLE provider_health_v19;

CREATE TABLE provider_endpoint_bindings (
  provider TEXT PRIMARY KEY CHECK(provider IN (
    'openai_compatible',
    'openai_compatible_vision',
    'tavily',
    'http_tts'
  )),
  configured_url TEXT NOT NULL,
  canonical_origin TEXT NOT NULL,
  trust_mode TEXT NOT NULL CHECK(trust_mode IN ('managed','custom_remote','custom_local')),
  status TEXT NOT NULL CHECK(status IN ('confirmed','confirmation_required','blocked')),
  credential_fingerprint TEXT,
  trusted_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_provider_endpoint_bindings_status
  ON provider_endpoint_bindings(status, provider);
