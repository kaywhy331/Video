# Implementation Coverage

Updated 2026-08-12 after the automated repair-routing milestone.

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
| SQLite schema and migration | Implemented + tested | Migrations 001/002/003, integrity and reopen/idempotency tests |
| Catalog XLSX/CSV import and search | Implemented + tested | Existing import/normalization/geography tests; 26K-row UI performance not benchmarked |
| Metadata revisions and undo | Implemented + tested | Revision persistence and UI; bulk edit/merge/split/export remain partial |
| Geographic evidence model | Partial | Exact-location metadata gate exists; canonical place IDs/evidence A–E are not complete |
| Topic opportunity engine | Partial | Explainable catalog coverage, queue, spend, and duplicate gates; live demand/competition adapters absent |
| Research and fact pack | Partial | Catalog-backed sources/claims and scene links; web research, freshness/conflict orchestration absent |
| Script/storyboard pipeline | Partial | Provisional structured scripts are locked; full post-ingest rewrite and word alignment absent |
| Acquisition and licensing | Implemented, external validation pending | Manual Envato handoff and project attestation; live account workflow unrun |
| Media ingest and verification | Partial | Hashing, quarantine, FFprobe, conflict evidence, black/freeze analysis, rotation/no-upscale gates, ranked candidates, and bounded verified-alternate repair; semantic vision remains absent |
| Narration | Partial | Windows SAPI plus visual-shot splitting; pronunciation, word timing, and section cache incomplete |
| Captions | Implemented + tested | SRT and WebVTT generation; alignment is scene/shot based rather than word-aligned |
| Render and media QC | Implemented + tested | Real FFmpeg fixtures plus classified failures, two-attempt smallest-safe output reroute, artifact versions, and repair receipts |
| Packaging/final review | Implemented + tested | Three packages, frame thumbnails, QC gate, approval fingerprint |
| YouTube private-first publishing | Implemented, external validation pending | Persisted resumable session protocol, duplicate guard, polling/attachment receipts; live OAuth/API rehearsal unrun |
| Durable project/job recovery | Implemented + tested | Canonical transitions, fail-closed blocked state, audits, dependencies, leases, stale-process recovery, project locks |
| Backup/restore/retention | Implemented + tested | Scheduled verified backups, configurable rotation, staged restore, safety copy, missing-original scan |
| Cost/quota controls | Partial | Provider call records, monthly spend gate, bounded retries; per-project accounting and all-provider quotas incomplete |
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
- planning capacity, spend, coverage, and duplicate-topic gates.
- ranked shot-candidate persistence, residual-risk alternate planning, late-bound geography/license/file/media checks, bounded alternate promotion, QC repair classification, and artifact-versioned retry/exhaustion.

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
