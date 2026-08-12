# Production Hardening and Release Gates

Updated 2026-08-12 after the automated repair-routing milestone.

Alpha.3 closes the highest-risk local durability, security, rendering, backup, and publishing defects found during the production-readiness audit. This document now tracks only work that remains; completed claims are in `IMPLEMENTATION-COVERAGE.md` and `VALIDATION_REPORT.md`.

## P0 before production qualification

- Run a clean Windows 10/11 install and first-run diagnostic on a machine without Node, Python, or developer tools.
- Run the five-video representative pilot with real licensed footage and preserve receipts for location grounding, rights, render QC, and human approval.
- Rehearse live Envato account handoff, license naming, download watcher mapping, ambiguity handling, and certificate attachment.
- Rehearse live YouTube OAuth, resumable interruption/restart, thumbnail, timed captions, optional playlist, processing failure, keep-private, schedule, and publish.
- Add a configurable semantic vision provider for actual-footage/place/scene-contract verification.
- Add sourced web research with freshness/conflict policy for non-visual material claims.
- Implement the final post-ingest script rewrite against verified footage, plus pronunciation and word-level/forced alignment.
- Extend automated repair beyond the implemented bounded alternate/output loop to post-ingest script rewriting, semantic footage decisions, and scene/range-only rendering.
- Complete maps, labels, chapter cards, lower thirds, and scene/range render modes required by the full editing PRD.
- Expand QC for duplicate/near-duplicate shots, severe crops, letterboxing, clipping/silence, caption overlap/line length, unsupported package claims, and thumbnail file limits.
- Add project export and deterministic derivative rebuild after restore.
- Complete per-project provider budgets and quota/auth preflight across all configured providers.
- Perform ingest, render, upload, and restore interruption drills on representative data.

## Release engineering

- Sign the Windows installer and define an update channel before broad distribution.
- Add crash reporting only with an explicit privacy/redaction policy.
- Validate Windows fixtures covering ProRes, H.264, H.265, alpha, variable frame rate, interlaced sources, rotation, and unusual color spaces.
- Benchmark startup, catalog import/search, and project operations against the PRD data-size targets.
- Define artifact provenance/SBOM and dependency vulnerability response policy.

## P1

- Qualified 4K final render profile and blocker UI
- HTTP TTS provider, stable timing, pronunciation dictionary, and section cache
- Google Ads demand-proxy and YouTube competition adapters
- scene-level retention analytics and render-manifest mapping
- title/thumbnail experiment tracking
- map/route graphic generator
- destination batch planner and publication scheduler
- automatic factual expiry/freshness checks
- operator-friendly metadata conflict merge, bulk editing, location merge/split, and filtered export
- disk-pressure cleanup for regenerable derivatives

## P2

- Shorts/vertical output
- multiple channels and languages
- additional stock providers
- advanced motion graphics
- local embeddings and custom landmark recognition

## Truthful release rule

CI success, a generated Windows installer, and local automated tests are necessary but do not set `production_ready` to `true`. That flag changes only after the external qualification gates above have evidence attached to a release.
