# Project, Job, Approval, and Exception State Machine

## 1. State-machine principles

- The service host is the sole authority for project transitions.
- Every transition is transactional and audited.
- A project state describes the highest-level production stage; individual jobs provide detailed execution state.
- Human waiting states are explicit and never represented as generic failures.
- Restart recovery is based on durable state, leases, checkpoints, and idempotency keys.
- A project can be paused from almost any nonterminal state without losing completed artifacts.

---

## 2. Project states

| State | Meaning | Automatic next action |
|---|---|---|
| `CREATED` | Project record and policy snapshot exist | Queue catalog coverage job |
| `ANALYZING_OPPORTUNITY` | Topic/keyword/coverage analysis running | Select/reject topic |
| `TOPIC_SELECTED` | Qualified topic locked | Create research plan |
| `RESEARCHING` | Sources and fact pack being created | Generate provisional script |
| `SCRIPTING_PROVISIONAL` | Visual-first script and scene contracts being generated | Build provisional storyboard |
| `STORYBOARD_PROVISIONAL` | Metadata-based candidate selection/global optimization | Build acquisition manifest |
| `WAITING_FOR_DOWNLOADS` | Routine human acquisition gate | Detect/ingest files |
| `INGESTING_MEDIA` | Files are being hashed, mapped, probed, and proxied | Analyze footage |
| `VERIFYING_FOOTAGE` | Candidate segments checked against contracts | Repair/reselect/finalize |
| `FINALIZING_SCRIPT` | Script rewritten to verified footage and locked | Generate voice |
| `GENERATING_VOICE` | TTS and timing/alignment in progress | Build final timeline |
| `BUILDING_TIMELINE` | Shots, graphics, captions, and audio assembled | Pre-render QC |
| `RENDERING_DRAFT` | Draft/range render in progress | Draft QC |
| `QC_DRAFT` | Automated checks and repairs | Final render or repair loop |
| `RENDERING_FINAL` | Full-resolution render in progress | Final QC |
| `QC_FINAL` | Final media, semantic, rights, and package checks | Upload private |
| `UPLOADING_PRIVATE` | Resumable YouTube upload and attachments | Wait for processing |
| `WAITING_YOUTUBE_PROCESSING` | YouTube is processing video | Final review |
| `WAITING_FINAL_APPROVAL` | Routine human publication gate | Publish/schedule/revise |
| `SCHEDULED` | YouTube publication scheduled | Wait for publication |
| `PUBLISHED` | Public release confirmed | Schedule analytics |
| `ANALYTICS_ACTIVE` | Performance snapshots being collected | Remain active/archive |
| `PAUSED` | Operator/system paused workflow | Resume prior state |
| `BLOCKED_EXCEPTION` | Blocker requires resolution | Resume stored prior state |
| `AWAITING_MANUAL_STUDIO_ACTION` | API restriction requires YouTube Studio action | Confirm state |
| `CANCELLED` | Project intentionally stopped | None |
| `FAILED` | Permanent unrecoverable project failure | Clone/restart manually |
| `ARCHIVED` | Completed project moved to inactive storage | None |

---

## 3. Main transition graph

```text
CREATED
  -> ANALYZING_OPPORTUNITY
  -> TOPIC_SELECTED
  -> RESEARCHING
  -> SCRIPTING_PROVISIONAL
  -> STORYBOARD_PROVISIONAL
  -> WAITING_FOR_DOWNLOADS
  -> INGESTING_MEDIA
  -> VERIFYING_FOOTAGE
  -> FINALIZING_SCRIPT
  -> GENERATING_VOICE
  -> BUILDING_TIMELINE
  -> RENDERING_DRAFT
  -> QC_DRAFT
  -> RENDERING_FINAL
  -> QC_FINAL
  -> UPLOADING_PRIVATE
  -> WAITING_YOUTUBE_PROCESSING
  -> WAITING_FINAL_APPROVAL
      -> SCHEDULED -> PUBLISHED -> ANALYTICS_ACTIVE
      -> PUBLISHED -> ANALYTICS_ACTIVE
      -> BUILDING_TIMELINE / FINALIZING_SCRIPT / STORYBOARD_PROVISIONAL
```

At any active state:

```text
-> PAUSED
-> BLOCKED_EXCEPTION
-> CANCELLED
```

After resolution:

```text
PAUSED -> prior_state
BLOCKED_EXCEPTION -> prior_state or defined repair state
```

---

## 4. Transition prerequisites

### `ANALYZING_OPPORTUNITY -> TOPIC_SELECTED`

Required:

- Feasibility status `pass`.
- Opportunity score above configured threshold.
- Visual coverage and geographic confidence above minimum.
- Topic not materially duplicate of queued/published project.

Failure behavior:

- Evaluate next candidate.
- If no candidate passes, create `NO_QUALIFIED_TOPIC` exception and pause scheduler.

### `STORYBOARD_PROVISIONAL -> WAITING_FOR_DOWNLOADS`

Required:

- Every narration beat has permitted visual treatment.
- Acquisition manifest exists.
- Critical hero/landmark scenes have primary and required alternates.
- Estimated storage and budget pass.

### `WAITING_FOR_DOWNLOADS -> INGESTING_MEDIA`

Required:

- All mandatory acquisition items are file-mapped or confirmed license-only.
- Optional alternates may remain incomplete when policy permits.
- Batch license attestation exists.

Partial behavior:

- Individual files can process while other downloads remain.
- Project remains `WAITING_FOR_DOWNLOADS` until mandatory set complete.

### `VERIFYING_FOOTAGE -> FINALIZING_SCRIPT`

Required:

- Every beat resolved by verified footage, contextual footage, map/graphic, or allowed text/archival treatment.
- Zero unresolved exact-location conflicts.
- Selected visual-shot coverage meets policy.

### `FINALIZING_SCRIPT -> GENERATING_VOICE`

Required:

- Final script version schema-valid.
- All material claims accepted and source-linked.
- Script locked.
- Pronunciation dictionary generated.

### `QC_FINAL -> UPLOADING_PRIVATE`

Required:

- Zero blocker/high QC failures.
- Zero unsupported claims.
- Zero location conflicts.
- Every used stock asset has acceptable project-license state.
- Thumbnail/package assets validate.
- Final render hash exists.

### `WAITING_FINAL_APPROVAL -> SCHEDULED/PUBLISHED`

Required:

- Explicit operator action.
- Approval applies to current final-render and package hashes.
- Any change after approval invalidates approval and returns to review.

---

## 5. Revision routing from final review

When the operator sends a project back, route to the smallest valid stage:

| Reason | Return state |
|---|---|
| Title/description/thumbnail only | `QC_FINAL` packaging substage |
| Caption typo | `BUILDING_TIMELINE` caption substage |
| Voice pronunciation | `GENERATING_VOICE` affected section |
| Script factual issue | `FINALIZING_SCRIPT` |
| Wrong/weak shot | `VERIFYING_FOOTAGE` affected contract |
| New footage required | `WAITING_FOR_DOWNLOADS` |
| Major topic/story change | `SCRIPTING_PROVISIONAL` or new project |

Unchanged artifacts remain cached.

---

## 6. Job state machine

```text
QUEUED
  -> READY
  -> RUNNING
      -> SUCCEEDED
      -> WAITING_EXTERNAL
      -> WAITING_HUMAN
      -> RETRY_SCHEDULED
      -> FAILED_RETRYABLE
      -> FAILED_PERMANENT
      -> CANCELLED
```

Recovery:

```text
RUNNING with expired lease -> READY or RETRY_SCHEDULED
partial output -> validate or delete
existing validated output with same idempotency key -> SUCCEEDED (cached)
```

### 6.1 Job categories

| Category | Examples | Recovery strategy |
|---|---|---|
| Pure/deterministic | scoring, manifest validation | Re-run safely |
| Cached paid API | LLM, TTS, vision | Reuse by request hash; bounded retry |
| Media derivative | proxy, keyframes | Delete partial; regenerate |
| Final render | full FFmpeg render | Delete partial; restart from cached inputs |
| Resumable external | YouTube upload | Resume session where supported |
| Human wait | Envato acquisition, re-authentication | Persist until explicit resolution |

### 6.2 Job dependency behavior

- `success`: downstream job runs only after dependency succeeds.
- `completion`: downstream cleanup/notification runs after any terminal outcome.
- Circular dependencies are rejected at creation.

---

## 7. Approval gates

### 7.1 Acquisition gate

State: `WAITING_FOR_DOWNLOADS`.

Routine actions:

- Start/open next acquisition item.
- Copy license project name.
- Download/license manually.
- Allow watcher to detect and process.

Approval is represented by:

- Batch attestation for license naming.
- File mapping or license-only completion.

### 7.2 Final gate

State: `WAITING_FINAL_APPROVAL`.

Approval record contains:

- Operator ID/name.
- Timestamp.
- Final-render SHA-256.
- Thumbnail SHA-256.
- Metadata/package hash.
- Selected action and schedule.

Approval becomes invalid if any referenced hash changes.

---

## 8. Exception taxonomy

### 8.1 Catalog and metadata

- `IMPORT_SCHEMA_INVALID`
- `IMPORT_ROW_CONFLICT`
- `ASSET_IDENTITY_COLLISION`
- `PLACE_NORMALIZATION_CONFLICT`
- `LOCATION_CONFIDENCE_TOO_LOW`
- `THUMBNAIL_UNAVAILABLE`

### 8.2 Topic/research/script

- `NO_QUALIFIED_TOPIC`
- `INSUFFICIENT_VISUAL_COVERAGE`
- `RESEARCH_SOURCE_CONFLICT`
- `FACT_FRESHNESS_EXPIRED`
- `SCRIPT_SCHEMA_INVALID`
- `UNSUPPORTED_NARRATION`

### 8.3 Acquisition/media

- `ASSET_UNAVAILABLE`
- `DOWNLOAD_MAPPING_AMBIGUOUS`
- `WRONG_FILE_DETECTED`
- `MEDIA_CORRUPT`
- `DECLARED_ACTUAL_METADATA_CONFLICT`
- `NO_USABLE_SEGMENT`
- `EXACT_LOCATION_MISMATCH`
- `LICENSE_STATUS_MISSING`

### 8.4 Voice/render/QC

- `TTS_PROVIDER_FAILURE`
- `PRONUNCIATION_VALIDATION_FAILED`
- `FFMPEG_UNAVAILABLE`
- `HARDWARE_ENCODER_FAILED`
- `RENDER_FAILED`
- `DISK_SPACE_LOW`
- `SHOT_DURATION_VIOLATION`
- `EFFECTIVE_RESOLUTION_FAILURE`
- `AUDIO_QC_FAILURE`
- `SEMANTIC_QC_FAILURE`

### 8.5 Publishing/analytics

- `YOUTUBE_AUTH_EXPIRED`
- `YOUTUBE_QUOTA_EXHAUSTED`
- `YOUTUBE_UPLOAD_FAILED`
- `YOUTUBE_PROCESSING_FAILED`
- `YOUTUBE_API_RESTRICTION`
- `DUPLICATE_UPLOAD_DETECTED`
- `ANALYTICS_PERMISSION_MISSING`

### 8.6 System

- `DATABASE_INTEGRITY_FAILURE`
- `MEDIA_PATH_UNAVAILABLE`
- `BACKUP_FAILED`
- `API_BUDGET_EXCEEDED`
- `WORKER_CRASH_LOOP`

---

## 9. Exception resolution behavior

Every exception defines:

- Blocking scope: job, project, scheduler, or application.
- Safe automatic alternatives.
- Required operator decision if any.
- Return state after resolution.
- Whether an override is allowed.

Overrides are prohibited for:

- Missing required license state.
- Exact-location contradiction.
- Corrupt final output.
- Duplicate upload uncertainty.
- Database integrity failure.

An operator may lower specificity or change the visual treatment rather than override accuracy.

---

## 10. Scheduler behavior

Default constraints:

- Maximum two active projects.
- Maximum one project in `WAITING_FOR_DOWNLOADS`.
- Maximum one project in `WAITING_FINAL_APPROVAL`.
- Do not start a new topic when disk, budget, or authentication health is red.
- Scheduler prioritizes finishing older projects before generating new ones.
- Scheduled publication cadence does not force release of a failed-quality video.

---

## 11. State-transition audit event

Every transition emits:

```json
{
  "eventType": "project.state_changed",
  "projectId": "project-id",
  "from": "VERIFYING_FOOTAGE",
  "to": "FINALIZING_SCRIPT",
  "reason": "All 42 scene contracts resolved",
  "prerequisiteSnapshot": {
    "unresolvedContracts": 0,
    "locationConflicts": 0,
    "coveragePercent": 96.4
  },
  "timestamp": "2026-07-30T12:00:00Z"
}
```
