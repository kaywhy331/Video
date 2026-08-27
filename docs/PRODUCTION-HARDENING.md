# Production Hardening and Release Gates

Updated 2026-08-26 for clean exact-HEAD/tree release admission, separate runtime/claims digests, machine-verifiable claim projection, untracked generated receipts, the alpha.7 historical evidence index, and fail-closed admission of representative external qualification evidence.

Alpha.7 carries forward the alpha.6 durability, security, rendering, backup, publishing, and hosted ZIP/NSIS lifecycle-smoke evidence while rolling the final publication receipts into the versioned documentation. It adds no runtime behavior and changes no qualification status. Its immutable publication facts are in the [historical evidence index](release-evidence/v0.1.0-alpha.7.json); that later documentation receipt does not validate the current checkout or move the alpha.7 tag. Canonical validation resolves that tag and the recorded trees/history in Git and rejects conflicting machine-checkable statements across the tracked claim documents. Current release evidence must come from a clean `npm run validate:release` run or the matching exact-workflow-SHA CI artifact.

Post-alpha.7 remediation now routes Tavily, language, vision, and HTTP TTS traffic through one main-process endpoint policy. Managed origins are fixed; custom remote origins require explicit confirmation and credential rebinding; local mode is loopback-only and credential-free. DNS answers and redirects are revalidated, connections are pinned to admitted addresses, and requests have tested abort, timeout, redirect, and response-size bounds. These local controls do not replace the live-provider rehearsals below.

Schema upgrades now fail closed as one pending-migration transaction after an integrity-checked pre-upgrade copy beside the database. Schema-18 upgrades are structurally compared with fresh schema-24 installs, injected migration failure proves rollback to a usable prior database, incompatible newer schemas raise a stable actionable error, and staged restore tests preserve the current OAuth/provider/retry/tool/publication/audit safety bindings. Schema 24 therefore requires a build advertising schema capability 24; using an older build requires restoring the automatically created `*.pre-migration-v18-to-v24-*.sqlite` copy first. This local evidence does not replace the representative production-data restore drill below.

## P0 before production qualification

- Run the released Windows system qualifier across representative NVIDIA, Intel, and AMD Windows 10/11 x64 machines without Node, Python, Git, or other developer tools; include the real four-mode storage matrix. Hosted CI exercises ZIP launch and silent NSIS install/launch/uninstall, but its preinstalled tooling remains supporting evidence.
- Run the canonical five-video representative pilot with real licensed footage and preserve its exact-source receipt for location grounding, rights, render QC, upload state, and human approval.
- Rehearse live Envato account handoff, license naming, download watcher mapping, ambiguity handling, and certificate attachment.
- Rehearse live YouTube OAuth, resumable interruption/restart, active-final/package changes during upload and processing, stale-private cleanup, thumbnail, timed captions, optional playlist, processing failure, keep-private, schedule, and publish/private-reset races.
- Rehearse live Tavily Search/Extract plus LLM claim extraction, including real URLs, freshness, disagreement, malformed output, auth failure, and quota exhaustion.
- Rehearse representative Windows SAPI and configured HTTP TTS runs for place pronunciation, native/provider timing, auth, quota, malformed timing, and changed-section cache reuse.
- Perform ingest, render, upload, and restore interruption drills on representative data.
- Record an Electron renderer run for startup, 26K catalog scrolling/interaction and memory, and responsiveness during a concurrent background render. The worker/main-loop import boundary has a separate passing local harness and is not a substitute for this UI run.

The renderer gate has a canonical target runner. From a clean exact Windows x64 commit on representative non-CI hardware, run `npm run qualify:electron-performance -- --mode=qualification --device-class="<non-sensitive hardware class>"`, then run `npm run validate:release` without changing HEAD or the tree. The target runner writes an ignored receipt and SHA-256 index; acceptance validation re-verifies the measurements, target eligibility, canonical paths, byte sizes, hashes, and exact source before qualifying only `CAT-001`, `CAT-009`, and `PERF-001` through `PERF-003`. Release provenance carries and independently re-admits those attachments. An absent index leaves the gates pending, while an invalid or unsupported index blocks validation. This evidence does not waive any other external gate.

The production field gate also has a canonical runner. Close every app instance, use `npm run qualify:production-pilot -- --database="<videofactory.sqlite>" --list-candidates` to select five eligible records, then run `npm run qualify:production-pilot -- --mode=qualification --database="<videofactory.sqlite>" --projects="<id1>,<id2>,<id3>,<id4>,<id5>" --device-class="<non-sensitive hardware class>"` from a clean exact Windows x64 checkout outside CI. The runner holds a checkpointed database snapshot, checks schema 24 integrity and the real 26K catalog, requires five scheduler-created 4–6 minute projects across three destinations, and verifies live Tavily/LLM, real SAPI or HTTP TTS, Envato certificate-backed acquisition, selected source bytes, final manifests/captions/media probes, blocker-free active-final QC, current channel-bound YouTube processing, scheduling, and the complete operator audit projection. At least four projects may contain only acquisition and final-approval human actions. The receipt hashes private identities and filesystem artifacts rather than disclosing them. Only a fully passing receipt may qualify `E2E-001`, `E2E-002`, `E2E-005`, and `UX-001`; crash drills and system/hardware matrices stay independent.

The system field gate is likewise canonical. Run the checksummed `QUALIFY_WINDOWS_SYSTEM.ps1` shipped in the release on non-CI NVIDIA, Intel, and AMD targets without developer commands, supplying a real read-only/missing/offline-NAS/low-space matrix on at least one target. The packaged app persists diagnostic, setup-route, and storage/database-integrity observations before the script uninstalls it. From a clean checkout of the exact released commit, `npm run qualify:windows-system` hashes and re-assesses three to ten raw observations, removes device labels and paths, and may qualify only `SYS-001`, `SYS-003`, and `SYS-004`. Release provenance requires the same app version and released qualifier hash. See [Windows system qualification](WINDOWS-SYSTEM-QUALIFICATION.md).

## Release engineering

- Sign the Windows installer and define an update channel before broad distribution.
- Add crash reporting only with an explicit privacy/redaction policy.
- Validate Windows fixtures covering ProRes, H.264, H.265, alpha, variable frame rate, interlaced sources, rotation, and unusual color spaces.
- Benchmark dashboard startup and project operations against the PRD data-size targets; production catalog search and worker/main-loop import now have checked-in 26K receipts.
- Preserve the generated acceptance receipt, runtime/claims input manifests, zero-advisory audit gate, CycloneDX SBOM, exact artifact manifest/checksums, released Windows system qualifier, any admitted production-pilot/performance/system attachments, the commit/tree- and artifact-bound packaged-Windows smoke receipt, and dependency-response policy with every release artifact; see `DEPENDENCY-SECURITY.md`. Do not commit generated root receipts as current source evidence.

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

CI success, a generated Windows installer, the hosted packaged-app smoke, and local automated tests are necessary but do not set `production_ready` to `true`. Acceptance computes that flag from its case results; it can become true only when every external gate is qualified by an attached, supported, exact-source receipt and none remain pending. Release provenance rejects a Boolean that does not reconcile with those cases and attachments.
