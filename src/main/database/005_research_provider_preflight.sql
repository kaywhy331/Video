ALTER TABLE projects ADD COLUMN provider_budget_usd REAL NOT NULL DEFAULT 15
  CHECK(provider_budget_usd >= 0);
ALTER TABLE projects ADD COLUMN provider_policy_json TEXT NOT NULL DEFAULT '{}';

ALTER TABLE research_sources ADD COLUMN published_at TEXT;
ALTER TABLE research_sources ADD COLUMN source_type TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE research_sources ADD COLUMN content_hash TEXT;
ALTER TABLE research_sources ADD COLUMN excerpt TEXT;
ALTER TABLE research_sources ADD COLUMN freshness_days INTEGER;
ALTER TABLE research_sources ADD COLUMN expires_at TEXT;
ALTER TABLE research_sources ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK(status IN ('active','stale','unavailable','rejected'));

ALTER TABLE fact_claims ADD COLUMN material INTEGER NOT NULL DEFAULT 1
  CHECK(material IN (0,1));
ALTER TABLE fact_claims ADD COLUMN normalized_key TEXT;
ALTER TABLE fact_claims ADD COLUMN freshness_days INTEGER;
ALTER TABLE fact_claims ADD COLUMN expires_at TEXT;
ALTER TABLE fact_claims ADD COLUMN conflict_group TEXT;
ALTER TABLE fact_claims ADD COLUMN omission_reason TEXT;
ALTER TABLE fact_claims ADD COLUMN evidence_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE fact_claims ADD COLUMN updated_at TEXT;

CREATE TABLE fact_claim_sources (
  claim_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  support_type TEXT NOT NULL DEFAULT 'supports'
    CHECK(support_type IN ('supports','contradicts','context')),
  excerpt TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(claim_id, source_id, support_type),
  FOREIGN KEY(claim_id) REFERENCES fact_claims(id) ON DELETE CASCADE,
  FOREIGN KEY(source_id) REFERENCES research_sources(id) ON DELETE CASCADE
);

CREATE INDEX idx_fact_claim_sources_source ON fact_claim_sources(source_id, claim_id);
CREATE INDEX idx_fact_claims_freshness ON fact_claims(project_id, status, expires_at);
CREATE INDEX idx_research_sources_url ON research_sources(project_id, url);

INSERT OR IGNORE INTO fact_claim_sources(claim_id, source_id, support_type, excerpt, created_at)
SELECT claim.id, source.id, 'supports', NULL, claim.created_at
FROM fact_claims claim, json_each(claim.source_ids_json) source_id
JOIN research_sources source ON source.id = source_id.value
WHERE source.project_id = claim.project_id;

CREATE TRIGGER accepted_material_claim_insert_requires_staging
BEFORE INSERT ON fact_claims
WHEN NEW.status = 'accepted' AND NEW.material = 1
BEGIN
  SELECT RAISE(ABORT, 'accepted material claim must be staged before source validation');
END;

CREATE TRIGGER accepted_material_claim_requires_source
BEFORE UPDATE OF status ON fact_claims
WHEN NEW.status = 'accepted'
  AND NEW.material = 1
  AND NOT EXISTS (
    SELECT 1
    FROM fact_claim_sources citation
    JOIN research_sources source ON source.id = citation.source_id
    WHERE citation.claim_id = NEW.id
      AND citation.support_type = 'supports'
      AND source.project_id = NEW.project_id
      AND source.status = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'accepted material claim requires an active persisted source');
END;

CREATE TABLE provider_health (
  provider TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('healthy','auth_invalid','quota_exhausted','unavailable')),
  status_code INTEGER,
  message TEXT,
  checked_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
