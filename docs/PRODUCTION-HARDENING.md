# Production Hardening and Release Gates

Updated 2026-08-21 after adding exact-head validation provenance, release-artifact checksums, migration-parity preflight, pinned CI toolchain evidence, and a hosted packaged-Windows smoke gate.

Alpha.4 preserves the Alpha.3 durability, security, rendering, backup, and publishing work while closing the local release-evidence gaps. This document now tracks only work that remains; completed claims are in `IMPLEMENTATION-COVERAGE.md` and `VALIDATION_REPORT.md`.

## P0 before production qualification

- Run a clean Windows 10/11 install and first-run diagnostic on a machine without Node, Python, or developer tools. Hosted CI now exercises ZIP launch and silent NSIS install/launch/uninstall, but its preinstalled developer tooling means it is supporting evidence rather than this qualification.
- Run the five-video representative pilot with real licensed footage and preserve receipts for location grounding, rights, render QC, and human approval.
- Rehearse live Envato account handoff, license naming, download watcher mapping, ambiguity handling, and certificate attachment.
- Rehearse live YouTube OAuth, resumable interruption/restart, thumbnail, timed captions, optional playlist, processing failure, keep-private, schedule, and publish.
- Rehearse live Tavily Search/Extract plus LLM claim extraction, including real URLs, freshness, disagreement, malformed output, auth failure, and quota exhaustion.
- Rehearse representative Windows SAPI and configured HTTP TTS runs for place pronunciation, native/provider timing, auth, quota, malformed timing, and changed-section cache reuse.
- Perform ingest, render, upload, and restore interruption drills on representative data.
- Record an Electron renderer run for startup, 26K catalog scrolling/interaction and memory, and responsiveness during a concurrent background render. The worker/main-loop import boundary has a separate passing local harness and is not a substitute for this UI run.

## Release engineering

- Sign the Windows installer and define an update channel before broad distribution.
- Add crash reporting only with an explicit privacy/redaction policy.
- Validate Windows fixtures covering ProRes, H.264, H.265, alpha, variable frame rate, interlaced sources, rotation, and unusual color spaces.
- Benchmark dashboard startup and project operations against the PRD data-size targets; production catalog search and worker/main-loop import now have checked-in 26K receipts.
- Preserve the implemented acceptance receipt, zero-advisory audit gate, CycloneDX SBOM, exact artifact manifest/checksums, commit- and artifact-bound packaged-Windows smoke receipt, and dependency-response policy with every release artifact; see `DEPENDENCY-SECURITY.md`.

## P1 after qualification

- Optional Envato account/API automation beyond the current explicit manual project handoff, certificate picker, and watched-download workflow.
- Additional vendor-specific TTS adapters beyond the generic HTTP contract.
- Qualified Google Ads demand-proxy and YouTube competition adapters; proxy values must remain visibly distinct from YouTube-native evidence.
- Title/thumbnail experiment tracking and broader scene-level learning beyond the implemented five-checkpoint retention mapping.
- Live geocoding and a richer route graphic generator beyond coordinate-backed and explicitly schematic cards.
- Automatic factual expiry refresh beyond the implemented category freshness gates and stale-claim omission.

## P2

- Full qualified Shorts/vertical production beyond the implemented crop-qualified portrait profile
- full multi-channel and multilingual production beyond the implemented registries and immutable project snapshots
- additional stock providers
- advanced motion graphics
- local embeddings and custom landmark recognition
- production hardware-encoder selection; NVENC/QSV/AMF remain diagnostics-only while production rendering deliberately uses `libx264`

## Truthful release rule

CI success, a generated Windows installer, the hosted packaged-app smoke, and local automated tests are necessary but do not set `production_ready` to `true`. That flag changes only after the external qualification gates above have evidence attached to a release.
