# VideoFactory Desktop

**Build:** 0.1.0-alpha.6 packaged Windows lifecycle smoke

VideoFactory Desktop is a single-user Windows application that turns a licensed stock-footage metadata catalog into exact-location-grounded YouTube videos. It is metadata-first and fail-closed: it does not silently substitute footage that merely looks similar, upscale a source to pass resolution policy, or publish before the final human gate.

## Current status

The repository is a production-hardened alpha with the local P0 buildout and bounded P1 operations/analytics foundations implemented and tested. The automated suite covers migrations through 018, checkpoint-safe deferred pause, task-aware graceful quit/drain, a DB-backed global final-render lease, workflow-locked manual/private uploads, remount-safe catalog progress/cancellation, staged catalog evidence workflows, worker-backed catalog import, atomic project licensing, immutable Guided-script provenance, managed interrupted-render cleanup, durable automatic project/job/render recovery, exact Final Review revision routing and per-scene audit, a complete keyboard-accessible nine-tab project workspace, a three-pane workflow-locked storyboard recovery editor, manifest-authorized active-final captions, actionable and audited exceptions, Autopilot operations health, IPC and media-protocol security, sourced research and provider policy, canonical geography, semantic footage verification, verified-footage scripts and narration, perceptual global matching, HDR/log fail-closed color handling, deterministic editing, crop-qualified 1080p/4K/portrait output profiles, licensed-music mixing, render/package QC, bounded repair, portable export/rebuild, cadence scheduling, five-checkpoint retention analytics, reversible learning, and resumable-upload protocol helpers. Repeatable 26,000-row receipts cover production catalog counts/search and main-process responsiveness while worker operations run. The acceptance receipt maps all 151 PRD IDs: 136 have report-bound local assertions and 15 remain external qualification gates. It is not yet production-qualified because these gates have not been performed:

- clean Windows 10/11 installer and runtime test on a machine without developer tooling;
- five representative 4–6 minute videos completed with real licensed assets;
- live Envato license/download/mapping workflow;
- live Google OAuth, resumable private upload, caption/thumbnail/playlist attachment, processing, scheduling, and publication rehearsal.
- live Google Sheets and YouTube Analytics collection with the configured OAuth scopes;
- live Tavily research and configured LLM claim-extraction rehearsal against representative topics.
- live Windows SAPI and/or configured HTTP TTS pronunciation/timing rehearsal on representative narration.
- representative licensed-music, qualified-4K/portrait, and unattended scheduler rehearsals.
- recorded Electron renderer startup, real scrolling/interaction and memory behavior, and responsiveness while rendering in the background; the worker-backed import/main-loop harness does not qualify those renderer boundaries.

`production_ready` therefore remains `false`. See [Implementation Coverage](docs/IMPLEMENTATION-COVERAGE.md), [Production Hardening](docs/PRODUCTION-HARDENING.md), [Validation Report](VALIDATION_REPORT.md), and the machine-readable [acceptance receipt](VALIDATION_ACCEPTANCE_RECEIPT.json).

## Implemented

- Electron, React, and TypeScript desktop shell with sandboxed renderer
- SQLite/WAL/FTS5 data store with 18 atomic forward migrations, nested savepoints, composite catalog-search indexes, immutable Guided-input provenance, deferred lifecycle intent at active-job checkpoints, and source/package migration-parity preflight
- worker-thread XLSX/CSV/Google Sheets staging with progress, cooperative cancellation, responsive status/ping, mapping preview, duplicate/raw-row retention, source-scoped missing detection, atomic commit/rollback, validation-gated refresh, revisions, undo, cached facets, and paginated search; checked-in 26K receipts cover warm-search and main-process responsiveness while the import worker runs
- layered raw/normalized/AI/human metadata evidence, review inbox, bulk edits, audited place merge/split, filtered checksummed export, and catalog search
- explainable topic scoring from labeled native/proxy evidence plus geographic coverage, capacity, spend, and duplicate gates; bounded Guided starting text is immutable guidance, never evidence, and only its hash plus safe editorial signals reach the language provider
- optional Tavily Search/Extract research with real-URL enforcement, app-owned sources, strict cited claim extraction, freshness/conflict omission, and scene claim IDs
- cached provider receipts, persisted auth/quota health, and monthly plus project-snapshot budgets before paid calls
- canonical audited project state machine, WorkflowService-owned automatic continuation, durable jobs, dependencies, leases, locks, retries, restart recovery, deterministic stale-render reconciliation with managed-only partial-output cleanup, and audited pause/resume/cancel/archive controls
- manual Envato handoff, atomic project attestation/certificate upgrades, terminal license-decision protection, watched downloads, quarantine, and content-addressed originals; ingest never silently implies licensing
- FFprobe inspection, declared/actual conflict evidence, proxies, contact sheets, rotation-aware resolution policy, FFmpeg black/freeze analysis, and versioned SDR/HDR/log policy that tone-maps approved PQ/HLG or blocks ambiguous input
- canonical place hierarchy and evidence precedence, configurable contact-sheet vision verification, persisted scene/file receipts, fail-closed provider handling, and operator retry/recovery
- final-script rewrite parented to the provisional version after every scene has verified footage, with immutable lock/audit receipts
- three-pane storyboard recovery with persisted candidate/evidence comparison, verified replacement/rejection, claim-safe narration rewrite, evidence-bound map/text fallback, split/merge, complete human-location re-verification, immutable operator versions, and affected-range regeneration
- complete nine-tab project workspace covering overview, research, script/coverage, storyboard, rights, voice/audio, render/QC, publishing/analytics, and audit evidence
- exception inbox with project context, safe alternatives, server-authoritative retry/resolve, reasoned safe override, and durable action history
- Autopilot new-project pause/resume controls—with active work continuing to its next safe gate—plus exact monthly spend, disk threshold, provider health, and media/render/upload worker state
- discoverable `Ctrl+Alt+D/R/A/P/E` operator shortcuts with deterministic open-project targeting, editable-control protection, visible keyboard focus, narrow-screen storyboard reflow, and manifest-authorized default WebVTT captions in local final review
- 15–45 second cached narration sections, pronunciation dictionary snapshots, native/provider word timing, fail-closed timing validation, and affected-section-only pronunciation revision; non-Windows synthetic test audio is explicitly low-confidence
- word-aligned SRT and WebVTT captions plus narration-bound visual shots no longer than seven seconds
- evidence-bound generated map/text cards and deterministic ASS layers for location labels, chapter cards, lower thirds, channel logo, and sourced data callouts; coordinate plots require persisted coordinates and otherwise identify themselves as schematic
- synchronized H.264/AAC-LC render pipeline with scene-fragment cache, explicit scene/range renders, bounded range/alternate repair provenance, output black/freeze/crop/reuse/audio/caption/location checks, two-pass EBU R128 normalization, 30 fps progressive BT.709 output checks, duration QC, and fast-start verification
- crop-qualified landscape 1080p, qualified 4K, and portrait output profiles with immutable project snapshots and truthful scene-specific 4K fallback evidence
- content-addressed licensed-music import and project snapshots, narration-sidechain ducking, bounded fades, loudness normalization, rights checks, and derivative cleanup that preserves originals and music
- final-timeline chapter generation, three evidence-bounded packages, 1280×720 JPEG thumbnails verified under the 2 MB upload limit, and exact seven-way durable revision routing before final approval
- approval fingerprints binding final-render and publishing-package inputs
- private-first YouTube workflow with persisted resumable sessions, offset recovery, duplicate-hash guard, automatic upload/processing continuation, processing polling, timed captions, thumbnails, optional playlist, configurable synthetic-media disclosure, and a mandatory final publish/schedule/Keep private gate
- verified automatic SQLite backups, configurable daily/weekly/monthly retention, restart-safe restore, safety copy, missing-original report, and restore-time proxy/contact-sheet/editing/caption derivative regeneration
- checksummed project export with scripts, sources, claims, scene contracts, rights/file references, voice/timing, captions, render/QC/package/publication records, optional originals, and optional final output
- allowlisted IPC, top-frame validation, managed-path containment, external URL allowlist, and secret redaction
- power-save blocking during render and upload
- secret-free settings-profile transfer, release discovery without self-install, persisted executable/storage/database/encoder diagnostics, and durable cadence scheduling
- exactly five YouTube Analytics checkpoints at days 1/3/7/28/90 after confirmed public visibility, collection receipts, final-manifest retention mapping, minimum-evidence learning recommendations with human apply/reject/rollback, and bounded read-only Google Sheets catalog staging in the cancellable catalog worker
- channel/language/provider/output registries that distinguish configured, available, and externally qualified capabilities

## Routine operator actions

1. License and download the assets requested by the Downloads screen.
2. Review the processed private YouTube video and approve publishing or scheduling.

Uncertain mappings, media failures, factual/location conflicts, rights gaps, and quality-policy failures become explicit exceptions. Ambiguous mappings cannot be acknowledged away; they close only after a candidate is successfully ingested and mapped.

## Development

Prerequisites:

- Node.js 22.12+ LTS or Node.js 24
- npm 10+
- Windows 10/11 for Windows SAPI narration and target-platform testing

FFmpeg and FFprobe are included through static packages. Paths can be overridden in Settings.

```powershell
npm ci
npm run doctor
npm run dev
```

On Windows, fully extract the repository and run `RUN-ON-WINDOWS.cmd`. The launcher preserves errors in `VideoFactory-Last-Startup.log`.

## Validation and packaging

```powershell
npm run validate
npm run doctor
npm run benchmark:catalog
npm run benchmark:catalog:responsiveness
npm run security:audit
npm run security:sbom
npm run package:win
.\scripts\windows\test-packaged-app.ps1
npm run release:manifest -- --require-validation --require-package-smoke
npm run release:verify
```

`npm run validate` performs TypeScript checking, the automated test suite, the production Electron/Vite build, built-application Playwright/Axe accessibility and keyboard journeys, the zero-advisory dependency audit, CycloneDX SBOM generation, and acceptance-receipt generation. Windows artifacts are written to `release/` with canonical upload-safe names in the form `VideoFactory-Desktop-<version>-<arch>.<ext>`. GitHub Actions packages Windows only after the exact commit passes validation, expands and launches the ZIP, silently installs/launches/uninstalls the NSIS package with isolated data, attaches the receipt/status/test reports/SBOM, and writes an exact artifact manifest plus `SHA256SUMS.txt`. The manifest rejects a missing, failed, stale, or artifact-mismatched package-smoke receipt. Branch builds record their ref without claiming a release tag; tag builds must exactly match the package version. This hosted-runner smoke is supporting package evidence, not code signing or a clean-machine installation qualification.

`npm run benchmark:catalog` generates a real 26,000-row XLSX, runs production catalog preview/commit, reopens the database, executes 25 rounds of five common paginated searches, checks integrity and row counts, and writes `VALIDATION_CATALOG_PERFORMANCE.json`. The current receipt is a service-level benchmark, not an Electron UI responsiveness qualification, and takes roughly ten minutes on the recorded i5-6300U environment.

`npm run benchmark:catalog:responsiveness` builds the production worker, streams a 26,000-row Sheets-style snapshot through it, previews and atomically commits a real XLSX, exercises cancellation/managed cleanup, measures the main-loop heartbeat and `catalog:ping`, checks row count and SQLite integrity, and writes `VALIDATION_CATALOG_RESPONSIVENESS.json`. It qualifies the main-process service boundary, not renderer startup, scrolling, memory, or concurrent-render behavior.

## First-run walkthrough

1. In Library, import the footage XLSX or CSV and commit the detected mapping.
2. In Settings, configure storage, backup policy, narrator and pronunciation dictionary, optional Tavily research and LLM, semantic vision provider, and YouTube OAuth.
3. Run diagnostics.
4. Start an Autopilot project.
5. In Downloads, use the displayed Envato project name, license/download each requested asset, and record its license.
6. Let the watcher ingest, analyze, and verify stable files.
7. If an exception needs editorial recovery, use the project Storyboard workspace to compare verified candidates, rewrite or restructure the beat, choose an evidence-bound graphic, and regenerate the affected range.
8. Let the workflow automatically finalize the verified script, generate narration, render/QC, upload privately, and wait for YouTube processing.
9. Review the finished private video, then publish, schedule, request one of the seven revision types, or keep it private.

The sample catalog is `samples/demo-catalog.csv`. Generate matching synthetic clips with `npm run demo:media`; sample Envato URLs are intentionally non-operational.

## Data and security

Default data is stored under `Documents\VideoFactory` in separate data, ingest, media, projects, output, and backup folders. Originals are stored once by SHA-256 and never overwritten.

The renderer has no Node.js access. IPC inputs are schema-validated, navigation is deny-by-default, only allowlisted Envato/YouTube HTTPS URLs may open, credentials use Electron `safeStorage`, logs redact common secret forms, and uploads begin private. Dependency audit, lockfile, SBOM, and response requirements are recorded in [Dependency Security](docs/DEPENDENCY-SECURITY.md).

## Output policy

Default final output is MP4, H.264, AAC-LC stereo at 48 kHz, 1920×1080, 30 fps progressive, yuv420p, BT.709 SDR, with fast-start metadata. Production renders currently use software `libx264`; NVENC, QSV, and AMF encoders are detected and test-encoded only for diagnostics and are not selected for production rendering. Full-screen sources must retain enough pixels after aspect crop and cannot be enlarged to pass policy. Qualified 4K is available only when every footage scene passes the 3840×2160 crop gate; otherwise the final render falls back truthfully to 1080p with exact blockers. A 1080×1920 portrait profile is registered and crop-qualified, but representative vertical production remains externally unqualified.
