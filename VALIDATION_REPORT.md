# VideoFactory Desktop alpha.3 — Validation Report

Generated: 2026-08-12 (America/Los_Angeles) during local P0 editing/QC/export validation.

## Outcome

The local P0 buildout is implemented through deterministic editing/graphics, expanded render and package QC, ordinal-bearing repair, checksummed project export, and restore-time derivative rebuild. The previous narration milestone's exact-head GitHub Actions run passes, including Windows packaging. This milestone's exact-head CI receipt remains pending publication. The release remains an alpha and is not production-qualified because Windows clean-machine, live provider, interruption-drill, and five-video pilot gates are external and unrun.

## Local validation

| Check | Result |
|---|---|
| `npm run doctor` | Passed |
| TypeScript typecheck | Passed |
| Focused research/provider/semantic/contracts suite | Passed; cache, auth/quota, budgets, citations, stale/conflict, invented-ID, and corrective-retry cases included |
| Full Vitest suite | Passed; 39 files / 128 tests, including real FFmpeg footage/range, generated-graphic, final-package, export, derivative-rebuild, and overlapping-failure deduplication fixtures |
| Real FFmpeg analysis fixture | Passed |
| Real concat/two-pass normalization fixture | Passed |
| Application migration wrapper (001–007) | Passed in focused validation; portability receipts recorded, accepted-claim trigger enforced, reopen idempotent, integrity `ok` |
| Source/resource migration parity | Passed |
| Electron/Vite main, preload, renderer build | Passed |
| `git diff --check` | Passed |

## GitHub Actions validation

The previous narration milestone passed both exact-head PR run [31654009236](https://github.com/kaywhy331/Video/actions/runs/31654009236) for commit `8e7dd2c` and post-merge `main` run [31654320673](https://github.com/kaywhy331/Video/actions/runs/31654320673) for merge commit `bf65f6c`:

| Job | Result |
|---|---|
| Linux `validate` | Passed in 37 seconds |
| Windows `package-windows` | Passed in 5 minutes 22 seconds |
| Unsigned NSIS/ZIP workflow artifact | Uploaded; 512,295,865 bytes; retained through 2026-08-26 |

This proves the Windows packages can be produced by the hosted runner. It does not replace a clean-machine installation and runtime test.

The editing/QC/export milestone's exact-head PR and post-merge CI receipts will be added after publication. They are not pre-claimed here.

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
- final-script versions parented to verified-footage provisional inputs, locked pronunciation metadata, and immutable audit receipts;
- 15–45 second section synthesis with pronunciation-aware cache identity, persisted word timing, strict HTTP timing/auth failure receipts, and word-derived captions;
- explicit scene/range render contracts, cached fragment reuse, affected-range repair provenance, and full-final rebuild after a range pass.
- real `RenderService` full-to-range FFmpeg integration proving scope/base-render provenance and reuse of the unchanged cached scene fragment.
- deterministic ASS editing plans/layers for evidence-bound maps or explicit schematic hierarchies, text/archival cards, labels, chapter cards, lower thirds, channel logo, and sourced callouts;
- real generated-graphic FFmpeg rendering without fabricated stock media plus footage-overlay and final 1080p package integrations;
- final-output black/freeze, duplicate-range, crop/effective-resolution/letterbox, clipping/silence, caption, required-label, geographic-evidence, rights, promise, chapter, description, and thumbnail checks before final approval;
- ordinal-bearing crop/duplicate/resolution failures routed through bounded scene alternate selection or acquisition instead of premature full rerender;
- migration 007 export/rebuild receipts, restore-marker retry safety, original-hash verification, and deterministic proxy/contact-sheet/voice-timing/editing/caption regeneration;
- byte-verified project artifact index covering metadata, scripts/sources/claims, scene contracts, rights/files, voice/captions, renders/QC/packages, publication/audit records, optional originals, and optional final output, with resumable-session secrets removed.

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
| Live Windows SAPI/HTTP TTS pronunciation and timing | Unverified; local protocol/cache/policy coverage is not voice-provider qualification |
| Forced restart during real ingest/render/upload | Unverified |
| Representative production-data restore drill | Unverified |

These are not waived or counted as passes. `production_ready` remains `false`.
