# Implementation Coverage

Updated 2026-08-12 after the local P0 editing, QC, packaging, export, and derivative-rebuild milestone.

Status meanings:

- **Implemented + tested:** code exists and has local automated coverage.
- **Implemented, external validation pending:** code exists but requires target platform, credentials, accounts, or real licensed media.
- **Partial:** a useful bounded implementation exists, but the full PRD requirement is not complete.
- **Not implemented:** no production implementation is claimed.

## Production path

| Capability | Status | Evidence / boundary |
|---|---|---|
| Desktop shell and sandbox | Implemented + tested | Electron/Vite production bundle, IPC/security tests |
| Clean Windows install/runtime | Implemented, external validation pending | CI builds unsigned NSIS/ZIP; clean-machine launch remains unrun |
| SQLite schema and migration | Implemented + tested | Migrations 001–007, integrity, parity, and reopen/idempotency tests |
| Catalog XLSX/CSV import and search | Implemented + tested | Existing import/normalization/geography tests; 26K-row UI performance not benchmarked |
| Metadata revisions and undo | Implemented + tested | Revision persistence and UI; bulk edit/merge/split/export remain partial |
| Geographic evidence model | Partial | Canonical hierarchy, parent-aware lookup, imported/vision/human assertions, evidence precedence, and exact-location hard gates are implemented; geocoder/coordinate and broader alias workflows remain |
| Topic opportunity engine | Partial | Explainable catalog coverage, queue, spend, and duplicate gates; live demand/competition adapters absent |
| Research and fact pack | Implemented, external validation pending | Configurable Tavily Search/Extract, real-URL/app-owned source records, strict claim extraction, unknown-ID rejection, relational citations, category freshness, conflict/stale omission, scene claim IDs, and explicit conflict exceptions; live provider rehearsal unrun |
| Script/storyboard pipeline | Implemented + tested | Locked provisional scripts are parented by immutable final versions rewritten only after verified footage; app-issued scene/claim/pronunciation constraints and audit receipts are enforced |
| Acquisition and licensing | Implemented, external validation pending | Manual Envato handoff and project attestation; live account workflow unrun |
| Media ingest and verification | Implemented, external validation pending | Hashing, quarantine, FFprobe, conflict evidence, proxy/contact-sheet creation, black/freeze analysis, rotation/no-upscale gates, scene-specific contact-sheet semantic verification, strict provider receipts, explicit retry, startup recovery, and bounded verified-alternate repair; representative real-format/Envato rehearsal remains external |
| Narration | Implemented, external validation pending | 15–45 second immutable section cache, pronunciation snapshots, Windows SAPI timing events, generic HTTP TTS adapter, word-timing validation, changed-section reuse, and low-confidence development fallback; live representative voice qualification unrun |
| Captions | Implemented + tested | Word-timed, bounded, nonoverlapping SRT and WebVTT generation plus QC |
| Editing and graphics | Implemented + tested | Deterministic evidence-bound ASS layers for coordinate/schematic map cards, text/archival cards, location labels, chapter cards, lower thirds, channel logo, and sourced callouts; real FFmpeg generated-graphic fixture |
| Render and media QC | Implemented + tested | Real FFmpeg footage/graphic/final fixtures, word-bound cuts, safe crop/no-upscale behavior, output black/freeze/reuse/crop/resolution/letterbox/clipping/silence/caption/location checks, fragment cache, scene/range mode, and ordinal-bearing bounded range/alternate repair |
| Packaging/final review | Implemented + tested | Three evidence-bounded packages, final-timeline chapters, actual-frame 1280×720 JPEG thumbnails under 2 MB, package/description/chapter QC before blocker routing, and approval fingerprint |
| YouTube private-first publishing | Implemented, external validation pending | Persisted resumable session protocol, duplicate guard, polling/attachment receipts; live OAuth/API rehearsal unrun |
| Durable project/job recovery | Implemented + tested | Canonical transitions, fail-closed blocked state, audits, dependencies, leases, stale-process recovery, project locks |
| Backup/restore/retention and export | Implemented + tested | Scheduled verified backups, configurable rotation, staged restore/safety copy, original hash verification, persisted restore rebuild receipts, deterministic proxy/contact-sheet/voice-timing/editing/caption regeneration, and checksummed secret-redacted project exports with optional originals/final output |
| Cost/quota controls | Implemented + tested | Cached calls are exempt; call receipts, monthly and project-snapshot hard budgets, and persisted auth/quota preflight cover research, LLM, vision, and HTTP TTS adapters; live quota behavior remains an external qualification gate |
| Analytics learning loop | Not implemented | P1 per PRD |

## Automated test coverage added in alpha.3

- canonical project transitions and fail-closed blocked-project behavior;
- nested SQLite transactions and real migration wrapper;
- job dependency/cycle/lock/restart behavior;
- backup integrity, cadence, retention, restore, and missing originals;
- IPC contracts, sender/path/URL security, and secret redaction;
- media analysis parsing and real FFmpeg fixtures;
- narration splitting and source-duration fail-closed rules;
- render concat ordering and two-pass output profile checks;
- approval fingerprints, final-review gates, resumable-upload ranges, and caption reuse;
- planning capacity, spend, coverage, and duplicate-topic gates;
- ranked shot-candidate persistence, residual-risk alternate planning, late-bound geography/license/file/media checks, bounded alternate promotion, QC repair classification, and artifact-versioned retry/exhaustion;
- canonical place hierarchy/assertion precedence, strict contact-sheet-only vision contracts, cache and malformed-response handling, semantic receipt gates, explicit provider retry, and legacy alternate re-verification.
- Tavily search/extract contract validation and cache receipts, app-issued source/claim linkage, strict one-retry claim extraction, stale/conflict/invented-source omission, and database-enforced accepted-claim citations;
- project budget/policy snapshots and centralized monthly, per-project, auth, and quota preflight across research, language, and vision calls.
- verified-footage final-script parentage/locking, app-issued scene IDs, pronunciation snapshots, section cache reuse, monotonic word timing, word-derived captions, and fail-closed HTTP TTS receipts;
- render-fragment identity, real FFmpeg full-to-range cache reuse, explicit bounded range contracts, range repair provenance, and reassembly into a new full final artifact.
- evidence-bound editing-plan identity, ASS layer generation, footage overlays, coordinate-backed generated graphics, and explicit schematic fallback without invented map geometry;
- final-output black/freeze, duplicate-range, crop/effective-resolution/letterbox, clipping/silence, caption, required-label, geographic-evidence, and rights checks with affected ordinals;
- real final-render integration that generates three timeline-derived packages and thumbnails, passes package QC, and reaches the final approval state;
- migration 007 portability receipts, byte-verified project export with resumable-session redaction, and deterministic real-FFmpeg proxy/contact-sheet plus timing/editing/caption rebuild.

## Production qualification gates

Promotion beyond alpha requires recorded evidence for all of the following:

1. Clean Windows 10/11 install and runtime without Node or developer tooling.
2. Five representative 4–6 minute real videos, with at least four requiring no routine editing beyond acquisition and final approval.
3. Project-specific licenses for every used real asset.
4. Live Envato download/mapping rehearsal, including ambiguity and failed-media cases.
5. Live YouTube OAuth/resumable upload/thumbnail/caption/playlist/processing/publish-or-schedule rehearsal without duplicate upload.
6. Forced-restart drills during ingest, render, and upload.
7. Backup/restore drill on representative production data.
8. Completion or explicit release-scope disposition of remaining P0 partial items above.
9. Live Tavily and language-model research rehearsal with representative fresh, stale, conflicting, malformed, auth-failed, and quota-exhausted cases.
10. Live Windows SAPI or configured HTTP TTS rehearsal covering representative place pronunciations, timing, cache reuse, malformed timing, auth, and quota behavior.
