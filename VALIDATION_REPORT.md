# VideoFactory Desktop alpha.3 — Validation Report

Generated: 2026-08-12 (America/Los_Angeles); sourced-research validation pending GitHub CI receipt.

## Outcome

The imported alpha.2 vertical slice has been hardened into 0.1.0-alpha.3, with automated repair routing, semantic footage verification, sourced web research, freshness/conflict orchestration, and provider preflight implemented. Full local source validation passes, including real FFmpeg media operations. The prior semantic milestone's GitHub Actions run passed; the current research milestone's CI receipt is added only after exact-head validation. The release remains an alpha and is not production-qualified because Windows clean-machine, live provider, and five-video pilot gates are external and unrun.

## Local validation

| Check | Result |
|---|---|
| `npm run doctor` | Passed |
| TypeScript typecheck | Passed |
| Focused research/provider/semantic/contracts suite | Passed; cache, auth/quota, budgets, citations, stale/conflict, invented-ID, and corrective-retry cases included |
| Full Vitest suite | Passed; 33 files / 103 tests |
| Real FFmpeg analysis fixture | Passed |
| Real concat/two-pass normalization fixture | Passed |
| Application migration wrapper (001 + 002 + 003 + 004 + 005) | Passed in focused validation; versions recorded, accepted-claim trigger enforced, reopen idempotent, integrity `ok` |
| Source/resource migration parity | Passed |
| Electron/Vite main, preload, renderer build | Passed |
| `git diff --check` | Passed |

## GitHub Actions validation

PR run [31636652585](https://github.com/kaywhy331/Video/actions/runs/31636652585) passed for semantic implementation commit `0c9068f` (GitHub pull-request merge ref `8ed45f5`):

| Job | Result |
|---|---|
| Linux `validate` | Passed in 40 seconds |
| Windows `package-windows` | Passed in 5 minutes 30 seconds |
| Unsigned NSIS/ZIP workflow artifact | Uploaded; 512,279,275 bytes; retained through 2026-08-26 |

This proves the Windows packages can be produced by the hosted runner. It does not replace a clean-machine installation and runtime test.

## Validated changes

- canonical audited project state transitions and fail-closed exception recovery;
- nested SQLite transactions and atomic forward migration records;
- durable job dependencies, cycles, leases, project locks, bounded retry, and stale-process recovery;
- scheduled checksummed backups, configurable rotation, staged restore, safety copy, and missing-original scan;
- strict IPC schemas, sender/origin validation, managed-path containment, URL allowlists, and secret redaction;
- actual FFmpeg black/freeze analysis, rotation-aware resolution policy, corrupt/duplicate quarantine, and declared/actual conflict evidence;
- narration splitting without audio truncation, SRT/WebVTT output, concat-before-analysis, two-pass EBU R128 normalization, and output profile/fast-start QC;
- rights fail-closed checks, package/final-render fingerprints, and strict final approval receipts;
- persisted resumable YouTube sessions, byte-offset recovery, duplicate final-hash guard, private-first metadata, processing polling, captions, thumbnails, playlist attachment, and configurable synthetic-media disclosure;
- queue/spend/duplicate/coverage planning gates and catalog-backed sources/claims;
- deterministic per-scene shot-candidate ranks and bounded residual-risk alternate acquisition;
- automatic failed-footage routing that revalidates geography, on-disk source, no-upscale/black/freeze limits, and project license before promotion;
- classified final-QC repair policy, monotonic artifact versions, two-attempt output retry, smallest-safe state routing, exhaustion stop, audit log, and operator-visible repair history;
- canonical geographic hierarchies with parent-aware disambiguation and human-over-vision evidence precedence;
- scene-specific contact-sheet-only semantic provider requests with strict schema validation, one corrective retry, caching, persisted provider/error receipts, and fail-closed policy;
- semantic receipt-gated media attachment and alternate promotion, explicit operator retry, blocker lifecycle handling, and startup re-verification for legacy waiting alternates.
- bounded Tavily Search/Extract adapter with real HTTP(S) URL enforcement, response validation, app-owned source IDs, source-content hashes, provider receipts, and cache reuse;
- strict one-corrective-retry factual extraction that rejects model-invented source or claim IDs, followed by deterministic category freshness, stale omission, and material-conflict exceptions;
- relational claim citations with a database acceptance trigger, scene claim links, wording-fidelity checks, and per-project provider policy snapshots;
- centralized cached-call-aware monthly/per-project budget and persisted auth/quota preflight for research, language, and vision calls before new network requests or new projects.

## Historical alpha.2 validation

Alpha.2 repaired the original incomplete package by restoring dependency declarations, startup logging, Electron/Vite output, and Electron-bundled SQLite. The 2026-08-04 validation passed 12 tests and the production bundle. That evidence remains historical and is superseded by alpha.3 validation.

## External gates not run

| Gate | Status |
|---|---|
| Clean Windows 10/11 install and runtime | Unverified |
| Windows installer launch/upgrade/uninstall | Unverified; CI packaging is not runtime validation |
| Five representative real-video pilot | Unverified |
| Live Envato licensing/download workflow | Unverified |
| Live Google OAuth/YouTube private upload and publish rehearsal | Unverified |
| Live semantic vision provider against representative licensed footage | Unverified; mocked protocol/policy coverage is not provider qualification |
| Live Tavily plus LLM research against representative sources/conflicts | Unverified; mocked protocol/policy coverage is not provider qualification |
| Forced restart during real ingest/render/upload | Unverified |
| Representative production-data restore drill | Unverified |

These are not waived or counted as passes. `production_ready` remains `false`.
