# Acceptance Test Plan

## 1. Test policy

A release cannot be marked complete because individual screens exist. It must pass the end-to-end production workflow, resilience tests, media validation, and policy gates using realistic catalog and media fixtures.

Severity:

- **P0:** Release blocker.
- **P1:** Required before routine channel operation.
- **P2:** Later expansion.

Evidence for every automated test must include test ID, app version, database schema version, fixture version, result, and logs/artifact references.

---

## 2. End-to-end critical path

### E2E-001 - Complete real production

**Priority:** P0  
**Given:** Full catalog imported, providers configured, one visually supportable destination cluster, YouTube connected.  
**When:** Operator starts Autopilot.  
**Then:** The app selects a topic, researches, scripts, storyboards, requests assets, ingests manually downloaded files, verifies, generates voice, renders, passes QC, generates packaging, uploads privately, and reaches `WAITING_FINAL_APPROVAL`.  
**Pass:** No routine operator action other than acquisition; zero unresolved blockers.

### E2E-002 - Final approval and scheduling

**Priority:** P0  
**Given:** Clean private upload in final review.  
**When:** Operator chooses approve and schedule.  
**Then:** Approval hashes are recorded and the video is scheduled through the API or routed to exact Studio fallback.  
**Pass:** Project reaches `SCHEDULED` or `AWAITING_MANUAL_STUDIO_ACTION` with no duplicate upload.

### E2E-003 - Send-back scoped regeneration

**Priority:** P0  
**Given:** Private upload ready.  
**When:** Operator reports one pronunciation issue.  
**Then:** Only affected TTS section, dependent captions, timeline range, final render, and upload/package version are regenerated.  
**Pass:** Research, unaffected TTS, proxies, and source analysis are reused.

### E2E-004 - Crash and resume

**Priority:** P0  
**Given:** Project is at each major long-running stage.  
**When:** Application/service host is forcibly terminated and restarted.  
**Then:** State recovers from durable jobs/checkpoints.  
**Pass:** No completed paid call repeats; no project corruption; partial files handled safely.

### E2E-005 - Five-video pilot

**Priority:** P0 release gate  
**Given:** Three destination clusters.  
**When:** Five videos are produced.  
**Pass:** At least four use only routine acquisition and final approval gates; zero published location mismatches; all final media passes QC.

---

## 3. Installation and system tests

### SYS-001 - Clean Windows install

Install on supported Windows x64 without Node, Python, or a developer environment. App launches and first-run setup opens.

### SYS-002 - FFmpeg diagnostic

App detects configured/bundled ffmpeg and ffprobe, records versions, and validates one test encode/probe.

### SYS-003 - Hardware encoder discovery

App tests available NVENC, Quick Sync, AMD AMF, and software fallback without crashing. Unsupported encoders are disabled.

### SYS-004 - Invalid path handling

Read-only, missing, offline NAS, and insufficient-space paths produce clear exceptions and do not corrupt state.

### SYS-005 - Tray/background operation

Closing the main window leaves eligible jobs running in the tray. Explicit quit checkpoints/stops safely.

### SYS-006 - Power management

During final render/upload, app prevents suspension as configured and releases the blocker afterward.

### SYS-007 - Device-local media tool trust

Custom FFmpeg and FFprobe binaries cannot run until a local inspection records canonical path, role, SHA-256, size, signature status, explicit permissions acknowledgement, and a successful bounded version probe.

### SYS-008 - Changed media tool fail-closed behavior

A missing, replaced, role-mismatched, or untrusted custom media tool never executes; packaged builds safely retain bundled-tool precedence and development PATH fallback remains visibly labeled.

---

## 4. Catalog import and metadata tests

### CAT-001 - Full 26k import

Import at least 26,000 rows from XLSX. UI remains responsive; counts match source; report is generated.

### CAT-002 - CSV import

Equivalent CSV mapping produces the same canonical asset identities and effective values.

### CAT-003 - Stable identity

Reordered rows and changed row numbers do not create duplicate assets.

### CAT-004 - Import diff

Second import correctly reports new, changed, conflicting, missing, and unchanged rows before commit.

### CAT-005 - Human override preservation

A human-corrected city/location remains effective when later source import contains the prior incorrect value.

### CAT-006 - Null normalization

`Not Found`, blank, and N/A values become null with missing reason and do not pollute search.

### CAT-007 - Duration/size/rate parsing

Representative `0:07`, `0:35`, MB/GB, 29.97, 30, and malformed values parse or enter exception state correctly.

### CAT-008 - Search relevance

Exact location/activity/object queries return matching assets ahead of unrelated same-country assets.

### CAT-009 - Filter performance

Warm common searches over 26k records meet p95 target and do not block the renderer.

### CAT-010 - FTS update

Changing effective metadata updates search results transactionally.

### CAT-011 - Duplicate source URL

Duplicate rows with the same canonical URL merge into one source asset with revision evidence.

### CAT-012 - Import cancellation

Cancel during staging or pre-commit leaves existing catalog unchanged.

### CAT-013 - Failed import rollback

Injected validation/database error does not partially apply the import.

---

## 5. Geographic grounding tests

### GEO-001 - Exact landmark pass

A scene requiring Mỹ Sơn Sanctuary accepts only assets with an effective place at Mỹ Sơn landmark/feature granularity.

### GEO-002 - Same-country rejection

A Vietnam temple in another city is rejected for a Mỹ Sơn exact-location scene even with strong semantic similarity.

### GEO-003 - City-level contextual pass

A scene narrating general Da Nang coastline may use a verified Da Nang beach asset when no specific beach is named.

### GEO-004 - Insufficient granularity

An asset known only as Vietnam cannot support a Da Nang or Mỹ Sơn claim.

### GEO-005 - Vision conflict

If visual analysis contradicts imported metadata, scene is blocked or lowered in confidence; imported value is not silently retained as verified.

### GEO-006 - Human verification precedence

Human verified place overrides AI suggestion and survives refresh.

### GEO-007 - Parent/child logic

Place hierarchy correctly handles city, landmark, and feature descendants without treating sibling landmarks as compatible.

### GEO-008 - No silent fallback

When no exact footage exists, output uses rewrite/graphic/acquisition/removal, never unrelated visual substitution.

---

## 6. Coverage and topic tests

### TOP-001 - Coverage-first ideation

Topic generator receives only qualified coverage clusters and does not propose unsupported destinations.

### TOP-002 - Insufficient coverage rejection

A high-demand keyword with too few unique shots fails feasibility before weighted opportunity ranking.

### TOP-003 - Demand proxy labeling

Google Search metrics are stored/displayed as proxy and never as exact YouTube search volume.

### TOP-004 - Competition scoring explainability

Opportunity record stores raw YouTube result features and component scores.

### TOP-005 - Topic duplicate prevention

System rejects materially duplicate queued/published topic unless viewer promise differs and is documented.

### TOP-006 - Queue limit

Autopilot does not create another waiting-download project when configured limit is reached.

### TOP-007 - Budget gate

New topic generation pauses before provider calls when monthly budget is exhausted.

---

## 7. Research and script tests

### SCR-001 - Sourced material claims

Every material factual claim in final script maps to at least one persisted source.

### SCR-002 - No invented source

Injected model response containing unknown source ID fails validation.

### SCR-003 - Time-sensitive freshness

Stale price/hours claim is refreshed or omitted before script lock.

### SCR-004 - Conflicting sources

Material conflict enters exception or is removed; app does not choose arbitrarily without policy/evidence.

### SCR-005 - Visual-first constraint

Provisional script contains required visual treatment and catalog coverage for every narration beat.

### SCR-006 - Two-pass rewrite

After downloaded footage fails, final script narrows/rephrases only affected beats while preserving valid sections.

### SCR-007 - Script schema validation

Malformed provider output receives one corrective attempt and then a permanent structured error, not partial persistence.

### SCR-008 - Claim wording fidelity

Final wording does not exceed what cited source actually supports.

### SCR-009 - Versioning

Every rewrite creates parent-linked version and does not overwrite locked prior version.

---

## 8. Matching and storyboard tests

### MAT-001 - Hard filters before scoring

Candidate from wrong location never appears, regardless of semantic/text score.

### MAT-002 - Candidate explanation

Every selected candidate has score components and plain-language reasons.

### MAT-003 - Source reuse limit

Global optimizer respects configured maximum source uses unless explicit exception is recorded.

### MAT-004 - Duplicate cluster avoidance

Perceptually similar candidates are not placed adjacent and are penalized globally.

### MAT-005 - Shot variety

Sequence does not contain more than configured consecutive identical shot-type/motion combinations when alternatives exist.

### MAT-006 - Hero reservation

Highest-quality hero candidate is reserved for hook/major transition when policy requests it.

### MAT-007 - Severe crop penalty

Candidate requiring a crop below effective-resolution gate is rejected for full-screen treatment.

### MAT-008 - Beat/shot separation

A 15-second narration beat is represented by multiple shots, each <= 7 seconds.

### MAT-009 - Graphics fallback

Abstract/historical claim without footage is assigned map/graphic, not generic footage.

### MAT-010 - Determinism

Same catalog, policy, and candidate scores produce the same selected storyboard unless a stochastic model stage is explicitly versioned.

---

## 9. Acquisition and watcher tests

### ACQ-001 - Ordered manifest

Manifest minimizes downloads and identifies primary, alternate, hero, and license-only items.

### ACQ-002 - URL allowlist

Only valid HTTPS Envato URLs open through the acquisition command.

### ACQ-003 - Temporary file ignored

`.crdownload`/`.part` is not ingested.

### ACQ-004 - Stable file detection

A growing file is not considered complete until configured stability checks pass.

### ACQ-005 - Active-item auto mapping

One-at-a-time file maps automatically to the active manifest item with evidence.

### ACQ-006 - Ambiguous mapping

Two plausible active items create one clear operator mapping exception; app does not guess below threshold.

### ACQ-007 - Duplicate physical file

Same SHA-256 is stored once and linked to the new source/project record.

### ACQ-008 - License-only reuse

Previously local asset creates no download task, only project-license task.

### ACQ-009 - Missing license blocker

Final QC fails when a used asset is still `pending` or `conflict`.

### ACQ-010 - Wrong file quarantine

Mismatched file is not attached to expected asset and is safely quarantined/returned.

---

## 10. Media ingest and analysis tests

### MED-001 - Original preservation

Original file hash before and after processing is identical.

### MED-002 - Actual metadata override

ffprobe actual width/height/frame rate/codec are stored separately and used for production eligibility.

### MED-003 - 720p proxy

4K input produces correct aspect-preserving 720p proxy and fast seek/playback.

### MED-004 - Black-frame detection

Fixture with black beginning/end is excluded from candidate windows.

### MED-005 - Frozen-frame detection

Long frozen region is flagged and not selected.

### MED-006 - Corrupt file

Truncated/corrupt fixture creates media exception without crashing service host.

### MED-007 - Segment limits

Every generated candidate segment is <= 7000 ms.

### MED-008 - Sliding windows

Single continuous 25-second stock clip produces multiple candidate windows but respects per-source diversity caps.

### MED-009 - Contact-sheet minimization

Vision request contains derivative images/metadata, not original multi-gigabyte file.

### MED-010 - Analysis cache

Reprocessing unchanged source with same pipeline version reuses derivatives.

### MED-011 - Pipeline invalidation

Changing analysis version marks relevant derivatives stale and regenerates without changing original.

---

## 11. Resolution and render tests

### REN-001 - Default 1080p

Mixed 4K/1080p eligible sources produce 1920x1080 H.264/AAC MP4.

### REN-002 - 4K qualification pass

All full-screen 4K sources remain >= 3840x2160 after crop; output qualifies and renders 4K.

### REN-003 - 4K blocker

One 1080p or over-cropped scene forces 1080p and blocker report names exact shot.

### REN-004 - No 1080p upscaling

A 720p source is rejected as full-screen for 1080p; allowed only as non-upscaled inset if policy permits.

### REN-005 - Rotation handling

Vertical/rotated metadata is applied before effective-resolution calculation.

### REN-006 - Shot duration hard gate

Manifest containing 7001 ms visual shot fails pre-render QC.

### REN-007 - Final media profile

ffprobe confirms MP4, H.264, AAC, yuv420p, progressive, 48 kHz, expected resolution and frame rate.

### REN-008 - Fast start

Final output is seekable promptly and passes configured fast-start validation.

### REN-009 - Mixed frame rates

24/29.97/30 inputs render to selected project rate without frame interpolation and with correct duration.

### REN-010 - Alpha source

Alpha asset is composited to opaque final MP4 without preserving unsupported transparency.

### REN-011 - HDR/log normalization

HDR/log fixture is detected and either tone-mapped by approved profile or blocked; no unannounced washed-out output.

### REN-012 - Range preview

Editing one scene renders only requested range and does not trigger full final render.

### REN-013 - Render interruption

Forced kill removes/ignores partial output and safely retries from manifest.

### REN-014 - Render idempotency

Identical manifest/profile reuses validated render unless force is explicit.

---

## 12. Voice, audio, and captions tests

### AUD-001 - Section caching

Change one script section; only its TTS/alignment regenerates.

### AUD-002 - Word timing

Every final narration word has valid nonoverlapping timing or documented low-confidence exception.

### AUD-003 - Pronunciation dictionary

Configured place pronunciation is included in TTS request and survives revision.

### AUD-004 - Missing section

Short/empty provider audio fails before timeline build.

### AUD-005 - Loudness and peak

Final mix meets configured integrated loudness/true-peak tolerances.

### AUD-006 - Silence detection

Unexpected long silence creates blocker/high failure.

### AUD-007 - Music ducking

Speech remains intelligible and music level follows configured ducking policy.

### AUD-008 - Caption generation

SRT and VTT cover final narration, have no overlaps, and stay within video duration.

### AUD-009 - Caption upload

Timed caption track attaches to private YouTube video and ID is stored.

---

## 13. Packaging tests

### PKG-001 - Three distinct concepts

Generated title/thumbnail concepts differ materially in angle, not trivial wording.

### PKG-002 - Actual-frame thumbnail

Every thumbnail records a frame from used project footage.

### PKG-003 - No deceptive destination

Thumbnail and title place match final video and verified footage.

### PKG-004 - Thumbnail format/size

JPEG/PNG <= 2 MB, 1280x720 default, uploads successfully.

### PKG-005 - Chapter validation

First chapter starts at 0:00, timestamps increase, and fit final duration.

### PKG-006 - Package hash approval

Changing title/thumbnail/description after approval invalidates prior approval.

---

## 14. YouTube publishing tests

### YT-001 - OAuth token encryption

Refresh token is encrypted at rest and never exposed to renderer/logs.

### YT-002 - Private default

Every automatic upload starts private.

### YT-003 - Resumable network recovery

Network interruption resumes same session without duplicate video.

### YT-004 - Duplicate upload prevention

Same final SHA-256/channel combination cannot start a second upload while a valid publication record exists.

### YT-005 - Processing polling

App waits until YouTube reports usable processing state before final review.

### YT-006 - API restriction fallback

Unverified/restricted API project results in private upload and exact Studio fallback, not false publication status.

### YT-007 - Synthetic-media field

Configured disclosure is included and recorded.

### YT-008 - Schedule rule

Scheduling request uses private status and valid future time; invalid past/unsupported request is caught before API call.

### YT-009 - OAuth callback state and PKCE

Loopback OAuth accepts only the fixed callback route and method, requires an unexpired single-use 256-bit state, and exchanges the code with the matching S256 PKCE verifier.

### YT-010 - Explicit YouTube channel confirmation

OAuth credentials remain temporary until the operator confirms the exact returned channel; replacement shows both identities and requires a separate explicit confirmation.

---

## 15. Analytics tests

### ANA-001 - Snapshot schedule

Jobs are created at configured intervals after publication.

### ANA-002 - Retention mapping

Elapsed ratio maps correctly to final milliseconds, narration beat, and selected visual shot.

### ANA-003 - Search-term storage

YouTube search traffic details are stored and linked to publication.

### ANA-004 - Learning threshold

No automatic strategy mutation occurs below configured video/view/sample thresholds.

### ANA-005 - Reversible recommendation

Applied scoring-weight change stores previous value and can be rolled back.

---

## 16. Job engine and resilience tests

### JOB-001 - Lease recovery

Expired `RUNNING` job is safely reclaimed.

### JOB-002 - Dependency ordering

Downstream job cannot run before success dependency.

### JOB-003 - Idempotent provider call

Same validated request hash returns cached result and creates no new chargeable call.

### JOB-004 - Bounded retry

Transient errors back off; maximum attempt count enforced.

### JOB-005 - Permanent validation error

Malformed permanent input does not retry indefinitely.

### JOB-006 - Human wait

Waiting download/auth job persists across restart without consuming retry count.

### JOB-007 - Project lock

Two state-mutating workflows cannot concurrently advance the same project.

### JOB-008 - Resource concurrency

Final render concurrency limit is respected while UI and lightweight jobs remain responsive.

### JOB-009 - Budget stop

Provider call that would exceed hard budget is not sent.

### JOB-010 - Bounded provider transport

Every credentialed provider request has bounded connect/overall timeouts, cancellation, redirect count, and response size; every redirect destination is revalidated before use.

### JOB-011 - State-safe manual retry

Manual retry allows only failed jobs, compares the expected state/version atomically, preserves every invalid-state job and owned lock/lease field, and permits at most one successful transition.

### JOB-012 - Audited retry attempt grant

A permanent failure can retry only with an operator reason and one explicit attempt grant; prior failure context and the exact budget change remain reconstructable from durable audit history.

### JOB-013 - Side-effect retry reconciliation

An upload job cannot become runnable until its durable publication identity is reconciled as no remote effect, a reusable upload session, or an existing remote video; identity mismatch remains blocked.

---

## 17. Security tests

### SEC-001 - Renderer Node isolation

Renderer cannot call `require`, access filesystem, database, process, or environment variables.

### SEC-002 - IPC schema rejection

Invalid/unknown IPC payload is rejected and logged safely.

### SEC-003 - Sender validation

IPC from unauthorized web contents is rejected.

### SEC-004 - Navigation/new-window block

Untrusted navigation and window creation are blocked.

### SEC-005 - External URL validation

HTTP, javascript, file, and nonallowlisted URLs are rejected.

### SEC-006 - Media protocol traversal

`videofactory://` cannot access paths outside authorized media records; directory traversal rejected.

### SEC-007 - Secret redaction

Diagnostic bundle contains no provider keys, OAuth tokens, or auth headers.

### SEC-008 - CSP

Renderer loads with restrictive CSP and no unsafe remote script execution.

### SEC-009 - OAuth callback-data redaction

Authorization codes, state, PKCE values, tokens, and callback query strings never reach renderer payloads, logs, audit records, or user-facing errors.

### SEC-010 - Provider endpoint trust and SSRF boundary

Remote provider calls require a confirmed HTTPS origin, public DNS answers, address-pinned connections, and same-origin redirects; explicit local mode accepts only loopback without a reusable credential.

### SEC-011 - Provider credential-to-origin binding

A stored provider credential is unusable after an endpoint-origin change or profile import until the canonical origin is explicitly confirmed and the credential is rebound.

### SEC-012 - Portable profile executable isolation

Portable settings profiles cannot export or import executable paths, binary identity, trust receipts, or developer fallback flags; safe version-1 settings still import with explicit exclusion warnings.

---

## 18. Backup and restore tests

### BAK-001 - Online backup

Backup completes after checkpoint while app remains usable; integrity check passes.

### BAK-002 - Restore

Restore returns catalog/projects/jobs/settings to expected state.

### BAK-003 - Missing derivative rebuild

After deleting proxies/keyframes, restored project rebuilds them from original hashes.

### BAK-004 - Missing original detection

Restore identifies missing original and blocks final reproduction with exact file/hash list.

### BAK-005 - Retention policy

Daily/weekly/monthly rotation deletes only expired backups.

---

## 19. Performance and usability tests

### PERF-001 - Startup

Dashboard usable within target on warm normal database.

### PERF-002 - Background responsiveness

Catalog scroll/search and navigation remain responsive during proxy generation and draft render.

### PERF-003 - Virtualized table

Library table handles 26k rows without rendering all DOM rows.

### PERF-004 - Progress visibility

Long jobs update progress at least every configured interval and show clear current phase.

### UX-001 - Two-gate clean project

Operator activity log for a clean project contains only acquisition actions and final approval, excluding optional inspection.

### UX-002 - Next action clarity

At every waiting state, dashboard presents one primary next action and plain-language reason.

### UX-003 - Exception resolution

A nontechnical operator can resolve an ambiguous file mapping using thumbnail/title/metadata evidence without database/file exploration.

### UX-004 - Undo metadata edit

Operator can restore prior effective metadata revision.

---

## 20. Release evidence integrity tests

### REL-001 - Clean exact release validation source

Release validation admits only a clean repository at an exact 40-character HEAD and tree, including detached CI checkouts, and rejects before touching generated evidence otherwise.

### REL-002 - Stale or non-release evidence rejection

Changed HEAD/tree, dirty, cross-workflow-SHA, development-qualified, and runtime/claims-digest-mismatched receipts are rejected by acceptance recording and release provenance.

### REL-003 - Generated and historical evidence lifecycle

Current validation receipts remain untracked exact-workflow-SHA artifacts, while a tracked machine-readable historical index identifies alpha.7 without claiming to validate the current checkout.

---

## 21. Release gates

### Alpha gate

- Import/search works.
- One guided project reaches provisional storyboard and download manifest.
- Watched-folder ingest and 720p proxy work.

### Beta gate

- Complete private-upload vertical slice passes E2E-001.
- Core geographic, no-upscale, license, render, and security P0 tests pass.
- Restart recovery passes at every major stage.

### Production gate

- All P0 tests pass.
- Five-video pilot passes E2E-005.
- Backup/restore rehearsed.
- Installer and clean-machine validation complete.
- No open blocker/high defects.
