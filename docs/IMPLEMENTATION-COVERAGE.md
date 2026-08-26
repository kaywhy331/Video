# Implementation Coverage

Updated 2026-08-26 for clean exact-source validation, machine-verifiable release claims, OAuth destination binding, centralized provider endpoint trust, state-safe retry, device-local media-tool trust, active-final publication identity, and transactional migration/restore safety after the alpha.7 release-receipt rollup. Alpha.7 itself changed release metadata and evidence only; the later remediation work does not alter that historical release.

Status meanings:

- **Implemented + tested:** code exists and has local automated coverage.
- **Implemented, external validation pending:** code exists but requires target platform, credentials, accounts, or real licensed media.
- **Partial:** a useful bounded implementation exists, but the full PRD requirement is not complete.
- **Not implemented:** no production implementation is claimed.

## Local gap audit and closure checklist

The earlier repository-wide buildout is recorded below. The newer critical-gap remediation plan remains in progress; completed lanes are called out explicitly, while separate production-qualification gates remain evidence-gathering work rather than locally simulated evidence.

- [x] Replace renderer-driven project advancement with durable, oldest-work-first workflow continuation and preserve the mandatory final human publication gate.
- [x] Make pause, resume, cancel, archive, retry, and blocked-project behavior backend-authoritative, audited, lease-safe, and state-machine valid.
- [x] Serialize every manual/private upload through the same durable job identity and project lock used by automatic workflow execution.
- [x] Enforce a database-backed maximum of one simultaneous final render, with heartbeat, retryable deferral, release, and restart recovery.
- [x] Drain admitted IPC, background, catalog-worker, watcher, and workflow work before database close; report long drains without force-closing unsafe work.
- [x] Reconcile interrupted render jobs deterministically and delete only managed partial artifacts while preserving completed and external files.
- [x] Move large catalog staging/import work off the main process; add progress, cancellation, rollback, remount recovery, bounded paging, and repeatable 26K service/main-loop receipts.
- [x] Make project licensing/certificate upgrades atomic and ensure ingest never silently grants a license.
- [x] Persist Guided destination/topic/duration and starting-text provenance immutably while keeping the raw seed out of evidence and provider prompts.
- [x] Make ambiguous download mappings actionable and non-dismissible until a selected candidate is successfully ingested.
- [x] Implement all seven Final Review revision routes with durable approval invalidation, affected-section regeneration, Keep private, and automatic return through private upload.
- [x] Bind review/publishing to the project's explicit active final-render pointer, invalidate stale final/upload pointers after artifact-changing revisions, and close only superseded render exceptions after a verified replacement succeeds.
- [x] Build the missing three-pane storyboard recovery workspace with persisted candidate/evidence comparison, verified replace/reject, narration rewrite, evidence-bound graphic treatment, split, merge, human location verification, and affected-range regeneration.
- [x] Make storyboard mutations workflow-locked and versioned; preserve paused state, reject stale asynchronous results, retain accepted-claim/citation safety, and invalidate downstream approvals/artifacts.
- [x] Expose storyboard operations through schema-validated IPC and the sandboxed preload bridge without adding renderer filesystem or Node access.
- [x] Keep the required real 4K generated-graphic path within the test budget while retaining 3840×2160 H.264 output, constrained bitrate, and blocker QC.
- [x] Add discoverable keyboard access for next download, retry, approve, pause, and exception navigation; ignore editable controls/repeats and retain confirmation on consequential actions.
- [x] Add visible keyboard focus, a narrow-screen one-column storyboard layout, and default WebVTT captions on the managed final-preview video.
- [x] Enforce a source-color contract that tone-maps approved PQ/HLG input, blocks ambiguous HDR/log input, and invalidates derivatives/renders/vision cache when the media pipeline changes.
- [x] Replace the partial project drawer with all nine required accessible evidence tabs and complete backend queries.
- [x] Make the exception inbox actionable across failure classes with project context, safe alternatives, generic retry/resolve, reasoned safe override, and audit history.
- [x] Add clearly scoped Autopilot new-project pause/resume and exact budget, disk, provider, and worker health without bypassing durable existing-project continuation.
- [x] Add per-scene Final Review treatment/media/rights/claim/source/QC audit and serve captions only through a contained manifest-authorized protocol path.
- [x] Defer an active project's pause request to the next released job checkpoint instead of rejecting or mutating through an active lock.
- [x] Exercise the built production Electron application with Playwright, Axe WCAG 2 A/AA checks, global shortcuts, and accessible nine-tab keyboard navigation.
- [x] Map every PRD acceptance ID to versioned local or external evidence, keep external gates pending, require a zero-advisory audit, and generate a CycloneDX SBOM.
- [x] Gate Windows provenance on hosted ZIP launch plus silent NSIS install, launch, orderly application quit, uninstall, and cleanup evidence bound to the exact commit and package hashes.
- [x] Classify live geocoding/additional demand adapters and full multi-channel/multilingual/vertical workflows as explicit P1/P2 scope instead of misreporting them as unfinished P0 behavior.
- [x] Route research, language, vision, and HTTP TTS through one main-process endpoint policy with explicit trust modes, credential-origin binding, pinned DNS, redirect controls, bounded transport, safe health states, and operator confirmation.
- [x] Re-run whole-project typechecking, production bundling, runtime diagnostics, all automated tests, JSON parsing, and diff-whitespace validation, then synchronize the evidence documents.

## Production path

| Capability | Status | Evidence / boundary |
|---|---|---|
| Desktop shell and sandbox | Implemented + tested | Electron/Vite production bundle plus built-app Playwright/Axe journeys, IPC/security tests, responsive workspaces, focus-visible controls, and deterministic operator-shortcut routing |
| Clean Windows install/runtime | Implemented, external validation pending | Hosted Windows CI expands and launches the ZIP, silently installs and launches the NSIS package with isolated data, requests an orderly application quit, uninstalls, verifies cleanup, and binds the receipt to the commit and package hashes. The runner contains Node and developer tooling, so clean-machine qualification remains unrun |
| SQLite schema and migration | Implemented + tested | Migrations 001–024, integrity, byte-identical source/resource parity plus packaging preflight, contiguous-version enforcement, verified pre-migration backup, one-transaction pending upgrade, injected-failure rollback, fresh/schema-18 structural parity, stable newer-schema rejection, safely bound or explicitly unbound legacy publication snapshots, composite catalog-search indexes, immutable project-guidance provenance, job-resource leases, state-safe retry versions/reconciliation receipts, device-local media-tool trust, deferred lifecycle intent, OAuth channel bindings, provider endpoint bindings, and perceptual-match keys |
| Project detail workspace | Implemented + tested | Nine accessible tabs expose overview, research/sources/claims, script/coverage, storyboard, assets/licenses, voice/audio, renders/QC, publishing/analytics, and audit history from complete backend queries |
| Catalog XLSX/CSV import and search | Implemented + tested | Worker-thread preview/commit/refresh, progress/status/ping, cooperative cancellation with rollback, staged diff, duplicate-row retention, source-scoped missing detection, validation templates, scheduled refresh staging, normalization/geography, filtered search/export, semantics-preserving initial-import assertion batching, and invalidated facet caching. App-root operation recovery preserves phase/progress/cancel controls across view remounts, including the pre-worker Google Sheets fetch. Repeatable 26K receipts cover count/integrity, bounded-page, warm-search, Sheets staging, cancellation, and main-process responsiveness; renderer startup/interaction/memory and concurrent-render behavior remain externally unqualified |
| Metadata revisions and undo | Implemented + tested | Revision persistence/undo, layered raw/normalized/AI/human assertions, review inbox, bulk edit, place merge/split, and checksummed filtered export |
| Geographic evidence model | Implemented, external validation pending | Canonical hierarchy, parent-aware lookup, imported/vision/human assertions, evidence precedence, alias accumulation, audited merge/split, coordinate-backed graphics, and exact-location hard gates are implemented and tested. Broader production alias qualification remains external; live geocoding is explicitly P1 rather than a missing P0 implementation |
| Topic opportunity engine | Implemented, external validation pending | Explainable weighted coverage/demand/competition/channel-fit scoring, truthful native/proxy labels, queue, spend, and duplicate gates; Guided destination/topic/duration inputs and a bounded starting-script seed are revalidated and stored with immutable provenance. The raw seed is guidance only, never a source or claim, and only its hash plus safe editorial signals reach the provider. Live demand/competition evidence requires configured external providers; additional Google Ads/YouTube adapters are P1 |
| Research and fact pack | Implemented, external validation pending | Configurable Tavily Search/Extract, real-URL/app-owned source records, strict claim extraction, unknown-ID rejection, relational citations, category freshness, conflict/stale omission, scene claim IDs, explicit conflict exceptions, and centralized endpoint admission; live provider rehearsal unrun |
| Script/storyboard pipeline | Implemented + tested | Locked provisional scripts are parented by immutable final versions rewritten only after verified footage; app-issued scene/claim/pronunciation constraints and audit receipts are enforced; factual revision notes are carried into the next finalization pass. The three-pane workflow-locked recovery editor compares persisted candidates/evidence and supports verified shot replacement/rejection, claim-safe narration rewrite, evidence-bound map/text treatment, claim-preserving split/merge, complete human-location re-verification, and affected-range regeneration. Mutations invalidate stale approval/output pointers, reject asynchronous stale results, and preserve paused projects until explicit resume |
| Acquisition and licensing | Implemented, external validation pending | Manual Envato handoff, atomic project attestation/certificate upgrades, protected terminal/conflict decisions, license-only completion after verification, selectable completed-but-unlicensed assets, and no licensing implication from media ingest; live account workflow unrun |
| Media ingest and verification | Implemented, external validation pending | Hashing, quarantine, FFprobe, conflict evidence, proxy/contact-sheet creation, black/freeze analysis, rotation/no-upscale gates, explicit SDR/HDR/log detection, approved PQ/HLG tone mapping, pipeline invalidation, scene-specific semantic verification, strict provider receipts, retry, startup recovery, and bounded repair; representative real-format/Envato rehearsal remains external |
| Narration | Implemented, external validation pending | 15–45 second immutable section cache, pronunciation snapshots, Windows SAPI timing events, endpoint-policy-routed generic HTTP TTS, word-timing validation, and structured pronunciation revision that stales only affected sections and reuses unchanged TTS sections; live representative voice qualification remains unrun |
| Captions | Implemented + tested | Word-timed, bounded, nonoverlapping SRT/WebVTT generation plus QC; local review advertises only an existing VTT referenced by the active final's contained manifest through the traversal-safe media protocol |
| Editing and graphics | Implemented + tested | Deterministic evidence-bound ASS layers for coordinate/schematic map cards, text/archival cards, location labels, chapter cards, lower thirds, channel logo, and sourced callouts; real FFmpeg generated-graphic fixture |
| Render and media QC | Implemented + tested | Real FFmpeg footage/graphic/final fixtures, word-bound cuts, safe crop/no-upscale behavior, crop-qualified landscape 1080p/4K and portrait profiles, truthful 4K fallback, output black/freeze/reuse/crop/resolution/letterbox/clipping/silence/caption/location checks, fragment cache, scene/range mode, ordinal-bearing bounded range/alternate repair, verified replacement-final closure of superseded render exceptions, and a transactionally acquired global `render_final` resource lease (maximum one) with retryable deferral. Generated static graphics use a bounded faster software preset while retaining the required resolution/codec/bitrate/QC profile. Production renders explicitly use software `libx264`; NVENC/QSV/AMF availability is detected and test-encoded for diagnostics only, not selected by the production renderer. |
| Packaging/final review | Implemented + tested | Three evidence-bounded packages, timeline chapters, actual-frame thumbnails, package QC, approval fingerprint, exact seven revision routes, active-final enforcement, and a per-scene expandable audit of treatment, selected media/graphic, rights, claims, sources, QC, and verification |
| YouTube private-first publishing | Implemented, external validation pending | Loopback OAuth uses one-time 256-bit state plus S256 PKCE, fixed callback routing, a five-minute in-memory candidate, exact channel/replacement confirmation, encrypted tokens, and a fingerprint-bound persisted destination required by upload and approval. One authoritative managed active-final resolver feeds a durable render/hash/package/thumbnail/channel snapshot; resumable lookup, metadata, attachments, processing, and approval revalidate it, stale remote videos stay private with one actionable exception, and a publish race triggers a compensating private reset. Manual upload/package-sync IPC enters through the same WorkflowService job identity and project lock; live OAuth/API rehearsal remains unrun |
| Durable project/job recovery | Implemented + tested | Canonical transitions, WorkflowService continuation, fail-closed blockers, audits, dependencies, locks, resource leases, and lease-safe lifecycle controls. Manual retry is an expected-state/version compare-and-set with backend capabilities, stable outcomes, exact permanent-failure attempt grants, ownership-safe cleanup, and durable upload reconciliation. Pause during an active mutation is persisted and applied at the safe post-lock checkpoint. Explicit quit drains admitted work before database close; startup deterministically reconciles interrupted jobs, upload identities, and managed partial renders |
| Actionable exception recovery | Implemented + tested | Project context, evidence, action history, server-computed retry/resolve/override policy, safe alternatives, and reasoned audited override are available across failure classes; ambiguous mappings remain non-dismissible until successful ingestion |
| Backup/restore/retention, storage, and export | Implemented + tested | Scheduled verified backups, configurable rotation, staged restore/safety copy, current-schema preservation of OAuth/provider/retry/tool/publication/audit bindings, original hash verification, persisted rebuild receipts, deterministic derivative regeneration, checksummed secret-redacted project exports, and pressure cleanup restricted to regenerable derivatives while preserving originals and licensed music |
| Provider endpoint trust | Implemented + tested | One main-process policy covers research, LLM, vision, and HTTP TTS with fixed managed origins, confirmed custom HTTPS origins, credential-free loopback-local mode, canonicalization, public-address validation, pinned DNS, same-origin/base-path redirects, request/response bounds, aborts, credential-origin fingerprints, profile-change invalidation, safe audit data, and trust/binding UI; live approved-provider rehearsal remains external |
| Media tool trust | Implemented + tested | Packaged builds prefer bundled FFmpeg/FFprobe; custom tools require canonical regular-file inspection, role/size/SHA-256/signature display, explicit local permission acknowledgement, and a bounded minimal-environment version probe. Trust is device-local, legacy paths are quarantined, every launch rechecks identity, changed/missing tools fail closed to a safe fallback, and portable profile v1/v2 handling cannot move paths, hashes, trust, or developer flags |
| Cost/quota controls | Implemented + tested | Cached calls are exempt; call receipts, monthly and project-snapshot hard budgets, and persisted endpoint-trust/auth/quota preflight cover research, LLM, vision, and HTTP TTS adapters; live quota behavior remains an external qualification gate |
| Operations and diagnostics | Implemented + tested | Secret-free settings-profile import/export with untrusted endpoint proposals, release discovery, persisted diagnostics, differentiated endpoint/credential/provider health, zero-advisory audit gate, CycloneDX SBOM, exact source/runner provenance, checksummed release inventory, and exact Autopilot spend/disk/provider/worker health |
| Autopilot cadence scheduler | Implemented + tested | Durable due-state, queue/provider/storage gates, pause/resume creation controls, startup/timer/manual evaluation, recoverable blocked status, Full Autopilot creation, and bounded Guided inputs; real scheduled production cadence remains externally unqualified |
| Licensed music | Implemented, external validation pending | Content-addressed import, license snapshots, project selection, narration-sidechain ducking, fades, two-pass loudness normalization, and QC; representative licensed-track rehearsal remains external |
| Analytics learning loop | Implemented, external validation pending | Exactly five deduplicated checkpoints at days 1/3/7/28/90, publication-visibility confirmation before collection, retry-accounted provider failures, persisted YouTube Analytics receipts, immutable final-manifest retention mapping, minimum-evidence gates, bounded recommendations, human apply/reject, and rollback; live OAuth/API collection remains unrun |
| Expansion architecture | Implemented + tested | The v1 foundation—channel/language/provider/output-profile registries, immutable project snapshots, explainable keyword evidence, and bounded read-only Google Sheets staging through the cancellable catalog worker—is implemented. Full multi-channel, multilingual, and vertical production workflows are explicit P2 scope, not unfinished P0 behavior |

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
- migrations 008–017 for catalog evidence, operations, scheduling/analytics, licensed music/storage, expansion registries, workflow recovery, composite catalog-search indexes, immutable Guided provenance, job-resource leases, and deferred lifecycle intent, with resource parity and idempotent reopen coverage;
- staged catalog diffs, cancellation and atomic rollback, duplicate/missing reconciliation, metadata assertion precedence/review, initial-import assertion batching, invalidated facet caching, bulk edit, place merge/split, filtered export, and validation-gated refresh;
- secret-free settings profiles, release discovery, persisted H.264 diagnostics, cadence scheduling, and derivative-only pressure cleanup;
- license-snapshotted music import and project selection, narration ducking/fades, mixed-output loudness/QC, crop-qualified output profiles, real 4K generated graphics, and truthful 1080p fallback;
- YouTube retention-to-scene mapping, durable analytics collection receipts, evidence-gated reversible learning, capability registries, truthful opportunity metrics, and read-only Google Sheets staging.
- oldest-work-first automatic script/narration/render/private-upload continuation, restart-safe recovery, manual-revision guards, and final-approval preservation as the mandatory human gate;
- exact seven-way Final Review revision routing, durable approval invalidation, structured affected-section pronunciation regeneration, factual-note carry-forward, automatic regenerated-upload completion, and persisted Keep private disposition;
- non-dismissible ambiguous-mapping recovery with stale-ID fallback, candidate context, failed-attempt evidence retention, and closure only after successful ingestion;
- exactly five deduplicated analytics checkpoints at days 1/3/7/28/90, scheduled-publication visibility confirmation, retry-free private deferral, and normal provider-failure retry accounting;
- audited pause/resume/cancel/archive behavior, blocker-aware resume, queued-job cancellation, and backend-authoritative Guided destination/topic/duration validation and provenance.
- deterministic simulated prior-process render-crash reconciliation, plus a real service-host `SIGKILL` after FFmpeg scene normalization at the draft assembly boundary, including durable job requeue, lock release, managed stale-work cleanup, successful second-attempt rendering, idempotency, and database integrity;
- real service-host `SIGKILL` at the media managed-original/derivative boundary, followed by hash-bound startup resumption, regenerated FFmpeg derivatives, acquisition completion, fail-closed unmanaged-path handling, and database integrity verification;
- managed-only interrupted-render cleanup that preserves completed and out-of-root artifacts;
- atomic project licensing/certificate upgrades, rollback and verification failure, protected terminal decisions, and media-ingest licensing regression coverage;
- bounded Guided starting-script provenance, raw-seed/provider separation, deterministic unsupported-fact rejection, and export/rebuild persistence;
- catalog-worker lifecycle coverage for progress, concurrent-operation rejection, streamed staging, cancellation, terminal cleanup, crash/early exit, and transactional rollback.
- one-shot explicit quit coordination, tracked-operation drain, watcher in-flight drain, post-grace pending feedback, global final-render deferral/release, workflow-locked manual uploads, and recovered catalog/Sheets status across renderer view remounts.
- strict storyboard recovery contracts and preload exposure; verified candidate comparison/replacement/rejection; claim-safe rewrite, graphic, split, and merge mutations; human-location re-verification; transient project locking; immutable versioning; stale-result rejection; active-final invalidation; and bounded range-to-final regeneration.
- active-final review selection, artifact-changing revision invalidation, and verified replacement-final resolution of only superseded render/render-QC exceptions.
- editable-control-safe operator shortcuts, visible focus treatment, responsive storyboard collapse, and managed active-final WebVTT preview captions.
- real PQ-to-BT.709 tone mapping, stale media-pipeline regeneration, contained media/caption protocol resolution, nine-tab project detail, generic exception actions, and deferred pause checkpoints;
- built Electron Playwright/Axe journeys, 175-ID acceptance traceability, zero-vulnerability dependency audit, and CycloneDX SBOM generation.

## Release evidence added in alpha.4

- exact source commit/ref and Node/npm/runner provenance in pipeline, status, and acceptance receipts;
- audit and SBOM stages inside the canonical validation pipeline, with hashes and sizes for generated evidence;
- contiguous source/resource migration parity in preflight instead of a hard-coded latest migration;
- exact Windows artifact inventory, per-file SHA-256 values, attached validation/SBOM evidence, branch-versus-tag identity, and post-generation verification;
- CI packaging ordered after exact-head validation and pinned by `.nvmrc` on Linux and Windows.

## Release upload safety added in alpha.5

- canonical `VideoFactory-Desktop-<version>-<arch>.<ext>` Windows package names that are independent of the human-facing product name and remain byte-for-byte addressable after hosted upload;
- fail-closed release-manifest validation for filenames outside the upload-safe ASCII letter, digit, period, underscore, and hyphen set, with regression coverage for normalized-name risk.

## Packaged Windows smoke gate added in alpha.6

- hosted Windows CI launches the extracted ZIP and installed NSIS application through the packaged executable, waits for the real dashboard, confirms packaged mode and isolated database initialization, and requests an orderly Electron quit;
- the same bounded run performs silent installation and uninstallation in an isolated path, verifies removal, and writes `WINDOWS_PACKAGE_SMOKE.json` with exact commit, version, runner, package hash, lifecycle, and cleanup evidence;
- release provenance fails closed when that receipt is missing, failed, stale, incomplete, or does not match the installer and archive bytes. This supports packaging confidence but does not close the clean-machine qualification gate.

## Validation evidence lifecycle hardened after alpha.7

- development and release validation are explicitly qualified; release mode admits only a clean exact Git HEAD/tree and rechecks source plus runtime/claims inputs after all stages;
- generated root status/acceptance receipts and `validation/results/*.json` are ignored artifacts rather than tracked claims about a later checkout;
- runtime and human release-claim inputs have separate deterministic per-file manifests without hashing their own generated provenance;
- claim validation checks exact tags, commits, workflow runs, published-asset counts, signing/readiness state, and external-gate counts against the immutable historical index across every tracked claim document, while Git checks the recorded tag, trees, ancestry, and single-change index history;
- Linux validation and Windows packaging retain the exact `${{ github.sha }}` artifact handoff, while manifest generation and verification reject dirty, development, stale commit/tree, or mismatched-input evidence;
- the tracked [alpha.7 historical evidence index](release-evidence/v0.1.0-alpha.7.json) records the immutable tag/release, workflow/job chain, transient Actions artifacts, and all published assets without claiming to validate the current checkout.

## Measured catalog performance and remaining UI boundary

`npm run benchmark:catalog` generated a 9,284,473-byte XLSX with 26,000 rows and exercised the production catalog service against a fresh database. Preview took 9,273.749 ms; atomic commit took 565,401.291 ms; all 26,000 staged rows, committed rows, and canonical assets were present; and SQLite integrity was `ok`. After reopening the database, 25 rounds across each of five common search/filter/sort scenarios produced an overall warm p95 of 156.034 ms against the 300 ms target. Scenario p95 values were 67.307 ms (recent page), 165.149 ms (FTS location/activity), 46.633 ms (country/city), 99.091 ms (orientation/country), and 64.332 ms (metadata contains). The renderer contract returned only the requested 50 rows rather than the whole catalog. The machine and full receipt are recorded in [`VALIDATION_CATALOG_PERFORMANCE.json`](../VALIDATION_CATALOG_PERFORMANCE.json).

`npm run benchmark:catalog:responsiveness` additionally exercises the built worker with a Sheets-style row stream, file preview, atomic commit, cooperative cancellation, managed-output cleanup, `catalog:ping`, progress, final row count, and SQLite integrity. Against 26,000 rows, Sheets staging took 18,399.2 ms with a 26.513 ms heartbeat p99; preview took 10,764.847 ms with a 24.84 ms p99; and the intentionally atomic commit took 649,121.919 ms with a 32.161 ms p99. Ping p99 remained at or below 0.056 ms, cancellation was observed in 941.902 ms, all 26,000 assets were present, and integrity was `ok`. Acceptance uses p99 thresholds (250 ms heartbeat, 50 ms ping) and the receipt also preserves unqualified maxima, including a 1,777.997 ms commit heartbeat outlier paired with a 502.469 ms ping outlier on the contended host. The full receipt is [`VALIDATION_CATALOG_RESPONSIVENESS.json`](../VALIDATION_CATALOG_RESPONSIVENESS.json).

Those measured service and main-process criteria pass. Full UI performance qualification remains false because the headless run does not measure Electron renderer startup under five seconds, actual scrolling/interaction and memory behavior, or responsiveness during background rendering.

## Production qualification gates

Promotion beyond alpha requires recorded evidence for all of the following:

1. Clean Windows 10/11 install and runtime without Node or developer tooling.
2. Five representative 4–6 minute real videos, with at least four requiring no routine editing beyond acquisition and final approval.
3. Project-specific licenses for every used real asset.
4. Live Envato download/mapping rehearsal, including ambiguity and failed-media cases.
5. Live YouTube OAuth/resumable upload/thumbnail/caption/playlist/processing/publish-or-schedule rehearsal without duplicate upload.
6. Forced-restart drills during ingest, render, and upload.
7. Backup/restore drill on representative production data.
8. Live Tavily and language-model research rehearsal with representative fresh, stale, conflicting, malformed, auth-failed, and quota-exhausted cases.
9. Live Windows SAPI or configured HTTP TTS rehearsal covering representative place pronunciations, timing, cache reuse, malformed timing, auth, and quota behavior.
10. Live Google Sheets and YouTube Analytics rehearsal with the configured OAuth scopes, plus representative licensed-music and scheduled-cadence runs.
11. Recorded Electron performance run covering dashboard startup, renderer scrolling/interaction and memory, and concurrent background rendering; the 26K worker/main-loop import boundary has a separate local receipt.
