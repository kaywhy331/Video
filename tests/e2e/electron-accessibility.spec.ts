import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import axe from 'axe-core';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let dataRoot: string;

async function launchApp(): Promise<void> {
  app = await electron.launch({
    args: [
      'out/main/index.js',
      '--no-sandbox',
      `--user-data-dir=${join(dataRoot, 'electron-user-data')}`
    ],
    env: {
      ...process.env,
      VIDEOFACTORY_DEV_DATA_ROOT: dataRoot,
      XDG_CONFIG_HOME: join(dataRoot, 'xdg-config'),
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
    }
  });
  page = app.windows()[0] ?? await app.firstWindow();
  await page.getByRole('heading', { name: /Produce the next accurate video/i }).waitFor();
}

interface AxeViolationSummary {
  id: string;
  impact: string | null;
  help: string;
  targets: unknown[];
}

async function seriousAxeViolations(selector?: string): Promise<AxeViolationSummary[]> {
  const hasAxe = await page.evaluate(() => 'axe' in window);
  if (!hasAxe) await page.evaluate(axe.source);
  return page.evaluate(async scanSelector => {
    const runner = (window as unknown as { axe: typeof axe }).axe;
    const context = scanSelector ? document.querySelector(scanSelector) : document;
    if (!context) throw new Error(`Accessibility scan context not found: ${scanSelector}`);
    return (await runner.run(context, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] }
    })).violations
      .filter(item => item.impact === 'serious' || item.impact === 'critical')
      .map(item => ({
        id: item.id,
        impact: item.impact ?? null,
        help: item.help,
        targets: item.nodes.map(node => node.target)
      }));
  }, selector);
}

async function assertNoSeriousAxe(label: string, selector?: string): Promise<void> {
  const violations = await seriousAxeViolations(selector);
  expect(violations, `${label} has serious or critical Axe violations`).toEqual([]);
}

function seedRepresentativeState(paths: { databasePath: string; projectFolder: string }): void {
  const projectsRoot = paths.projectFolder;
  const reviewRoot = join(projectsRoot, 'e2e-review');
  const reviewOutput = join(reviewRoot, 'final.mp4');
  const reviewCaptions = join(reviewRoot, 'final.vtt');
  const reviewManifest = join(reviewRoot, 'manifest.json');
  mkdirSync(reviewRoot, { recursive: true });
  writeFileSync(reviewOutput, 'videofactory-e2e-render');
  writeFileSync(reviewCaptions, 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nAccessible caption fixture.\n');
  writeFileSync(reviewManifest, JSON.stringify({ captions: { vttPath: reviewCaptions } }));

  const db = new DatabaseSync(paths.databasePath);
  db.exec('PRAGMA busy_timeout = 5000');
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    const insertProject = db.prepare(`
      INSERT INTO projects(
        id, sequence, slug, title, topic, description, destination, state, progress,
        envato_project_name, target_duration_ms, script_version_id, final_render_id,
        youtube_video_id, locked_by_job_id, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertProject.run(
      'e2e-project', 1, 'e2e-project', 'E2E accessible project', 'Architecture',
      'A representative project for the operator workspace.', 'Oaxaca',
      'ANALYZING_OPPORTUNITY', 0.42, 'YT-E2E-0001', 300000, 'e2e-script', null,
      'e2e-workspace-video', 'e2e-running-job', now, now
    );
    insertProject.run(
      'e2e-review', 2, 'e2e-review', 'E2E final review project', 'Architecture',
      'A private upload awaiting a manual YouTube Studio action.', 'Oaxaca',
      'AWAITING_MANUAL_STUDIO_ACTION', 0.98, 'YT-E2E-0002', 300000, null,
      'e2e-final-render', 'e2e-studio-video', null, now, now
    );

    db.prepare(`
      INSERT INTO script_versions(
        id, project_id, version_number, title, topic, summary, script_json,
        generation_reason, provider, model, input_hash, locked, script_type, locked_at, created_at
      ) VALUES(?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'final', ?, ?)
    `).run(
      'e2e-script', 'e2e-project', 'A grounded Oaxaca story', 'Architecture',
      'One-scene verified fixture', JSON.stringify({ sections: [{ title: 'Opening' }] }),
      'acceptance_fixture', 'mock', 'fixture', 'e2e-script-hash', now, now
    );
    db.prepare(`
      INSERT INTO research_sources(
        id, project_id, url, title, publisher, accessed_at, summary, source_type,
        content_hash, status
      ) VALUES(?, ?, ?, ?, ?, ?, ?, 'official', ?, 'active')
    `).run(
      'e2e-source', 'e2e-project', 'https://example.com/oaxaca',
      'Oaxaca architecture source', 'Example publisher', now,
      'Grounded reference material for the fixture.', 'e2e-source-hash'
    );
    db.prepare(`
      INSERT INTO fact_claims(
        id, project_id, text, category, confidence, stability, source_ids_json,
        status, material, evidence_json, created_at, updated_at
      ) VALUES(?, ?, ?, 'architecture', 0.99, 'stable', ?, 'verified', 1, ?, ?, ?)
    `).run(
      'e2e-claim', 'e2e-project', 'The selected architecture is documented by the linked source.',
      JSON.stringify(['e2e-source']), JSON.stringify({ verifiedBy: 'fixture' }), now, now
    );

    const insertScene = db.prepare(`
      INSERT INTO project_scenes(
        id, project_id, script_version_id, ordinal, chapter, narration,
        target_duration_ms, required_country, required_city, required_location,
        required_granularity, required_objects_json, required_activities_json,
        preferred_shots_json, visual_treatment, score_explanation_json,
        verification_state, pronunciation_json, start_ms, end_ms, created_at, updated_at
      ) VALUES(?, ?, ?, 1, ?, ?, 5000, 'Mexico', 'Oaxaca', ?, 'location', ?, ?, ?, ?, ?, ?, '{}', 0, 5000, ?, ?)
    `);
    insertScene.run(
      'e2e-scene', 'e2e-project', 'e2e-script', 'Opening',
      'A verified establishing scene introduces the documented architecture.', 'Historic center',
      JSON.stringify(['building']), JSON.stringify(['walking']), JSON.stringify(['wide']),
      'MAP_OR_GRAPHIC', JSON.stringify(['Grounded graphic treatment']), 'verified', now, now
    );
    insertScene.run(
      'e2e-review-scene', 'e2e-review', null, 'Final opening',
      'The reviewed final scene has captions and a local preview.', 'Historic center',
      JSON.stringify(['building']), JSON.stringify([]), JSON.stringify(['wide']),
      'MAP_OR_GRAPHIC', JSON.stringify(['Final review fixture']), 'verified', now, now
    );
    db.prepare('INSERT INTO project_scene_claims(scene_id, claim_id) VALUES(?, ?)')
      .run('e2e-scene', 'e2e-claim');

    db.prepare(`
      INSERT INTO assets(
        id, stable_key, provider, provider_asset_id, canonical_page_url, title,
        description, country, city, location_name, shot_type, declared_duration_ms,
        declared_width, declared_height, orientation, location_granularity,
        location_confidence, verification_status, availability_status, raw_row_json,
        imported_at, updated_at
      ) VALUES(?, ?, 'envato', ?, ?, ?, ?, 'Mexico', 'Oaxaca', 'Historic center',
        'wide', 12000, 3840, 2160, 'landscape', 'landmark', 0.99,
        'human_verified', 'available', '{}', ?, ?)
    `).run(
      'e2e-asset', 'e2e-stable-asset', 'e2e-provider-asset',
      'https://elements.envato.com/e2e-provider-asset', 'Verified Oaxaca establishing shot',
      'A representative licensed catalog asset.', now, now
    );
    db.prepare(`
      INSERT INTO acquisition_items(
        id, project_id, asset_id, ordinal, role, state, license_state, source_url,
        required_scene_ordinals_json, match_score, reasons_json, created_at, updated_at
      ) VALUES(?, ?, ?, 1, 'hero', 'COMPLETE', 'VERIFIED', ?, ?, 98, ?, ?, ?)
    `).run(
      'e2e-acquisition', 'e2e-project', 'e2e-asset',
      'https://elements.envato.com/e2e-provider-asset', JSON.stringify([1]),
      JSON.stringify(['Exact location and verified dimensions']), now, now
    );
    db.prepare(`
      INSERT INTO project_licenses(
        id, project_id, asset_id, license_state, envato_project_name,
        operator_attested_at, verified_at, notes, created_at, updated_at
      ) VALUES(?, ?, ?, 'VERIFIED', ?, ?, ?, ?, ?, ?)
    `).run(
      'e2e-license', 'e2e-project', 'e2e-asset', 'YT-E2E-0001', now, now,
      'Acceptance fixture license evidence.', now, now
    );

    db.prepare(`
      INSERT INTO voice_assets(
        id, project_id, provider, model, voice_id, settings_json,
        pronunciation_hash, input_hash, text, audio_path, timing_path,
        duration_ms, timing_method, status, created_at, updated_at
      ) VALUES(?, ?, 'fixture', 'fixture', 'fixture', '{}', ?, ?, ?, ?, ?, 5000, 'estimated', 'ready', ?, ?)
    `).run(
      'e2e-voice', 'e2e-project', 'e2e-pronunciation-hash', 'e2e-voice-hash',
      'A verified establishing scene introduces the documented architecture.',
      join(projectsRoot, 'e2e-project', 'voice.wav'), null, now, now
    );
    db.prepare(`
      INSERT INTO narration_sections(
        id, project_id, script_version_id, voice_asset_id, ordinal, chapter,
        scene_ids_json, text, pronunciation_json, duration_ms, status, created_at, updated_at
      ) VALUES(?, ?, ?, ?, 1, 'Opening', ?, ?, '{}', 5000, 'ready', ?, ?)
    `).run(
      'e2e-narration', 'e2e-project', 'e2e-script', 'e2e-voice',
      JSON.stringify(['e2e-scene']),
      'A verified establishing scene introduces the documented architecture.', now, now
    );

    db.prepare(`
      INSERT INTO renders(
        id, project_id, kind, profile, state, manifest_path, output_path, sha256,
        duration_ms, width, height, error, created_at, completed_at
      ) VALUES(?, ?, ?, 'landscape_1080p', 'SUCCEEDED', ?, ?, ?, 5000, 1920, 1080, NULL, ?, ?)
    `).run(
      'e2e-workspace-render', 'e2e-project', 'draft', null, reviewOutput,
      'e2e-workspace-render-sha', now, now
    );
    db.prepare(`
      INSERT INTO renders(
        id, project_id, kind, profile, state, manifest_path, output_path, sha256,
        duration_ms, width, height, error, created_at, completed_at
      ) VALUES(?, ?, 'final', 'landscape_1080p', 'SUCCEEDED', ?, ?, ?, 5000, 1920, 1080, NULL, ?, ?)
    `).run(
      'e2e-final-render', 'e2e-review', reviewManifest, reviewOutput,
      'e2e-final-render-sha', now, now
    );
    db.prepare(`
      INSERT INTO qc_results(
        id, project_id, render_id, category, code, severity, status, message,
        evidence_json, created_at
      ) VALUES(?, ?, ?, 'technical', 'FINAL_MEDIA_PROFILE', 'INFO', 'pass', ?, ?, ?)
    `).run(
      'e2e-qc', 'e2e-project', 'e2e-workspace-render',
      'The representative draft satisfies its media profile.', JSON.stringify({ frameRate: 30 }), now
    );

    const insertPackage = db.prepare(`
      INSERT INTO packaging_candidates(
        id, project_id, ordinal, title, angle, viewer_promise, thumbnail_path,
        description, chapters, tags_json, risk_status, selected, created_at
      ) VALUES(?, ?, 1, ?, ?, ?, NULL, ?, ?, ?, 'safe', 1, ?)
    `);
    insertPackage.run(
      'e2e-package', 'e2e-project', 'Oaxaca Architecture', 'Grounded overview',
      'A concise verified tour.', 'Fixture description', '00:00 Opening',
      JSON.stringify(['Oaxaca', 'architecture']), now
    );
    insertPackage.run(
      'e2e-review-package', 'e2e-review', 'Oaxaca Architecture Final', 'Final grounded overview',
      'A finished, captioned verified tour.', 'Final fixture description', '00:00 Opening',
      JSON.stringify(['Oaxaca', 'architecture']), now
    );

    const insertPublication = db.prepare(`
      INSERT INTO publication_records(
        id, project_id, video_id, privacy_status, final_sha256, processing_status,
        selected_package_id, caption_id, thumbnail_uploaded, error, created_at, updated_at
      ) VALUES(?, ?, ?, 'private', ?, 'succeeded', ?, 'e2e-caption', 1, ?, ?, ?)
    `);
    insertPublication.run(
      'e2e-publication', 'e2e-project', 'e2e-workspace-video',
      'e2e-workspace-publication-sha', 'e2e-package', null, now, now
    );
    insertPublication.run(
      'e2e-review-publication', 'e2e-review', 'e2e-studio-video',
      'e2e-review-publication-sha', 'e2e-review-package',
      'Publishing is restricted to the exact Studio editor.', now, now
    );
    db.prepare(`
      INSERT INTO analytics_snapshots(
        id, project_id, video_id, snapshot_day, metrics_json, retention_json,
        collected_at, captured_at, source, source_hash
      ) VALUES(?, ?, ?, 7, ?, ?, ?, ?, 'manual_import', ?)
    `).run(
      'e2e-analytics', 'e2e-project', 'e2e-workspace-video',
      JSON.stringify({ views: 1200, averagePercentageViewed: 0.61 }),
      JSON.stringify([{ elapsedRatio: 0, audienceWatchRatio: 1 }]),
      now, now, 'e2e-analytics-hash'
    );

    db.prepare(`
      INSERT INTO exceptions(
        id, project_id, severity, stage, code, title, message, evidence_json,
        recommended_action, safe_alternatives_json, status, created_at
      ) VALUES(?, ?, 'MEDIUM', 'review', ?, ?, ?, ?, ?, ?, 'OPEN', ?)
    `).run(
      'e2e-resolve-exception', 'e2e-project', 'E2E_OPERATOR_REVIEW',
      'Confirm representative warning', 'This warning is safe for an operator to acknowledge.',
      JSON.stringify({ fixture: true }), 'Review the evidence and resolve the warning.',
      JSON.stringify(['Leave the warning open']), now
    );
    db.prepare(`
      INSERT INTO exceptions(
        id, project_id, severity, stage, code, title, message, evidence_json,
        recommended_action, safe_alternatives_json, status, created_at
      ) VALUES(?, ?, 'LOW', 'review', ?, ?, ?, ?, ?, ?, 'OPEN', ?)
    `).run(
      'e2e-override-exception', 'e2e-project', 'E2E_OVERRIDE_REVIEW',
      'Record a reasoned override', 'This low-risk fixture permits a reasoned override.',
      JSON.stringify({ fixture: true }), 'Record why proceeding is safe.',
      JSON.stringify(['Resolve without overriding']), now
    );
    db.prepare(`
      INSERT INTO audit_log(
        project_id, action, actor, entity_type, entity_id, metadata_json, created_at
      ) VALUES(?, 'fixture.created', 'system', 'project', ?, ?, ?)
    `).run('e2e-project', 'e2e-project', JSON.stringify({ representative: true }), now);
    db.prepare(`
      INSERT INTO audit_log(
        project_id, action, actor, entity_type, entity_id, metadata_json, created_at
      ) VALUES(?, 'youtube.studio_fallback', 'system', 'publication', ?, ?, ?)
    `).run(
      'e2e-review', 'e2e-review-publication',
      JSON.stringify({ studioUrl: 'https://studio.youtube.com/video/e2e-studio-video/edit' }), now
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
}

function initializeDatabase(databasePath: string): void {
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  const db = new DatabaseSync(databasePath);
  const migrationRoot = join(process.cwd(), 'src', 'main', 'database');
  for (const name of readdirSync(migrationRoot).filter(item => /^\d{3}_.+\.sql$/.test(item)).sort()) {
    db.exec(readFileSync(join(migrationRoot, name), 'utf8'));
    db.prepare('INSERT OR IGNORE INTO schema_migrations(version, name) VALUES(?, ?)').run(
      Number(name.slice(0, 3)),
      name.replace(/^\d{3}_|\.sql$/g, '')
    );
  }
  db.close();
}

test.beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'videofactory-electron-e2e-'));
  const paths = {
    databasePath: join(dataRoot, 'data', 'videofactory.sqlite'),
    projectFolder: join(dataRoot, 'projects')
  };
  initializeDatabase(paths.databasePath);
  seedRepresentativeState(paths);
  await launchApp();
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true });
});

test('[SEC-001][SEC-008] boots the isolated production renderer and scans every primary view', async () => {
  await expect(page.getByRole('heading', { name: 'Operations health' })).toBeVisible();
  await expect(page.getByText('API budget', { exact: true })).toBeVisible();
  await expect(page.getByText('Media worker', { exact: true })).toBeVisible();
  await expect(page.getByText('Render', { exact: true })).toBeVisible();
  await expect(page.getByText('Upload', { exact: true })).toBeVisible();

  const isolation = await page.evaluate(() => ({
    require: typeof (window as unknown as { require?: unknown }).require,
    process: typeof (window as unknown as { process?: unknown }).process,
    electron: typeof (window as unknown as { electron?: unknown }).electron
  }));
  expect(isolation).toEqual({ require: 'undefined', process: 'undefined', electron: 'undefined' });
  const contentSecurityPolicy = await page.locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute('content');
  expect(contentSecurityPolicy).toContain("script-src 'self'");
  expect(contentSecurityPolicy).toContain("object-src 'none'");
  expect(contentSecurityPolicy).not.toMatch(/script-src[^;]*(?:https?:|'unsafe-eval')/);

  const resume = page.getByRole('button', { name: /Resume new Autopilot projects/i }).first();
  await resume.click();
  await expect(page.getByRole('button', { name: /Pause new Autopilot projects/i }).first()).toBeVisible();
  await page.getByRole('button', { name: /Pause new Autopilot projects/i }).first().click();
  await expect(page.getByRole('button', { name: /Resume new Autopilot projects/i }).first()).toBeVisible();

  for (const view of ['Autopilot', 'Downloads', 'Final Review', 'Library', 'Analytics', 'Settings', 'Exceptions']) {
    const navigation = page.getByRole('button', { name: new RegExp(`^${view}`) }).first();
    await navigation.click();
    await expect(navigation).toHaveClass(/nav-active/);
    await assertNoSeriousAxe(`${view} view`);
  }
});

test('[UX-002][PERF-004] exposes deferred pause state and accessible evidence on every project tab', async () => {
  test.slow();
  await page.getByRole('button', { name: 'Autopilot', exact: true }).click();

  await page.getByRole('button', { name: /E2E accessible project/i }).click();
  await expect(page.getByRole('complementary', { name: 'Project detail workspace' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pause at checkpoint' })).toBeVisible();
  await page.getByRole('button', { name: 'Pause at checkpoint' }).click();
  await expect(page.getByRole('button', { name: 'Pause requested' })).toBeDisabled();
  await expect(page.getByRole('complementary', { name: 'Project detail workspace' })
    .getByText('42%', { exact: true })).toBeVisible();
  await assertNoSeriousAxe('project overview with deferred pause', '[aria-label="Project detail workspace"]');

  const tabs = page.getByRole('tab');
  await expect(tabs).toHaveCount(9);
  await tabs.filter({ hasText: 'Overview' }).focus();
  await page.keyboard.press('End');
  await expect(tabs.filter({ hasText: 'Audit log' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Home');
  await expect(tabs.filter({ hasText: 'Overview' })).toHaveAttribute('aria-selected', 'true');

  const tabEvidence = [
    ['Research', 'Oaxaca architecture source'],
    ['Script & coverage', 'A grounded Oaxaca story'],
    ['Storyboard', 'Storyboard recovery'],
    ['Assets / licenses', 'Verified Oaxaca establishing shot'],
    ['Voice / audio', 'Final narration (1)'],
    ['Renders / QC', 'FINAL MEDIA PROFILE'],
    ['Publishing / analytics', 'Day 7 · e2e-workspace-video'],
    ['Audit log', 'project.pause requested']
  ] as const;
  const tabViolations: Array<{ tab: string; violations: AxeViolationSummary[] }> = [];
  for (const [name, evidence] of tabEvidence) {
    await tabs.filter({ hasText: name }).click();
    await expect(tabs.filter({ hasText: name })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText(evidence, { exact: false }).first()).toBeVisible();
    const violations = await seriousAxeViolations('[aria-label="Project detail workspace"]');
    if (violations.length) tabViolations.push({ tab: name, violations });
  }
  expect(tabViolations, 'project tabs have serious or critical Axe violations').toEqual([]);
  await page.getByRole('button', { name: 'Close project details' }).click();

  const receipt = await page.evaluate(async () => {
    const project = await window.videoFactory.projects.get('e2e-project');
    const audit = project.auditLog.find(item => item.action === 'project.pause_requested');
    return {
      pending: project.pendingLifecycleAction,
      action: audit?.action,
      metadata: audit?.metadata
    };
  });
  expect(receipt.pending).toBe('pause');
  expect(receipt.action).toBe('project.pause_requested');
  expect(receipt.metadata).toMatchObject({
    activeJobId: 'e2e-running-job',
    applyAt: 'next_job_checkpoint'
  });
});

test('resolves and overrides permitted exceptions through the UI with immutable audit receipts', async () => {
  await page.keyboard.press('Control+Alt+E');
  await expect(page.getByRole('heading', { name: /Review only the problems/i })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('Confirm representative warning', { exact: true })).toBeVisible();
  await assertNoSeriousAxe('populated exception inbox');

  const resolveCard = page.getByText('Confirm representative warning', { exact: true }).locator('..').locator('..').locator('..');
  await resolveCard.getByRole('button', { name: 'Resolve' }).click();
  await expect(page.getByText('Confirm representative warning', { exact: true })).toHaveCount(0);

  const overrideCard = page.getByText('Record a reasoned override', { exact: true }).locator('..').locator('..').locator('..');
  await overrideCard.getByLabel('Reasoned override').fill('The fixture evidence was reviewed and is safe to proceed.');
  await overrideCard.getByRole('button', { name: 'Override with audit' }).click();
  await expect(page.getByText('No open exceptions', { exact: true })).toBeVisible();
  await assertNoSeriousAxe('resolved exception inbox');

  const receipts = await page.evaluate(async () => {
    const records = await window.videoFactory.exceptions.list({ openOnly: false });
    return records
      .filter(record => ['e2e-resolve-exception', 'e2e-override-exception'].includes(record.id))
      .map(record => {
        const audit = record.auditTrail.find(item => item.entityId === record.id);
        return { id: record.id, action: audit?.action, actor: audit?.actor, metadata: audit?.metadata };
      })
      .sort((left, right) => left.id.localeCompare(right.id));
  });
  expect(receipts.map(row => ({ id: row.id, action: row.action, actor: row.actor }))).toEqual([
    { id: 'e2e-override-exception', action: 'exception.overridden', actor: 'human' },
    { id: 'e2e-resolve-exception', action: 'exception.resolved', actor: 'operator' }
  ]);
  expect(receipts[0]!.metadata).toMatchObject({
    method: 'operator_override',
    reason: 'The fixture evidence was reviewed and is safe to proceed.'
  });
});

test('[YT-006][SEC-006] renders the exact Studio fallback and serves only recorded local review media', async () => {
  await page.getByRole('button', { name: 'Final Review', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Review the finished video/i })).toBeVisible();
  await expect(page.getByText('Complete the approved action in YouTube Studio', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open exact Studio video' })).toBeVisible();
  await expect(page.locator('video[src="videofactory://render/e2e-final-render"]')).toHaveCount(1);
  await expect(page.locator('track[src="videofactory://caption/e2e-final-render"]')).toHaveCount(1);

  const protocol = await app.evaluate(async ({ net }) => {
    const render = await net.fetch('videofactory://render/e2e-final-render');
    const caption = await net.fetch('videofactory://caption/e2e-final-render');
    const missing = await net.fetch('videofactory://render/not-recorded');
    return {
      render: { status: render.status, body: await render.text() },
      caption: {
        status: caption.status,
        contentType: caption.headers.get('content-type'),
        body: await caption.text()
      },
      missing: { status: missing.status, body: await missing.text() }
    };
  });
  expect(protocol.render).toEqual({ status: 200, body: 'videofactory-e2e-render' });
  expect(protocol.caption).toMatchObject({
    status: 200,
    contentType: 'text/vtt; charset=utf-8'
  });
  expect(protocol.caption.body).toContain('Accessible caption fixture.');
  expect(protocol.missing).toEqual({ status: 404, body: 'Media not found.' });
  await assertNoSeriousAxe('manual Studio final review');
});
