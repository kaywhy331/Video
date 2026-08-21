ALTER TABLE asset_files ADD COLUMN perceptual_hash TEXT;

CREATE INDEX idx_asset_files_perceptual_hash
ON asset_files(perceptual_hash)
WHERE perceptual_hash IS NOT NULL;
