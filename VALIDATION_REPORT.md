# VideoFactory Desktop alpha.5 — Validation Report

Generated: 2026-08-21 (America/Los_Angeles) during the upload-safe release-artifact validation pass.

## Outcome

The local buildout now includes migrations 001–018, checkpoint-safe deferred pause, task-aware graceful shutdown, a DB-backed maximum-one final-render lease, WorkflowService-locked manual/private uploads, remount-safe catalog/Sheets operation controls, worker-backed catalog evidence operations, managed interrupted-render cleanup, atomic project licensing/certificates, immutable Guided starting-script provenance, automatic continuation, perceptual global matching, exact seven-way Final Review revisions plus per-scene audit, a complete nine-tab project workspace, the three-pane storyboard exception editor, generic audited exception recovery, Autopilot operations health, manifest-authorized captions, and fail-closed HDR/log normalization in addition to the established P0 production path. Alpha.4 added contiguous package/source migration preflight, pinned Node execution, exact commit/ref and runner/toolchain receipts, audit/SBOM stages inside canonical validation, and an exact Windows artifact inventory with attached evidence and SHA-256 verification. Alpha.5 uses canonical whitespace-free Windows filenames and makes provenance generation fail closed before hosted uploads can normalize an unsafe name. All 151 PRD acceptance IDs remain mapped: 136 require exact passing local assertions and 15 remain explicitly external. Alpha.5 exact-head PR, post-merge, and tag CI receipts are release gates and are not pre-claimed here. The release remains an alpha and is not production-qualified because Windows clean-machine, live provider, real forced-interruption, licensed-media, unattended-cadence, Electron renderer performance, and five-video pilot gates are unrun.

## Local validation

| Check | Result |
|---|---|
| `npm run doctor` | Passed |
| TypeScript typecheck | Passed |
| Focused real-FFmpeg 4K generated-graphic test | Passed; final 3840×2160 encode and blocker-free QC verified |
| Full Vitest suite | Current inventory is 79 files / 286 tests. Exact pass/fail counts are written from the JSON reporter into `VALIDATION_STATUS.json`; coverage includes the real media fixtures, perceptual matching, corrupt-ingest isolation, secret storage, workflow/render/catalog/security behavior, acceptance traceability, migration preflight, and release provenance. |
| Real FFmpeg analysis fixture | Passed |
| Real concat/two-pass normalization fixture | Passed |
| Application migration wrapper (001–018) | Passed; every forward migration recorded, source/resource parity enforced, reopen idempotent, integrity `ok` |
| Source/resource migration parity | Passed |
| Electron/Vite main, preload, renderer build | Passed |
| Built Electron Playwright/Axe | Four serial journeys cover all seven primary views, all nine project tabs, deferred pause, audited exception actions, Node isolation/CSP, and the exact Studio/media-protocol fallback. Exact results come from the Playwright JSON report. |
| PRD acceptance traceability | All 151 IDs are mapped exactly once with app `0.1.0-alpha.5`, schema 18, fixture version, result, artifacts, and exact assertion bindings; 136 local / 15 external pending. Recording fails unless every bound assertion and canonical validation stage passed in fresh, input-hash-matched reports. |
| Locked dependency audit and SBOM | Passed; `npm audit --audit-level=low` reports 0 vulnerabilities and CycloneDX 1.5 contains 474 components |
| Release artifact provenance | Focused tests pass canonical upload-safe Windows naming, exact manifest/checksum verification, unsafe/extra/tampered artifact rejection, matching validation evidence, exact tag/version enforcement, and truthful branch-ref recording; hosted Windows evidence remains pending CI publication |
| `git diff --check` | Passed |
| Production H.264 encoder boundary | Verified in source and render fixtures: production renders use `libx264`; NVENC/QSV/AMF probes are diagnostics-only and do not select the production encoder |
| Repeatable 26K production-service catalog benchmark | Passed measured scope: 26,000 rows committed, integrity `ok`, overall warm-search p95 156.034 ms against 300 ms, and a bounded 50-row renderer page; see `VALIDATION_CATALOG_PERFORMANCE.json` |
| Repeatable 26K catalog responsiveness benchmark | Passed worker/main-process p99 scope: Sheets stage 26.513 ms, preview 24.84 ms, commit 32.161 ms against a 250 ms heartbeat target; ping p99 ≤0.056 ms against 50 ms; cancellation/managed cleanup 941.902 ms; 26,000 final rows; integrity `ok`. The receipt preserves maxima, including a 1,777.997 ms commit heartbeat outlier paired with a 502.469 ms ping outlier; see `VALIDATION_CATALOG_RESPONSIVENESS.json` |
| Electron catalog UI performance qualification | Partially measured: worker/main-loop import responsiveness passes; renderer startup, real scrolling/interaction and memory, and concurrent background-render responsiveness remain external gates |
| Deterministic render-crash reconciliation | Passed: stale job requeued, project lock released, only stale `RUNNING` render failed, completed render preserved, recovery idempotent, and integrity `ok` |

## GitHub Actions validation

The previous narration milestone passed both exact-head PR run [31654009236](https://github.com/kaywhy331/Video/actions/runs/31654009236) for commit `8e7dd2c` and post-merge `main` run [31654320673](https://github.com/kaywhy331/Video/actions/runs/31654320673) for merge commit `bf65f6c`:

| Job | Result |
|---|---|
| Linux `validate` | Passed in 37 seconds |
| Windows `package-windows` | Passed in 5 minutes 22 seconds |
| Unsigned NSIS/ZIP workflow artifact | Uploaded; 512,295,865 bytes; retained through 2026-08-26 |

This proves the Windows packages can be produced by the hosted runner. It does not replace a clean-machine installation and runtime test.

The current PRD-completion branch's exact-head PR and post-merge CI receipts will be added after publication. They are not pre-claimed here.

## Validated changes

- canonical audited project state transitions and fail-closed exception recovery;
- nested SQLite transactions and atomic forward migration records;
- durable job dependencies, cycles, leases, project locks, bounded retry, and stale-process recovery;
- one-shot explicit quit that closes new-work admission, drains tracked IPC/background/watcher work, emits pending feedback after 30 seconds without force-closing, checkpoints SQLite, and only then re-enters Electron quit;
- transactionally owned `job_resource_leases` with heartbeat/recovery/release paths, enforcing one global final render while deferring a second project without locking it or consuming an attempt;
- scheduled checksummed backups, configurable rotation, staged restore, safety copy, and missing-original scan;
- strict IPC schemas, sender/origin validation, managed-path containment, URL allowlists, and secret redaction;
- actual FFmpeg black/freeze analysis, rotation-aware resolution policy, corrupt/duplicate quarantine, and declared/actual conflict evidence;
- explicit SDR/HDR/log source policy, approved BT.2020 PQ/HLG tone mapping, malformed/log fail-closed blocking, and pipeline-versioned derivative/render/vision invalidation;
- narration splitting without audio truncation, SRT/WebVTT output, concat-before-analysis, two-pass EBU R128 normalization, and output profile/fast-start QC;
- rights fail-closed checks, package/final-render fingerprints, and strict final approval receipts;
- persisted resumable YouTube sessions, byte-offset recovery, duplicate final-hash guard, private-first metadata, processing polling, captions, thumbnails, playlist attachment, and configurable synthetic-media disclosure;
- manual private upload and package-sync routed through the same WorkflowService identity/project lock as automatic upload, with idempotent stored receipt recovery;
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
- workflow-locked three-pane storyboard recovery with persisted candidate/evidence comparison, verified replacement/rejection, immutable claim-safe narration/graphic/split/merge versions, complete human-location re-verification, asynchronous stale-result rejection, paused-state preservation, and affected-range regeneration;
- a nine-tab accessible project workspace backed by complete research/source/claim, script/coverage, storyboard, rights, audio, render/QC, publication/analytics, and audit queries;
- generic exception context, safe alternatives, retry/resolve, reasoned safe override, and durable evidence/action history;
- explicit active-final review selection, artifact-changing revision invalidation, and audited closure of superseded render exceptions only after a replacement final passes blocker QC;
- explicit per-scene Final Review treatment/media/rights/claim/source/QC evidence and caption availability tied to a contained manifest-authorized VTT file;
- editable-control-safe `Ctrl+Alt+D/R/A/P/E` operator shortcuts with open-project-first deterministic targeting, explicit confirmation for consequential pause/approval actions, visible focus rings, and narrow-screen storyboard collapse;
- final-output black/freeze, duplicate-range, crop/effective-resolution/letterbox, clipping/silence, caption, required-label, geographic-evidence, rights, promise, chapter, description, and thumbnail checks before final approval;
- ordinal-bearing crop/duplicate/resolution failures routed through bounded scene alternate selection or acquisition instead of premature full rerender;
- migration 007 export/rebuild receipts, restore-marker retry safety, original-hash verification, and deterministic proxy/contact-sheet/voice-timing/editing/caption regeneration;
- byte-verified project artifact index covering metadata, scripts/sources/claims, scene contracts, rights/files, voice/captions, renders/QC/packages, publication/audit records, optional originals, and optional final output, with resumable-session secrets removed.
- worker-backed staged catalog previews/commits/refreshes and bounded Sheets materialization with progress/status/ping, cooperative cancellation, atomic rollback, managed-output cleanup, duplicate-row retention, source-scoped missing detection, layered metadata assertions, semantics-preserving initial-import batching, invalidated facet caching, bulk edit, place merge/split, filtered export, and validation-gated refresh;
- app-shell catalog operation recovery that reconstructs phase/progress/cancel state after view remount and includes the pre-worker read-only Google Sheets fetch;
- migration 014 case-insensitive composite search/sort indexes and repeatable real-XLSX 26K receipts covering import counts, integrity, warm search/filter/sort latency, bounded renderer paging, and worker/main-process responsiveness;
- secret-free settings-profile transfer, non-installing release discovery, persisted system/H.264 diagnostics, durable cadence scheduling, and regenerable-derivative-only cleanup;
- content-addressed licensed music with license/project snapshots, narration ducking, fades, mixed-output loudness/QC, crop-qualified output profiles, truthful 4K fallback, and a real 4K generated-graphic encode;
- persisted YouTube Analytics collection receipts, immutable final-manifest retention mapping, minimum-evidence bounded recommendations, human apply/reject/rollback, and operator-facing analytics UI;
- channel/language/provider/output registries, truthfully labeled keyword evidence, explainable opportunity components, and bounded read-only Google Sheets catalog staging through the cancellable worker.
- oldest-work-first automatic script/narration/render/private-upload continuation with durable job identity, restart recovery, manual-revision guards, and an unambiguous final human publication gate;
- exact seven-way Final Review revision routing with approval invalidation, factual-note carry-forward, affected-section-only pronunciation regeneration, regenerated-upload completion, and persisted Keep private disposition;
- non-dismissible ambiguous-mapping recovery with candidate context, stale-ID fallback, failed-attempt evidence retention, and closure only after successful mapped-file ingestion;
- exactly five deduplicated analytics jobs at days 1/3/7/28/90, scheduled-publication visibility confirmation, retry-free still-private deferral, and provider-failure retry accounting;
- lease-safe audited pause/resume/cancel/archive controls, deferred pause intent applied after active-job lock release, blocker-aware resume, queued-job cancellation, and backend-authoritative Guided inputs;
- automatic Autopilot states with pause/resume creation controls and exact spend/disk/provider/media/render/upload health, without renderer-driven manual advancement.
- deterministic startup reconciliation of prior-process render crashes, preserving completed renders while requeuing the job, releasing its project lock, and failing only stale running attempts.
- managed-only cleanup of interrupted render outputs/workspaces while preserving completed and out-of-root artifacts;
- atomic project-level license attestation and certificate upgrades, protected terminal/conflict decisions, license-only completion after verification, and media ingest that never implies licensing;
- migration 015 immutable Guided-input provenance, raw-seed isolation from providers/evidence, deterministic unsupported-fact rejection, and export/rebuild persistence;
- catalog-worker lifecycle behavior covering concurrency, progress, streamed staging, cooperative cancellation, crash/early-exit terminal events, status cleanup, and transactional integrity.
- built-production Electron accessibility/keyboard journeys, all-ID acceptance mapping/receipt validation, zero-advisory dependency audit, and CycloneDX SBOM generation.

## Historical alpha.2 validation

Alpha.2 repaired the original incomplete package by restoring dependency declarations, startup logging, Electron/Vite output, and Electron-bundled SQLite. The 2026-08-04 validation passed 12 tests and the production bundle. That evidence remains historical and is superseded by alpha.3 validation.

## Qualification gates not run

| Gate | Status |
|---|---|
| Electron 26K catalog UI/startup/background performance | Partial; the worker/main-loop import harness passes, but it does not establish renderer startup under five seconds, actual scrolling/interaction and memory behavior, or background-render responsiveness |
| Clean Windows 10/11 install and runtime | Unverified |
| Windows installer launch/upgrade/uninstall | Unverified; CI packaging is not runtime validation |
| Five representative real-video pilot | Unverified |
| Live Envato licensing/download workflow | Unverified |
| Live Google OAuth/YouTube private upload and publish rehearsal | Unverified |
| Live semantic vision provider against representative licensed footage | Unverified; mocked protocol/policy coverage is not provider qualification |
| Live Tavily plus LLM research against representative sources/conflicts | Unverified; mocked protocol/policy coverage is not provider qualification |
| Live Windows SAPI/HTTP TTS pronunciation and timing | Unverified; local protocol/cache/policy coverage is not voice-provider qualification |
| Live Google Sheets and YouTube Analytics collection | Unverified; injected-provider tests are not OAuth/API qualification |
| Representative licensed-music, qualified-4K/portrait, and unattended scheduler runs | Unverified; local fixtures and policy tests are not production rehearsal |
| Forced restart during real ingest/render/upload | Unverified; deterministic stale-render database reconciliation passes, but no real process termination during ingest, render, or upload is claimed |
| Representative production-data restore drill | Unverified |

These are not waived or counted as passes. Hardware H.264 encoders are also not claimed as a production capability: current production rendering is deliberately `libx264`-only. `production_ready` remains `false`.
