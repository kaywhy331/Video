CREATE TABLE youtube_connection_binding (
  singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
  channel_id TEXT NOT NULL CHECK(length(trim(channel_id)) > 0),
  channel_title TEXT NOT NULL CHECK(length(trim(channel_title)) > 0),
  credential_fingerprint TEXT NOT NULL CHECK(length(credential_fingerprint) = 64),
  confirmed_at TEXT NOT NULL
);
