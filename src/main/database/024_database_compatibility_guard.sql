-- Schema 001 historically ran on every startup, so databases upgraded through
-- schema 14 can contain these superseded indexes. Normalize upgrades to the
-- same schema as a fresh install before installing the compatibility guard.
DROP INDEX IF EXISTS idx_assets_country;
DROP INDEX IF EXISTS idx_assets_city;
DROP INDEX IF EXISTS idx_assets_location;
DROP INDEX IF EXISTS idx_assets_updated;

DROP TRIGGER IF EXISTS schema_migrations_compatibility_insert;
DROP TRIGGER IF EXISTS schema_migrations_compatibility_update;
DROP TRIGGER IF EXISTS schema_migrations_compatibility_delete;

CREATE TRIGGER schema_migrations_compatibility_insert
BEFORE INSERT ON schema_migrations
WHEN videofactory_schema_capability() < 24
BEGIN
  SELECT RAISE(ABORT, 'DATABASE_SCHEMA_INCOMPATIBLE: schema capability 24 is required');
END;

CREATE TRIGGER schema_migrations_compatibility_update
BEFORE UPDATE ON schema_migrations
WHEN videofactory_schema_capability() < 24
BEGIN
  SELECT RAISE(ABORT, 'DATABASE_SCHEMA_INCOMPATIBLE: schema capability 24 is required');
END;

CREATE TRIGGER schema_migrations_compatibility_delete
BEFORE DELETE ON schema_migrations
WHEN videofactory_schema_capability() < 24
BEGIN
  SELECT RAISE(ABORT, 'DATABASE_SCHEMA_INCOMPATIBLE: schema capability 24 is required');
END;
