# Implementation Plan and Delivery Gates

## 1. Delivery strategy

Build one complete vertical slice before expanding feature breadth.

The correct sequence is:

```text
foundation
-> catalog
-> visual-grounded planning
-> acquisition/ingest
-> verified timeline
-> voice/render/QC
-> private YouTube upload
-> autopilot/analytics/hardening
```

Do not start by building a sophisticated editor, advanced dashboard, multi-channel support, or every AI provider. The first meaningful milestone is one real video produced end to end.

---

## 2. Engineering rules

1. Every phase ends with executable acceptance evidence.
2. No placeholder metrics may be presented as real production results.
3. No fabricated media processing or simulated final output in a release path.
4. All provider output is schema-validated.
5. All long-running work is a durable job.
6. All source media operations preserve the original.
7. Every new state transition has tests.
8. Every paid API call has an idempotency key and budget check.
9. Every release build runs security, migration, and media fixture tests.
10. P0 gates cannot be waived by UI polish.

---

## 3. Phase 0 - Repository and desktop foundation

### Scope

- Monorepo/workspaces.
- Electron main, preload, renderer, and service-host process.
- Strict TypeScript and lint/test setup.
- Typed IPC envelopes and first health query.
- SQLite migration runner.
- Structured logs.
- Windows development and package build.
- Settings/path setup screen.
- Secret storage abstraction.
- FFmpeg/ffprobe discovery diagnostic.

### Deliverables

- App launches packaged and development builds.
- Renderer has no Node integration.
- Service host starts/restarts and responds to IPC.
- Database migration and basic backup work.
- Diagnostic report identifies paths, FFmpeg, disk, and encoders.

### Gate

Pass: `SYS-001` through `SYS-005`, `SEC-001` through `SEC-005` relevant subset, and migration smoke tests.

---

## 4. Phase 1 - Catalog and metadata foundation

### Scope

- XLSX/CSV staging/import.
- Column mapper matching current spreadsheet.
- Stable asset identity and raw row preservation.
- Normalization for duration, size, frame rate, nulls, resolution, tags.
- Import diff and conflict behavior.
- SQLite repositories and FTS5 index.
- Library grid/table and filters.
- Metadata revision/edit/undo.
- Initial place hierarchy and confidence fields.

### Deliverables

- Full 26k-row catalog imported.
- Search and filters performant.
- Second import shows correct diff.
- Human corrections survive refresh.
- Coverage data can be queried by place/tag/shot.

### Gate

Pass all P0 `CAT-*` tests and initial `GEO-006/007` tests.

---

## 5. Phase 2 - Coverage, topic, research, and script planning

### Scope

- Coverage-analysis service.
- Topic candidate structured prompt/schema.
- YouTube search/competition adapter.
- Optional Google Search proxy adapter interface.
- Opportunity score and explainability.
- Research provider and fact/source tables.
- Claim extraction/freshness/conflict validation.
- Provisional script schema.
- Chapter/section/beat hierarchy.
- Scene-contract generation.
- Project state machine through `STORYBOARD_PROVISIONAL`.

### Deliverables

- Select destination cluster and generate ranked viable topics.
- Produce cited fact pack.
- Produce provisional script with coverage status for every beat.
- Reject unsupported high-demand topic.

### Gate

Pass P0 `TOP-*`, `SCR-*`, and core `GEO-*` tests.

---

## 6. Phase 3 - Matching and acquisition workflow

### Scope

- Hard-filter candidate retrieval.
- BM25/metadata score components.
- Global diversity optimizer.
- Candidate explanations.
- Acquisition risk planner.
- Downloads UI.
- Safe external URL opening.
- Batch project-license attestation.
- Watched-folder completion detection.
- Active-item file mapping.
- License-only tasks.
- Project states through `WAITING_FOR_DOWNLOADS` and `INGESTING_MEDIA`.

### Deliverables

- Complete thumbnail-based provisional storyboard.
- Minimum acquisition manifest.
- Operator can download one item at a time and app advances automatically.

### Gate

Pass all P0 `MAT-*` and `ACQ-*` tests except those depending on later media verification.

---

## 7. Phase 4 - Media ingest, segments, and actual verification

### Scope

- SHA-256 content-addressed storage.
- ffprobe parsing.
- 720p proxy generation.
- Keyframe/contact-sheet extraction.
- Black/freeze/corruption checks.
- Scene-cut/sliding-window segment generation.
- Visual provider contact-sheet adapter.
- Contract matching on actual footage.
- Alternate/rewrite/graphic fallback routing.
- Effective-resolution calculations.
- Storyboard finalization.

### Deliverables

- Downloaded source is automatically moved, analyzed, and verified.
- Usable segments <= 7 seconds are created.
- Wrong or weak footage is rejected and repaired without unrelated fallback.
- Final selected shots and source in/out points exist.

### Gate

Pass all P0 `MED-*`, remaining `ACQ-*`, `GEO-*`, `MAT-*`, and `REN-003/004/005/006` pre-render tests.

---

## 8. Phase 5 - Final script, voice, timeline, and draft rendering

### Scope

- Final script rewrite against verified footage.
- Script lock/versioning.
- TTS provider adapter.
- Pronunciation dictionary.
- Timing/alignment fallback.
- SRT/VTT generation.
- Timeline/render-manifest generator.
- Graphics/label renderer.
- FFmpeg command generator.
- Range preview and 720p draft.
- Audio mix/loudness QC.
- Draft media QC and automatic repair loop.

### Deliverables

- Complete draft video with narration, captions, shots, labels, and optional basic music.
- Range regeneration after one changed beat.
- No shot > 7 seconds.

### Gate

Pass P0 `AUD-*` and draft/range portions of `REN-*` plus `E2E-003` scoped regeneration.

---

## 9. Phase 6 - Final render, packaging, and private YouTube upload

### Scope

- Final 1080p render profile.
- Qualified 4K gate/profile if included in P0/P1 target.
- Post-render QC.
- Thumbnail template renderer.
- Three title/thumbnail/description concepts.
- YouTube OAuth and encrypted token storage.
- Resumable private upload.
- Thumbnail/caption/playlist upload.
- Processing polling.
- Final Review screen.
- Approval hash record.
- Schedule/publish and Studio fallback.

### Deliverables

- One real project reaches private YouTube review.
- Final QC report is complete.
- Operator can approve/schedule without entering editor.

### Gate

Pass all P0 `REN-*`, `PKG-*`, `YT-*`, `SEC-*`, and `E2E-001/002`.

---

## 10. Phase 7 - Autopilot, analytics, and hardening

### Scope

- Cadence scheduler and queue depth.
- Notifications/system tray completion.
- YouTube analytics/retention collection.
- Timeline mapping.
- Recommendations with minimum sample gates.
- Cost/usage dashboards.
- Backup/restore UI and rehearsal.
- Diagnostic bundle.
- Installer signing/update strategy.
- Performance profiling and large-library optimization.
- Five-video pilot.

### Deliverables

- App creates next viable project automatically within queue constraints.
- Analytics map to exact beats/shots.
- Backup/restore verified.
- Production installer and operating guide.

### Gate

Pass all remaining P0/P1 targeted tests and `E2E-005`.

---

## 11. Recommended vertical-slice pilot

Use one destination with:

- At least 100 catalog assets.
- Several exact named locations.
- Mix of aerial/wide/detail footage.
- Mostly horizontal 4K/1080p.
- Clear topic opportunity.

Pilot output:

- One 4-6 minute video initially to reduce debug time.
- 40-70 visual shots.
- One narrator.
- Basic location labels and maps.
- No advanced animated graphics.
- 1080p final.
- Private YouTube upload.

After the vertical slice, extend target duration to 6-10 minutes and run the five-video pilot.

---

## 12. Agent work-package format

Every implementation task handed to an agent should include:

```text
Goal
In-scope files/modules
Out-of-scope behavior
Relevant requirements/test IDs
Data/contracts to preserve
Implementation constraints
Commands/tests to run
Completion evidence
```

Example:

```text
Goal: Implement stable watched-download completion and mapping.
Requirements: PRD 12.13, Technical Spec 15, tests ACQ-003 through ACQ-010.
Constraints: no browser automation; ignore temporary files; all mappings audited.
Done when: tests pass, app demo shows one-at-a-time file ingestion, restart safe.
```

---

## 13. Pull-request and completion policy

A work item is complete only when:

- Implementation is real, not mocked in production path.
- Required tests are added and passing.
- No unrelated scope is changed.
- Migration and contract changes are documented.
- UI states include loading, empty, error, retry, and recovery.
- Logs do not leak secrets.
- Acceptance evidence is attached.

A phase is complete only when its gate tests pass on a packaged build, not only in unit tests.

---

## 14. Priority backlog after version 1

1. Google Sheets direct synchronization.
2. Advanced music selection and licensing records.
3. True 4K routine profile after enough footage qualifies.
4. Local semantic vector index.
5. Animated route maps.
6. Multi-language script/voice/package variants.
7. Multiple channels and channel-specific catalogs.
8. Shorts/vertical workflow.
9. Direct uploader metadata feed.
10. Secondary render workstation.

---

## 15. Final release definition

Version 1.0 is released only when:

- All P0 acceptance tests pass.
- Five pilot videos are completed.
- At least four pilots use only acquisition and final-approval routine gates.
- No known exact-location, license, no-upscale, duplicate-upload, or database-integrity blocker remains.
- Backup/restore and clean Windows installation are proven.
- The operator can understand next action and exception resolution without developer tools.
