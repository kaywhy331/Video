DROP INDEX IF EXISTS idx_assets_country;
DROP INDEX IF EXISTS idx_assets_city;
DROP INDEX IF EXISTS idx_assets_location;
DROP INDEX IF EXISTS idx_assets_updated;

CREATE INDEX IF NOT EXISTS idx_assets_title_id
  ON assets(title COLLATE NOCASE, id);
CREATE INDEX IF NOT EXISTS idx_assets_country_id
  ON assets(country COLLATE NOCASE, id);
CREATE INDEX IF NOT EXISTS idx_assets_city_id
  ON assets(city COLLATE NOCASE, id);
CREATE INDEX IF NOT EXISTS idx_assets_location_id
  ON assets(location_name COLLATE NOCASE, id);
CREATE INDEX IF NOT EXISTS idx_assets_updated_id
  ON assets(updated_at, id);
