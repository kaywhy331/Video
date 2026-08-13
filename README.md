# VideoFactory Desktop

**Build:** 0.1.0-alpha.3 production hardening

VideoFactory Desktop is a single-user Windows application that turns a licensed stock-footage metadata catalog into exact-location-grounded YouTube videos. It is metadata-first and fail-closed: it does not silently substitute footage that merely looks similar, upscale a source to pass resolution policy, or publish before the final human gate.

## Current status

The repository is a production-hardened alpha. The application builds and its local automated suite covers database migration, durable project/job state, IPC and path security, sourced web research and claim policy, provider preflight, canonical geographic evidence, scene-specific semantic footage verification, verified-footage final scripts, section narration and word timing, range repair, real FFmpeg analysis/rendering, backup/restore, approval fingerprints, and resumable-upload protocol helpers. It is not yet production-qualified because these external acceptance gates have not been performed:

- clean Windows 10/11 installer and runtime test on a machine without developer tooling;
- five representative 4–6 minute videos completed with real licensed assets;
- live Envato license/download/mapping workflow;
- live Google OAuth, resumable private upload, caption/thumbnail/playlist attachment, processing, scheduling, and publication rehearsal.
- live Tavily research and configured LLM claim-extraction rehearsal against representative topics.
- live Windows SAPI and/or configured HTTP TTS pronunciation/timing rehearsal on representative narration.

`production_ready` therefore remains `false`. See [Implementation Coverage](docs/IMPLEMENTATION-COVERAGE.md), [Production Hardening](docs/PRODUCTION-HARDENING.md), and [Validation Report](VALIDATION_REPORT.md).

## Implemented

- Electron, React, and TypeScript desktop shell with sandboxed renderer
- SQLite/WAL/FTS5 data store with atomic forward migrations and nested savepoints
- XLSX/CSV import, mapping preview, raw-row retention, revisions, and undo
- catalog search, geographic coverage, topic capacity/spend/duplicate gates
- optional Tavily Search/Extract research with real-URL enforcement, app-owned sources, strict cited claim extraction, freshness/conflict omission, and scene claim IDs
- cached provider receipts, persisted auth/quota health, and monthly plus project-snapshot budgets before paid calls
- canonical audited project state machine, durable jobs, dependencies, leases, locks, retries, and restart recovery
- manual Envato handoff, project license attestation, watched downloads, quarantine, and content-addressed originals
- FFprobe inspection, declared/actual conflict evidence, proxies, contact sheets, rotation-aware resolution policy, and FFmpeg black/freeze analysis
- canonical place hierarchy and evidence precedence, configurable contact-sheet vision verification, persisted scene/file receipts, fail-closed provider handling, and operator retry/recovery
- final-script rewrite parented to the provisional version after every scene has verified footage, with immutable lock/audit receipts
- 15–45 second cached narration sections, pronunciation dictionary snapshots, native/provider word timing, and fail-closed timing validation; non-Windows synthetic test audio is explicitly low-confidence
- word-aligned SRT and WebVTT captions plus narration-bound visual shots no longer than seven seconds
- synchronized H.264/AAC-LC render pipeline with scene-fragment cache, explicit scene/range renders, bounded range-repair provenance, two-pass EBU R128 normalization, 30 fps progressive BT.709 output checks, duration QC, and fast-start verification
- approval fingerprints binding final-render and publishing-package inputs
- private-first YouTube workflow with persisted resumable sessions, offset recovery, duplicate-hash guard, processing polling, timed captions, thumbnails, optional playlist, and configurable synthetic-media disclosure
- verified automatic SQLite backups, configurable daily/weekly/monthly retention, restart-safe restore, safety copy, and missing-original report
- allowlisted IPC, top-frame validation, managed-path containment, external URL allowlist, and secret redaction
- power-save blocking during render and upload

## Routine operator actions

1. License and download the assets requested by the Downloads screen.
2. Review the processed private YouTube video and approve publishing or scheduling.

Uncertain mappings, media failures, factual/location conflicts, rights gaps, and quality-policy failures become explicit exceptions.

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
npm run package:win
```

`npm run validate` performs TypeScript checking, the automated test suite, and the production Electron/Vite build. Windows artifacts are written to `release/`. GitHub Actions validates on Linux and builds unsigned Windows NSIS/ZIP artifacts; a successful CI package is not the same as a clean-machine installation test.

## First-run walkthrough

1. In Library, import the footage XLSX or CSV and commit the detected mapping.
2. In Settings, configure storage, backup policy, narrator and pronunciation dictionary, optional Tavily research and LLM, semantic vision provider, and YouTube OAuth.
3. Run diagnostics.
4. Start an Autopilot project.
5. In Downloads, use the displayed Envato project name, license/download each requested asset, and record its license.
6. Let the watcher ingest, analyze, and verify stable files.
7. Render the draft and final video.
8. Upload privately, wait for YouTube processing and attachments, then review and publish or schedule.

The sample catalog is `samples/demo-catalog.csv`. Generate matching synthetic clips with `npm run demo:media`; sample Envato URLs are intentionally non-operational.

## Data and security

Default data is stored under `Documents\VideoFactory` in separate data, ingest, media, projects, output, and backup folders. Originals are stored once by SHA-256 and never overwritten.

The renderer has no Node.js access. IPC inputs are schema-validated, navigation is deny-by-default, only allowlisted Envato/YouTube HTTPS URLs may open, credentials use Electron `safeStorage`, logs redact common secret forms, and uploads begin private.

## Output policy

Default final output is MP4, H.264, AAC-LC stereo at 48 kHz, 1920×1080, 30 fps progressive, yuv420p, BT.709 SDR, with fast-start metadata. Full-screen sources that cannot satisfy 1080p without enlargement fail QC. A qualified 4K final profile remains future work.
