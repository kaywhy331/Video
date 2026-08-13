# Implementation Coverage

Updated 2026-08-12 after the verified-footage script, narration, and range-repair milestone.

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
| SQLite schema and migration | Implemented + tested | Migrations 001–006, integrity and reopen/idempotency tests |
| Catalog XLSX/CSV import and search | Implemented + tested | Existing import/normalization/geography tests; 26K-row UI performance not benchmarked |
| Metadata revisions and undo | Implemented + tested | Revision persistence and UI; bulk edit/merge/split/export remain partial |
| Geographic evidence model | Partial | Canonical hierarchy, parent-aware lookup, imported/vision/human assertions, evidence precedence, and exact-location hard gates are implemented; geocoder/coordinate and broader alias workflows remain |
| Topic opportunity engine | Partial | Explainable catalog coverage, queue, spend, and duplicate gates; live demand/competition adapters absent |
| Research and fact pack | Implemented, external validation pending | Configurable Tavily Search/Extract, real-URL/app-owned source records, strict claim extraction, unknown-ID rejection, relational citations, category freshness, conflict/stale omission, scene claim IDs, and explicit conflict exceptions; live provider rehearsal unrun |
| Script/storyboard pipeline | Implemented + tested | Locked provisional scripts are parented by immutable final versions rewritten only after verified footage; app-issued scene/claim/pronunciation constraints and audit receipts are enforced |
| Acquisition and licensing | Implemented, external validation pending | Manual Envato handoff and project attestation; live account workflow unrun |
| Media ingest and verification | Partial | Hashing, quarantine, FFprobe, conflict evidence, black/freeze analysis, rotation/no-upscale gates, scene-specific contact-sheet semantic verification, strict provider receipts, explicit retry, startup recovery, and bounded verified-alternate repair; expanded shot analysis/QC remain |
| Narration | Implemented, external validation pending | 15–45 second immutable section cache, pronunciation snapshots, Windows SAPI timing events, generic HTTP TTS adapter, word-timing validation, changed-section reuse, and low-confidence development fallback; live representative voice qualification unrun |
| Captions | Implemented + tested | Word-timed, bounded, nonoverlapping SRT and WebVTT generation plus QC |
| Render and media QC | Implemented + tested | Real FFmpeg fixtures, word-bound visual cuts, scene-fragment cache, explicit scene/range mode, full-to-range fragment-reuse integration, bounded range-repair receipts, classified failures, artifact versions, and full-final reassembly after range verification |
| Packaging/final review | Implemented + tested | Three packages, frame thumbnails, QC gate, approval fingerprint |
| YouTube private-first publishing | Implemented, external validation pending | Persisted resumable session protocol, duplicate guard, polling/attachment receipts; live OAuth/API rehearsal unrun |
| Durable project/job recovery | Implemented + tested | Canonical transitions, fail-closed blocked state, audits, dependencies, leases, stale-process recovery, project locks |
| Backup/restore/retention | Implemented + tested | Scheduled verified backups, configurable rotation, staged restore, safety copy, missing-original scan |
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
