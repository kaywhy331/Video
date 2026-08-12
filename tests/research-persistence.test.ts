import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase } from '@main/database/database';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('research citation persistence', () => {
  it('permits acceptance only after a same-project active source citation exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'videofactory-research-persistence-'));
    roots.push(root);
    const db = new AppDatabase(join(root, 'db.sqlite'));
    const now = new Date().toISOString();
    const insertProject = db.raw.prepare(`INSERT INTO projects(id, sequence, slug, title, topic, state, progress, envato_project_name, target_duration_ms, created_at, updated_at) VALUES(?, ?, ?, ?, ?, 'RESEARCHING', 0, ?, 1000, ?, ?)`);
    insertProject.run('p1', 1, 'p1', 'P1', 'P1', 'YT-P1', now, now);
    insertProject.run('p2', 2, 'p2', 'P2', 'P2', 'YT-P2', now, now);
    db.raw.prepare(`INSERT INTO research_sources(id, project_id, url, title, accessed_at, status) VALUES('s1', 'p1', 'https://example.test', 'Source', ?, 'active')`).run(now);
    db.raw.prepare(`INSERT INTO fact_claims(id, project_id, text, category, confidence, stability, source_ids_json, status, created_at) VALUES('c1', 'p1', 'Supported', 'other', 1, 'stable', '["s1"]', 'proposed', ?)`).run(now);
    db.raw.prepare(`INSERT INTO fact_claim_sources(claim_id, source_id, support_type, created_at) VALUES('c1', 's1', 'supports', ?)`).run(now);
    expect(db.raw.prepare(`UPDATE fact_claims SET status = 'accepted' WHERE id = 'c1'`).run().changes).toBe(1);

    db.raw.prepare(`INSERT INTO fact_claims(id, project_id, text, category, confidence, stability, source_ids_json, status, created_at) VALUES('c2', 'p2', 'Cross project', 'other', 1, 'stable', '["s1"]', 'proposed', ?)`).run(now);
    db.raw.prepare(`INSERT INTO fact_claim_sources(claim_id, source_id, support_type, created_at) VALUES('c2', 's1', 'supports', ?)`).run(now);
    expect(() => db.raw.prepare(`UPDATE fact_claims SET status = 'accepted' WHERE id = 'c2'`).run()).toThrow('active persisted source');
    db.close();
  });
});
