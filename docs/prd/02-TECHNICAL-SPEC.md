# Part II - Technical Specification

## 1. Technical objective

Build a single-user Windows desktop application that durably orchestrates the entire stock-footage-to-YouTube workflow on one workstation. The system must be local-first, restart-safe, exact-location grounded, and capable of producing a finished private YouTube upload without routine operator intervention after the requested Envato assets are acquired.

The architecture intentionally avoids cloud application infrastructure. Large media remains local. External services are accessed through replaceable adapters.

---

## 2. Frozen architecture

```text
┌──────────────────────────────────────────────────────────────────┐
│ Electron Desktop Application                                     │
│                                                                  │
│  ┌──────────────────────┐       typed IPC       ┌──────────────┐ │
│  │ React Renderer       │ <-------------------> │ Main Process │ │
│  │ UI only              │                       │ window/tray   │ │
│  │ no Node integration  │                       │ secure store  │ │
│  └──────────────────────┘                       │ protocol/IPC  │ │
│                                                  └──────┬───────┘ │
│                                                         │         │
│                                             MessagePort/IPC       │
│                                                         │         │
│  ┌──────────────────────────────────────────────────────▼───────┐ │
│  │ Service Host Utility Process                                │ │
│  │ SQLite owner | job engine | domain services | providers     │ │
│  │ file watcher | scheduler | project state | audit log        │ │
│  └─────────┬──────────────┬───────────────┬───────────────┬────┘ │
│            │              │               │               │      │
│       FFmpeg child   worker threads   HTTPS APIs     filesystem  │
│       processes      when needed      and OAuth      media vault │
└──────────────────────────────────────────────────────────────────┘
```

### 2.1 Why one service-host process

Version 1 uses one durable service-host utility process rather than many microservices. It:

- Owns the SQLite write connection.
- Runs the local job scheduler.
- Calls external AI and YouTube APIs.
- Supervises FFmpeg/ffprobe child processes.
- Watches downloads.
- Emits progress events to the UI.

If the service host exits, the Electron main process restarts it. In-progress jobs return to a recoverable state based on durable checkpoints.

### 2.2 Process responsibilities

#### Renderer process

- React interface.
- Read-only presentation state.
- User commands through the preload API.
- Media playback through the controlled local media protocol.
- No direct filesystem, database, child process, or credential access.

#### Preload layer

- Exposes a small typed API through `contextBridge`.
- Validates command/query/event envelopes.
- Does not expose raw `ipcRenderer`.

#### Electron main process

- App lifecycle, windows, tray, notifications.
- Starts/restarts service host.
- OS dialogs and external-browser opening.
- OS-backed secret encryption/decryption.
- Custom local media protocol with range-request support.
- Validates IPC sender and allowed operations.
- Starts/stops power-save blocking during renders/uploads.

#### Service host

- Domain/business logic.
- SQLite migrations and queries.
- Durable jobs and project transitions.
- Catalog imports.
- Search and ranking.
- API provider calls.
- File watching and storage management.
- Manifest generation.
- QC and publishing workflows.

#### Child processes

- `ffprobe` media inspection.
- `ffmpeg` proxy, frame, audio, draft, final, and QC operations.
- Optional helper executable for specialist analysis later.

---

## 3. Technology stack

### 3.1 Required stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron |
| UI | React + TypeScript |
| Build/dev tooling | Vite-compatible Electron toolchain |
| Packaging | Electron Forge, Windows Squirrel installer |
| Database | SQLite with WAL and FTS5 |
| SQLite access | `better-sqlite3` or equivalent native driver owned by service host |
| Validation | Zod or JSON Schema validators |
| UI data cache | TanStack Query or equivalent |
| Ephemeral UI state | Lightweight local store such as Zustand |
| Spreadsheet import | Streaming XLSX/CSV parser |
| File watching | Chokidar or native watcher wrapper |
| Media | FFmpeg and ffprobe |
| Image composition | Sharp/SVG/Canvas-based template renderer |
| Hashing | Node crypto SHA-256 |
| HTTP/OAuth | Official provider SDKs where practical; otherwise typed fetch client |
| Testing | Vitest, Playwright Electron, fixture-based FFmpeg tests |
| Logging | Structured JSON logs with rolling files |

### 3.2 Version policy

- Pin exact versions in the lockfile.
- Use a currently supported Electron release.
- Upgrade Electron through a dedicated compatibility PR with security and media regression tests.
- Do not hard-code AI model names in business logic. Model identifiers live in settings/provider configuration.
- Database migrations are forward-only in production; backup is required before migration.

### 3.3 TypeScript policy

- `strict: true`.
- No implicit `any`.
- Domain IDs use branded types where useful.
- External responses are parsed through runtime schemas.
- Database rows are mapped to explicit domain objects.
- Renderer cannot import service-host or main-process modules.

---

## 4. Repository structure

```text
apps/
  desktop/
    src/main/              Electron main process
    src/preload/           contextBridge API
    src/renderer/          React application
    forge.config.ts
  service-host/
    src/bootstrap/
    src/jobs/
    src/services/
    src/providers/
    src/media/
    src/storage/
    src/publishing/

packages/
  contracts/               IPC, provider, manifest, and event schemas
  domain/                  entities, policies, scoring, state transitions
  database/                migrations, repositories, FTS, backups
  catalog/                 import, normalization, place taxonomy
  matching/                retrieval, scoring, global diversity selection
  research/                fact packs and source validation
  scripting/               outline, beats, script versions
  media-manifest/          segment and render-manifest generation
  qc/                      QC checks and repair policies
  ui/                      reusable UI components and tokens
  test-fixtures/           media and database fixtures

resources/
  ffmpeg/                  bundled binaries or installer metadata
  templates/               thumbnail, map, title, and overlay templates
  migrations/
  default-config/

scripts/
  build/
  package/
  verify-binaries/
  seed-demo-catalog/
```

Business rules belong in `packages/domain`, not in React components or provider adapters.

---

## 5. Application security model

### 5.1 BrowserWindow defaults

```ts
webPreferences: {
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  preload: PRELOAD_PATH,
  webSecurity: true
}
```

Additional requirements:

- Restrictive Content Security Policy.
- Navigation denied except application routes.
- New windows denied by default.
- `shell.openExternal` only through a URL allowlist and canonical URL validation.
- Do not render Envato, YouTube, or arbitrary websites inside a privileged `webview`.
- Validate every IPC sender, method name, and payload.
- Disable unnecessary permissions.
- Use a custom `videofactory://` protocol instead of unrestricted `file://` access.

### 5.2 Secrets

Secrets include:

- AI provider keys.
- TTS keys.
- Search/keyword keys.
- Google OAuth refresh tokens.

Storage:

- Encrypt with Electron `safeStorage` or equivalent OS-backed encryption.
- Persist encrypted blobs outside normal logs and exports.
- Database stores only credential IDs and redacted metadata.
- Never send secrets to the renderer.
- Redact authorization headers and tokens in logs.

### 5.3 External URL policy

Allowed by default:

- `https://elements.envato.com/...`
- `https://www.youtube.com/...`
- `https://studio.youtube.com/...`
- Configured provider OAuth/consent URLs.

Every URL must:

- Parse successfully.
- Use HTTPS.
- Match an allowed hostname and path policy.
- Be opened through the OS browser.

---

## 6. Local database

### 6.1 Database choice

SQLite is the authoritative local database because the product is single-user, desktop-only, and does not require a server process.

Configuration:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA temp_store = MEMORY;
```

The active database must remain on a local filesystem. Media may be on a NAS, but the database and its WAL/SHM files cannot be placed there.

### 6.2 Connection ownership

- Service host owns the primary read/write connection.
- Renderer has no database connection.
- Long analytical reads use prepared queries and short transactions.
- Only one job mutates a given project at a time through project locks.
- Backup uses SQLite's backup API or a checkpointed safe copy.

### 6.3 Migration policy

- Numbered SQL migrations.
- `schema_migrations` table stores applied migration and checksum.
- Service host acquires exclusive migration lock at startup.
- Backup before any nontrivial migration.
- Application refuses to run against a newer unsupported schema.

### 6.4 Search index

Use FTS5 over the effective searchable representation of each source asset:

- Title.
- Description.
- Tags.
- Country/region/city/location.
- Activity.
- Shot type.
- Scene.
- Objects.
- Time of day.
- Style.

Search document updates when effective metadata changes.

Initial retrieval is FTS5/BM25 plus structured filters. Semantic embeddings are optional P1 because the catalog already has strong structured metadata. If added, they must remain a secondary score and may not override hard geographic filters.

### 6.5 Data model overview

Core domains:

```text
Catalog
  source_imports
  authors
  source_assets
  asset_metadata_revisions
  places
  asset_place_assertions
  asset_tags

Media
  asset_files
  media_derivatives
  asset_segments
  visual_fingerprints

Content planning
  channels
  topic_candidates
  keyword_metrics
  research_sources
  fact_claims
  projects
  scripts
  script_sections
  narration_beats
  scene_contracts
  shot_candidates
  selected_visual_shots

Acquisition and rights
  acquisition_items
  project_asset_licenses

Production
  voice_assets
  render_manifests
  renders
  qc_results

Publishing and learning
  youtube_publications
  analytics_snapshots
  retention_points

Operations
  jobs
  job_attempts
  job_dependencies
  exceptions
  provider_calls
  audit_events
  app_settings
```

The baseline DDL is in `03-DATA-MODEL.sql`.

---

## 7. File and storage architecture

### 7.1 Configurable roots

```text
Data root:       D:\YouTubeFactory\data
Ingest root:     D:\YouTubeFactory\ingest\envato
Cache root:      D:\YouTubeFactory\cache
Media vault:     E:\YouTubeFactory\media   or \\NAS\VideoFactory\media
Project root:    D:\YouTubeFactory\projects
Output root:     E:\YouTubeFactory\output
Backup root:     F:\YouTubeFactory\backups
```

### 7.2 Directory layout

```text
{root}\
  data\
    factory.sqlite
    logs\
    diagnostics\
  ingest\envato\
  media\
    originals\ab\cd\{sha256}.{ext}
    proxies\ab\cd\{sha256}.proxy.mp4
    keyframes\{sha256}\
    contact-sheets\{sha256}\
    segments\{sha256}\
    music\
    graphics\
  projects\{project-id}\
    manifest\
    licenses\
    research\
    script\
    voice\
    captions\
    thumbnails\
    qc\
  output\
    draft\
    review\
    published\
  cache\
    ffmpeg\
    api\
    temp\
  backups\
```

### 7.3 Content-addressable originals

After file completion:

1. Calculate SHA-256.
2. Check `asset_files.sha256`.
3. If new, move atomically into content-addressed path.
4. If duplicate, keep one canonical physical file and delete/move duplicate according to policy.
5. Link expected source asset to the physical file.

Projects never copy originals. They store references to file IDs and in/out points.

### 7.4 Atomic file writes

All generated artifacts:

- Write to `{name}.partial` in the destination filesystem.
- `fsync`/close.
- Validate expected output.
- Atomically rename to final name.
- Insert/update database record only after validation.

### 7.5 Retention policy

- Originals used in published videos: retain indefinitely or cold archive.
- Project licenses/manifests/scripts/final render: retain indefinitely.
- Unused downloaded candidates: configurable 30-90 days.
- Proxies: retain while useful; regenerable.
- Keyframes/contact sheets: retain unless cache pressure.
- Render temp files: delete after validated final output.
- Failed outputs: short retention with diagnostic bundle.

### 7.6 Disk-space safeguards

Before an acquisition or render stage, estimate required space:

```text
required = expected downloads + proxy estimate + render workspace + final output + safety margin
```

Default safety margin: greater of 50 GB or 15% of target volume.

Pause jobs before disk exhaustion.

---

## 8. Catalog import pipeline

### 8.1 Import stages

```text
SELECT FILE
-> SAMPLE/PARSE HEADERS
-> MAP COLUMNS
-> VALIDATE TYPES
-> STAGE RAW ROWS
-> RESOLVE STABLE ASSET KEYS
-> NORMALIZE VALUES
-> COMPUTE DIFF
-> OPERATOR CONFIRMS
-> TRANSACTIONAL UPSERT
-> UPDATE FTS/COVERAGE
-> IMPORT REPORT
```

### 8.2 Stable identity

Preferred source asset identity order:

1. Explicit provider asset ID if parsed from source data/URL.
2. Canonicalized Envato item URL.
3. Stable hash of author + normalized title + canonical URL components.

Spreadsheet row numbers are evidence only and cannot serve as the sole identity.

### 8.3 Normalization rules

Examples:

- `Not Found`, `N/A`, empty, `null` -> actual `NULL` plus missing reason.
- Duration `0:35` -> 35 seconds.
- File size `2.29 GB` -> integer bytes when parseable.
- Resolution text -> declared width/height.
- Frame rate `29.97 fps` -> rational `30000/1001` plus numeric display.
- Comma-separated object/style/tag values -> normalized tag relations while preserving raw text.
- Country/city aliases -> canonical place IDs without deleting raw values.

### 8.4 Change conflict policy

If new source import conflicts with a human override:

- Preserve human override as effective.
- Store new imported value as a revision.
- Create a low/medium metadata conflict exception only when the difference is material.

### 8.5 Import performance

- Parse in chunks.
- Use prepared batch inserts inside bounded transactions.
- Perform FTS rebuild once after bulk import, not per row.
- Emit progress by rows processed and current phase.
- Cancel safely before commit or at chunk boundaries.

---

## 9. Place normalization and geographic grounding

### 9.1 Canonical place entity

```ts
interface Place {
  id: PlaceId;
  name: string;
  normalizedName: string;
  type: 'country' | 'region' | 'city' | 'neighborhood' | 'landmark' | 'feature';
  parentId?: PlaceId;
  countryCode?: string;
  latitude?: number;
  longitude?: number;
  aliases: string[];
}
```

### 9.2 Asset place assertion

An asset may contain multiple assertions from different sources:

```ts
interface AssetPlaceAssertion {
  assetId: AssetId;
  placeId: PlaceId;
  granularity: Place['type'];
  evidenceType: 'imported' | 'uploader_metadata' | 'geocoder' | 'vision' | 'human';
  confidence: number;
  verification: 'unverified' | 'accepted' | 'verified' | 'rejected' | 'conflict';
  evidenceRef?: string;
}
```

### 9.3 Effective location

Compute effective place using precedence and conflict rules. A higher-specificity assertion cannot be accepted solely because a vision model guessed it. Exact landmark narration requires trusted source metadata, coordinates, unmistakable landmark evidence, or human verification.

### 9.4 Scene geography contract

Each narration beat declares:

- Required place.
- Minimum granularity.
- Whether contextual footage is allowed.
- Allowed parent-place fallback.

Example:

```json
{
  "requiredPlaceId": "place_my_son_sanctuary",
  "requiredGranularity": "landmark",
  "contextualFallback": false
}
```

The matching query must exclude assets whose effective place is less specific or unrelated.

---

## 10. Coverage analysis

### 10.1 Estimated usable-shot inventory

Before source download, estimate usable visual shots from declared duration:

```text
estimated_shots = clamp(floor(duration_seconds / preferred_shot_length), 1, max_per_asset)
```

Default preferred shot length: 4.5 seconds. Default pre-download maximum estimate per source asset: 3, to avoid assuming a long single stock clip contains unlimited visual variety.

Apply discount factors for:

- Duplicate title/thumbnail clusters.
- Same location and shot type.
- Low metadata confidence.
- Vertical orientation for horizontal output.
- Declared resolution below required output.
- Missing thumbnail.
- High source-reuse probability.

### 10.2 Coverage dimensions

For each topic cluster calculate:

- Unique source assets.
- Effective visual-shot estimate.
- Location-confidence distribution.
- Shot-type entropy.
- Activity/object diversity.
- Time-of-day diversity.
- Hero-shot availability.
- Transition/detail-shot availability.
- Technical resolution eligibility.
- Expected acquisition count and storage.

### 10.3 Feasibility thresholds

Defaults live in `config/default-autopilot-policy.json`.

For a 6-10 minute video, the engine should generally seek:

- At least 1.35 candidate visual shots per required final shot before download.
- At least 12 unique source assets.
- At least four shot/framing categories.
- At least one verified hero shot.
- At least 85% exact/contextual visual support before graphics.
- No chapter with less than 70% visual support.

Thresholds are configurable and calibrated during pilot production.

---

## 11. Topic and keyword opportunity engine

### 11.1 Candidate generation

Inputs:

- High-coverage place clusters.
- Activities/objects in those clusters.
- Existing channel strategy.
- Published topic history.
- Seasonality configuration.

The language model receives only supportable cluster summaries and returns structured topic candidates. Each topic contains:

- Search-intent keyword set.
- Viewer promise.
- Suggested runtime.
- Required locations/sections.
- Visual coverage mapping.
- Unique angle.
- Evergreen/time-sensitive flag.

### 11.2 YouTube competition acquisition

Use YouTube Data API:

1. `search.list` for top relevant results for each query.
2. `videos.list` for statistics and publication dates.
3. `channels.list` for channel size where needed.

Cache responses by query/region/language/date.

Derived competition features:

- Exact/close title match count.
- Median result age.
- Median/upper-quartile views.
- Approximate views per day.
- Result relevance and topic completeness.
- Number of high-authority incumbent channels.
- Presence of recent small-channel breakthroughs.
- Whether top results leave the proposed viewer promise unanswered.

### 11.3 Demand signals

Use a labeled composite:

- Channel's own YouTube search terms and watch time.
- YouTube result view velocity.
- Google Search average monthly searches as a proxy when configured.
- Seasonality from historical query data.
- Optional third-party estimate.

Every signal stores:

- Provider.
- Geography/language.
- Collection date.
- Confidence.
- Whether it is YouTube-native or proxy.

### 11.4 Score calculation

Use normalized 0-100 components and the PRD weights. Store both raw features and final score so the decision is explainable.

A topic is rejected regardless of score when any hard feasibility gate fails.

### 11.5 Topic deduplication

Before selection, compare against:

- Existing projects.
- Published videos.
- Current queue.
- Semantic/topic signature.

Allow a related topic only when its viewer promise and script coverage differ materially.

---

## 12. Research and claim system

### 12.1 Research provider interface

The system sends a topic brief and receives source candidates. The fact builder extracts atomic claims with citations.

Data flow:

```text
search query plan
-> search results
-> fetch/parse source content through provider
-> atomic claim extraction
-> cross-source comparison
-> fact pack
```

### 12.2 Claim model

```ts
interface FactClaim {
  id: FactClaimId;
  projectId: ProjectId;
  text: string;
  placeId?: PlaceId;
  category: string;
  confidence: number;
  stability: 'stable' | 'time_sensitive';
  validAsOf?: string;
  sourceIds: ResearchSourceId[];
  status: 'proposed' | 'accepted' | 'conflict' | 'rejected';
}
```

### 12.3 Validation rules

- Every accepted material claim has at least one valid source.
- Sensitive/time-sensitive claims should have two sources where practical.
- Source title, URL, access date, and excerpt/summary are persisted.
- The LLM cannot create a source record not present in provider output.
- Script generation references claim IDs, not only free text.

### 12.4 Freshness

Default freshness windows:

- Historical/geographic facts: 365 days or manual.
- Admission prices, opening hours, transport schedules: 30 days.
- Temporary closures/events: 7 days.

The app must either refresh stale time-sensitive claims or omit them.

---

## 13. Script and scene-contract pipeline

### 13.1 Structured outputs

All script-generation calls return schema-validated JSON. Free-form prose is stored only after the structure validates.

Hierarchy:

```ts
ProjectScript
  chapters[]
    sections[]
      beats[]
        narration
        claimIds[]
        visualRequirements
        targetDurationMs
```

### 13.2 Duration estimation

Estimate narration duration using configured voice profile words-per-minute plus punctuation pauses. After TTS generation, actual word timing replaces the estimate.

### 13.3 Beat design rules

- One coherent factual or narrative unit per beat.
- Target 5-20 seconds of narration.
- Multiple visual shots allowed.
- Visual requirements must be expressible using current catalog/graphics.
- Abstract transitions should use maps, labels, or context footage rather than fake specificity.

### 13.4 Scene contract

The JSON Schema in `schemas/scene-contract.schema.json` is canonical.

Key fields:

- Required geography.
- Visual treatment types.
- Required/optional objects and activities.
- Preferred shots and movements.
- Disallowed content.
- Target visual-shot count.
- Max visual duration.
- Candidate and selected segment references.
- Verification state.

### 13.5 Script versioning

Every script revision stores:

- Parent version.
- Generation reason.
- Model/provider.
- Input fact/coverage hashes.
- Diff summary.
- Locked/unlocked state.

Voice generation always references a locked script version.

---

## 14. Candidate retrieval and scoring

### 14.1 Hard-filter query

Pseudo-code:

```ts
function getEligibleAssets(contract: SceneContract): Asset[] {
  return catalog.filter(asset =>
    asset.sourceAllowed &&
    geographySatisfies(asset.place, contract.geography) &&
    orientationAllowed(asset.orientation, contract.outputAspect) &&
    declaredResolutionEligible(asset, contract.minimumResolution) &&
    !asset.excluded &&
    availabilityAllowsPlanning(asset)
  );
}
```

### 14.2 Retrieval score

Initial weighted score for eligible assets:

```text
metadata BM25/text match         0.28
required object/activity match  0.22
location evidence quality       0.15
shot/framing match              0.12
time/style match                0.07
crop/resolution suitability     0.06
thumbnail visual match          0.05
source freshness/availability   0.02
historical performance prior    0.03
```

Location compatibility is already a hard gate. The evidence-quality component differentiates strong from merely acceptable matches; it cannot rescue an incompatible place.

### 14.3 Optional semantic reranking

P1 may add text/image embeddings. Process:

- Retrieve top 50 through hard filters + FTS.
- Compute semantic similarity only among eligible candidates.
- Blend at no more than 20% of final candidate score initially.
- Log contributions.

### 14.4 Global selection algorithm

Version 1 algorithm:

1. Rank top `K` candidates per visual requirement (`K` default 10).
2. Select hook/hero shots first.
3. Traverse narrative order using greedy selection with dynamic penalties:
   - Exact source reuse.
   - Perceptual duplicate cluster reuse.
   - Same shot type/motion sequence.
   - Time-of-day discontinuity.
   - Severe crop.
   - Weak location confidence.
4. Run local-swap improvement passes across neighboring and repeated selections.
5. Validate all global constraints.
6. Produce acquisition candidates and alternates based on residual risk.

This avoids a heavy solver while still optimizing the sequence as a whole.

### 14.5 Explainability

Each candidate score stores component values and human-readable reasons, for example:

```text
96/100
- Exact landmark verified
- Required aerial-wide shot
- Temple ruins and vegetation match
- Landscape 4K source
- No source reuse elsewhere
- Daytime continuity matches adjacent shots
```

---

## 15. Acquisition manifest and download watcher

### 15.1 Project naming

Default Envato project/license name:

```text
YT-{YYYY}-{channel-short}-{project-sequence}-{slug}
```

Example:

```text
YT-2026-TRAVEL-0042-MY-SON-SANCTUARY
```

### 15.2 Acquisition item states

```text
PLANNED
READY_TO_OPEN
ACTIVE_IN_BROWSER
WAITING_FOR_FILE
FILE_DETECTED
FILE_STABLE
MAPPED
PROCESSING
VERIFIED
LICENSE_ONLY_PENDING
COMPLETE
FAILED
SKIPPED
```

### 15.3 Watch-folder completion detection

Ignore:

- `.crdownload`
- `.part`
- `.tmp`
- zero-byte files

A file is complete when:

- Extension is not temporary.
- Size remains unchanged for configurable polls, default three polls over 6 seconds.
- File can be opened for read.
- ffprobe can parse it or it is an expected certificate/document type.

### 15.4 Automatic file mapping

Mapping evidence in priority order:

1. Only one acquisition item is active and file completed in its time window.
2. Filename tokens match asset title/provider ID.
3. Declared file size/resolution/duration approximate actual metadata.
4. Previously learned provider filename pattern.
5. Operator selection when confidence is below threshold.

Store mapping confidence and evidence.

### 15.5 License tracking

License states:

```text
NOT_REQUIRED
PENDING
OPERATOR_ATTESTED
CERTIFICATE_ATTACHED
VERIFIED
CONFLICT
```

The system cannot independently verify Envato account state. P0 accepts batch or item operator attestation and optional certificate attachment. A used asset cannot pass final QC with `PENDING` or `CONFLICT`.

### 15.6 Existing local file

If SHA-256 or source asset mapping indicates the original is already local:

- Skip physical download.
- Create a license-only acquisition task when the project needs a new license.
- Reuse existing proxy, segments, and analysis unless invalidated by pipeline version.

---

## 16. Media ingest and analysis

### 16.1 ffprobe metadata

Capture JSON for:

- Container and duration.
- Video/audio streams.
- Width/height.
- Sample/display aspect ratio.
- Frame-rate rationals.
- Codec/profile/pixel format.
- Color primaries/transfer/space.
- Bit depth.
- Rotation.
- Audio sample rate/channels.
- Alpha capability.

Persist raw ffprobe JSON and normalized fields.

### 16.2 Proxy generation

Default proxy:

```text
MP4 / H.264 / AAC if audio exists
max 1280x720, preserve aspect ratio
max 30 fps
BT.709 SDR normalized for preview
faststart enabled
```

Use hardware encoder when available; software fallback.

### 16.3 Keyframes and contact sheets

Generate:

- Representative frames at beginning, quartiles, midpoint, and end.
- Scene-change frames when detected.
- A contact sheet suitable for visual-model review.
- Optional low-resolution preview GIF/WebM for UI hover.

### 16.4 Shot-boundary and candidate-segment generation

Stock assets may contain a single continuous camera movement. The pipeline must support both detected cuts and sliding windows.

Algorithm:

1. Detect hard scene cuts using FFmpeg scene score.
2. Split at cuts and exclude fades/black ranges.
3. For each continuous range, create windows from preferred lengths (3.0, 4.5, 6.0 seconds) with overlap.
4. Reject windows containing black frames, excessive freeze, corrupt frames, or unusable beginning/end transitions.
5. Score windows for stability, subject visibility, crop suitability, and uniqueness.
6. Keep the best limited set per source asset.

### 16.5 Visual model input minimization

Never upload the full source video by default. Send:

- Metadata.
- Contact sheet.
- Representative frames.
- Optional low-bitrate subclip only if configured and necessary.

The vision response must be structured:

- Visible objects.
- Activity.
- Shot/framing.
- Camera movement.
- Time/weather.
- Text/logos.
- Quality warnings.
- Contract match.
- Confidence.

### 16.6 Media-analysis versioning

Every derivative stores:

- Pipeline version.
- FFmpeg version.
- Input hash.
- Command/options hash.
- Created date.

A pipeline upgrade can mark derivatives stale without invalidating originals.

---

## 17. Effective resolution and crop policy

### 17.1 Effective pixel calculation

For a selected crop:

```text
effective_width  = source_width  * crop_width_fraction
effective_height = source_height * crop_height_fraction
```

Rotation is applied before calculation.

### 17.2 Full-screen eligibility

For 1080p output:

```text
effective_width >= 1920 AND effective_height >= 1080
```

For 4K output:

```text
effective_width >= 3840 AND effective_height >= 2160
```

No scale factor above 1.0 is permitted for full-screen raster footage.

### 17.3 Inset exception

A lower-resolution source may be used without upscaling as an inset, split-screen, archival card, or framed graphic on a larger canvas. The render manifest must identify this treatment so QC does not treat it as full-screen.

### 17.4 4K project qualification

After the final timeline is locked:

- Evaluate every full-screen source and graphic.
- Produce blocker list.
- If any fails, choose 1080p.
- Never mix true 4K and upscaled 1080p while labeling the output qualified 4K.

---

## 18. Voice, alignment, and audio

### 18.1 Provider interface

The TTS adapter accepts:

- Text.
- Voice ID.
- Style/speed/stability settings.
- Pronunciation dictionary.
- Desired output format.

It returns:

- Audio file.
- Duration.
- Word/character timing if supported.
- Provider request ID.
- Model/version.

### 18.2 Sectioning

Script sections are 15-45 seconds where possible. Boundaries occur at natural paragraphs/chapters.

### 18.3 Forced alignment fallback

If TTS timing is unavailable or unreliable:

- Run local or provider speech-to-text alignment on generated audio.
- Align transcript tokens to final script.
- Flag material mismatches.

### 18.4 Audio assembly

- Concatenate sections with short natural room-tone/crossfade treatment.
- Normalize narration sections.
- Mix music and ambient tracks.
- Sidechain/duck music during speech.
- Add fade-in/out.
- Final loudness target defaults to approximately -14 LUFS integrated and -1 dBTP true peak ceiling, configurable.

### 18.5 Audio QC

Check:

- Peak clipping.
- Integrated loudness.
- Long silence.
- Missing/short section.
- Transcript mismatch.
- Abrupt discontinuity.
- Music-to-speech ratio.

---

## 19. Timeline and render manifest

### 19.1 Canonical timeline

The render manifest is the single source of truth for final assembly. It contains:

- Project and script versions.
- Output profile.
- Frame rate and time base.
- Audio tracks.
- Ordered visual shots.
- Source file hashes and in/out points.
- Crop/scale/position.
- Transitions.
- Overlays and graphics.
- Captions.
- Color conversion.
- Expected duration and hashes.

Schema: `schemas/render-manifest.schema.json`.

### 19.2 Time representation

Use integer milliseconds in application contracts. Convert to rational frame/time values only at render-command generation.

### 19.3 Shot timing algorithm

1. Obtain actual narration word timing.
2. Determine chapter/beat intervals.
3. Calculate target visual-shot count by beat duration and pacing policy.
4. Fit selected segments without exceeding their allowed in/out range.
5. Keep each shot <= 7000 ms.
6. Avoid cuts in the middle of critical on-screen action when analysis indicates a better boundary.
7. Insert map/graphic shots where specified.
8. Validate total timeline against audio duration.

### 19.4 Transitions

Default:

- Hard cut: majority.
- Short dissolve: chapter/time/location transitions only.
- Audio J/L cuts allowed.
- No random transition library.

### 19.5 Render tiers

#### Scene/range preview

- Proxy media.
- Low latency.
- Render selected time range only.

#### Draft

- 1280x720 MP4.
- Hardware H.264 when available.
- Used for full automated QC and optional review.

#### Final 1080p

- Original source media.
- 1920x1080.
- H.264 High, yuv420p, BT.709, AAC 48 kHz.
- `+faststart`.
- Software quality profile by default; configurable high-quality hardware profile.

#### Final qualified 4K

- 3840x2160 only after qualification.
- Original 4K sources after crop.
- H.264 or configured YouTube-compatible profile.
- No upscaling.

### 19.6 FFmpeg command generation

Generate commands from the manifest, never ad hoc UI strings. Store:

- Sanitized command.
- FFmpeg version.
- Start/end times.
- Exit code.
- Progress.
- stderr tail.
- Output hash.

Use `-progress pipe:1` or equivalent machine-readable progress.

### 19.7 Hardware encoder discovery

At setup and periodically:

- Query available FFmpeg encoders.
- Run short validation encode for NVENC, Quick Sync, AMD AMF, and libx264 fallback.
- Save capabilities and preferred profiles.

Hardware encode is preferred for proxies/drafts. Final output profile is configurable based on quality/time.

---

## 20. Graphics and thumbnail renderer

### 20.1 Graphics implementation

Use SVG/Sharp/Canvas templates for:

- Location labels.
- Chapter cards.
- Maps/routes.
- Lower thirds.
- Facts/numbers.
- Channel logo/end card.
- Thumbnail compositions.

Render templates to PNG at target resolution with alpha where needed, then composite through FFmpeg.

### 20.2 Template data contract

```ts
interface GraphicTemplateInput {
  templateId: string;
  width: number;
  height: number;
  fields: Record<string, string | number | boolean>;
  sourceFramePath?: string;
  safeAreaProfile: string;
}
```

### 20.3 Thumbnail generation

For each of three concepts:

1. Select a high-impact actual frame from used footage.
2. Apply crop/contrast/blur/vignette within policy.
3. Add limited text and brand treatment.
4. Validate destination/title consistency.
5. Export 1280x720 JPEG/PNG <= 2 MB.
6. Store frame source and template inputs for reproducibility.

No generated substitute destination imagery is allowed by default.

---

## 21. Automated QC architecture

### 21.1 QC result model

```ts
interface QcResult {
  checkId: string;
  projectId: ProjectId;
  renderId?: RenderId;
  severity: 'blocker' | 'high' | 'medium' | 'low';
  status: 'pass' | 'fail' | 'warning' | 'skipped';
  evidence: Record<string, unknown>;
  repairAction?: string;
  repairAttempted: boolean;
}
```

### 21.2 Pre-render QC

- All selected files present and hash-valid.
- Every scene contract resolved.
- Every shot <= 7 seconds.
- All used assets license-ready.
- Output resolution qualification complete.
- No overlapping/negative timeline ranges.
- Audio and captions present.

### 21.3 Post-render QC

Use ffprobe/FFmpeg analysis to check:

- Expected duration tolerance.
- Codec/container/profile.
- Resolution/frame rate/pixel format.
- Black/frozen frames.
- Silence and loudness.
- Audio/video sync.
- Caption timing bounds.
- Output seekability and `moov` placement where testable.

### 21.4 Semantic QC

Use timeline audit data and optional sampled final frames to verify:

- Shot corresponds to scene contract.
- Location evidence has not changed.
- Overlay text is correct.
- Thumbnail/title are supported.

### 21.5 Repair loop

A QC failure includes a repair policy:

```text
REPAIRABLE_AUTOMATICALLY
RETRY_WITH_ALTERNATE
REGENERATE_RANGE
REQUIRES_ACQUISITION
REQUIRES_OPERATOR
FATAL
```

Automatic repair attempts are bounded. Each attempt creates an audit event and new artifact version.

---

## 22. YouTube integration

### 22.1 OAuth scopes

Request the minimum scopes required for:

- Upload.
- Metadata update.
- Thumbnail.
- Caption track.
- Playlist insertion.
- Analytics/reporting.

Keep upload and analytics credentials within one encrypted account profile when supported.

### 22.2 Resumable upload

- Use resumable media upload.
- Persist upload session URL/identifier when SDK permits.
- Retry transient network failures with exponential backoff and jitter.
- Do not begin a new upload if the final-render hash already maps to a YouTube video ID.

### 22.3 Initial metadata

Upload as private with:

- Title.
- Description.
- Tags.
- Category.
- Audience/made-for-kids setting.
- License.
- Synthetic-media disclosure when applicable.

Then:

- Upload thumbnail.
- Upload caption track.
- Add to playlist.
- Poll processing status.

### 22.4 Approval and scheduling

On approval:

- Use `publishAt` with private status when scheduling is available and the video has not previously been published.
- Otherwise update privacy to public/unlisted as selected.
- If API project restrictions prevent the operation, open the exact YouTube Studio page and mark the project `AWAITING_MANUAL_STUDIO_ACTION`.

### 22.5 Publication integrity

Store:

- YouTube video ID.
- Upload hash.
- Metadata version.
- Thumbnail hash.
- Caption hash.
- Privacy state.
- Scheduled/published time.
- API response IDs/errors.

---

## 23. Analytics integration

### 23.1 Collection schedule

Default jobs:

- 24 hours.
- 72 hours.
- 7 days.
- 28 days.
- 90 days.
- Monthly thereafter for evergreen videos.

### 23.2 Metrics

- Views.
- Watch time.
- Average view duration.
- Average percentage viewed.
- Impressions/CTR where API/report availability permits.
- Subscribers gained.
- Traffic source.
- Search terms.
- Audience watch ratio.
- Relative retention performance.

### 23.3 Timeline mapping

Retention uses normalized elapsed-video ratio. Convert each point to milliseconds:

```text
position_ms = elapsed_ratio * final_duration_ms
```

Join to:

- Chapter interval.
- Beat interval.
- Visual-shot interval.
- Overlay interval.

Calculate per-feature outcomes such as:

- Mean retention change after aerial shots.
- Drop rate by shot duration bucket.
- Hook pattern performance.
- Destination/topic performance.
- Narration pace association.

### 23.4 Learning guardrails

No automated weight mutation until configured thresholds are met, default:

- At least 10 published videos.
- At least 1,000 views on a video before scene-level conclusions.
- Pattern repeated across at least three videos.

Before applying an update:

- Generate recommendation.
- Show evidence and confidence.
- Store prior configuration.
- Apply automatically only if policy permits; otherwise queue for operator review.

---

## 24. Durable local job engine

### 24.1 Job states

```text
QUEUED
READY
RUNNING
WAITING_EXTERNAL
WAITING_HUMAN
RETRY_SCHEDULED
SUCCEEDED
FAILED_RETRYABLE
FAILED_PERMANENT
CANCELLED
STALE
```

### 24.2 Job record

Fields include:

- Job ID/type/project.
- Input payload and input hash.
- Idempotency key.
- Dependencies.
- Status and progress.
- Priority.
- Attempt count/max attempts.
- Next run time.
- Lease owner and lease expiration.
- Checkpoint data.
- Output artifact IDs.
- Error classification.

### 24.3 Claim/lease model

The service host claims a job in a short transaction:

- Set status `RUNNING`.
- Set lease owner and expiry.
- Increment attempt.

Heartbeat extends lease. If the process dies, expired jobs are recovered according to job type.

### 24.4 Idempotency

Examples:

```text
catalog import: hash(file + mapping + import schema)
AI output: hash(provider + model + prompt version + normalized input)
TTS: hash(text + voice + settings + pronunciation + model)
proxy: hash(source sha256 + proxy profile version)
render: hash(render manifest + render profile + renderer version)
upload: hash(final file sha256 + channel id)
```

A successful output with the same valid idempotency key is reused.

### 24.5 Retry classification

- Network timeout/429/5xx: retry with backoff.
- Authentication: wait for human re-authentication.
- Schema validation: no blind retry; regenerate once with corrective prompt, then fail.
- Missing file: wait for acquisition or permanent fail based on state.
- FFmpeg transient process exit: retry once; then diagnostic exception.
- Disk full: pause until resolved.
- Permanent provider refusal/invalid request: fail permanent.

### 24.6 Project locking

At most one state-mutating project workflow runs at a time. Independent media derivatives may run concurrently within configured resource limits.

### 24.7 Resource scheduler

Configurable concurrency defaults:

- One final render.
- One proxy/analysis encode when final render active; otherwise two.
- Two concurrent AI calls.
- One TTS batch.
- One YouTube upload.

Throttle when on battery or low disk/thermal conditions if detected.

---

## 25. Project state machine

Canonical states and transitions are defined in `04-STATE-MACHINE.md`.

The service host is the only component allowed to transition a project. Every transition:

- Validates prerequisites.
- Runs in a database transaction.
- Appends an audit event.
- Enqueues next jobs.
- Emits a renderer event.

The renderer never writes project state directly.

---

## 26. IPC contract

### 26.1 API shape

Expose three mechanisms:

```ts
window.videoFactory.command(name, payload)
window.videoFactory.query(name, payload)
window.videoFactory.subscribe(eventName, handler)
```

Never expose generic filesystem or shell methods.

### 26.2 Envelope

```ts
interface IpcRequest<T> {
  requestId: string;
  method: string;
  payload: T;
  contractVersion: number;
}

interface IpcResponse<T> {
  requestId: string;
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}
```

### 26.3 Progress events

Long-running jobs do not hold one IPC request open. The command returns a job ID; UI subscribes to project/job events.

### 26.4 Contract versioning

- Shared schemas in `packages/contracts`.
- Validate in preload and main/service boundary.
- Additive changes remain backward compatible within a major app version.
- Contract mismatch triggers application update/restart, not undefined behavior.

See `05-IPC-AND-PROVIDER-CONTRACTS.md`.

---

## 27. Provider architecture

### 27.1 Required provider interfaces

```text
LanguageModelProvider
VisionProvider
WebResearchProvider
TextEmbeddingProvider (optional P1)
TextToSpeechProvider
SpeechAlignmentProvider
KeywordMetricsProvider
YouTubeProvider
MapProvider
```

### 27.2 Provider-call record

Every call stores:

- Provider and operation.
- Model/version.
- Request hash.
- Redacted request metadata.
- Response hash.
- Token/character/unit usage.
- Cost estimate.
- Latency.
- Retry count.
- Status/error.
- Artifact IDs created.

### 27.3 Structured-output enforcement

- JSON Schema/Zod validation.
- Reject unknown dangerous fields where appropriate.
- One corrective regeneration attempt with validation error summary.
- Persist raw response for diagnostics, with sensitive data controls.
- Do not mutate domain state until validation passes.

### 27.4 Provider fallback

Fallback may occur only when:

- Operation semantics are equivalent.
- Output schema is identical.
- Cost/budget policy permits.
- Audit record notes fallback.

Do not silently switch to a weaker provider for geographic or factual verification.

---

## 28. Application configuration

### 28.1 Settings categories

- Paths/storage.
- Channel/editorial profile.
- Autopilot thresholds.
- AI providers/models.
- Voice/pronunciation.
- Render profiles.
- YouTube publishing.
- Budgets/quotas.
- Backup/retention.
- Notifications.

### 28.2 Configuration precedence

```text
project override
> channel profile
> user setting
> shipped default
```

### 28.3 Configuration snapshots

Every project stores a snapshot of effective policy at creation. Later global setting changes do not silently alter an in-progress project unless explicitly migrated.

### 28.4 Default policy

Machine-readable defaults are in `config/default-autopilot-policy.json` and `config/render-profiles.json`.

---

## 29. Logging, diagnostics, and audit

### 29.1 Logs

Structured JSON rolling logs:

- `app.log`
- `service-host.log`
- `jobs.log`
- `ffmpeg.log`
- `providers.log`
- `youtube.log`

Fields:

- Timestamp.
- Level.
- Component.
- Project/job IDs.
- Event code.
- Message.
- Safe structured details.

### 29.2 Audit events

Permanent, user-readable audit trail for:

- Imports and metadata changes.
- Topic selection.
- Fact/script versions.
- Candidate selection and replacements.
- License attestations.
- Render/QC versions.
- Upload and publication changes.
- Operator overrides.
- Configuration/learning changes.

### 29.3 Diagnostic bundle

One action creates a ZIP containing:

- Recent redacted logs.
- App/system/FFmpeg versions.
- Hardware encoder report.
- Database schema version.
- Failing project/job metadata.
- Sanitized FFmpeg command and stderr.
- No API secrets or source videos.

---

## 30. Backup and disaster recovery

### 30.1 Database backup

Default retention:

- Seven daily.
- Four weekly.
- Six monthly.

Backup sequence:

1. Complete/abort active write transaction.
2. Checkpoint WAL.
3. Use SQLite backup API to new file.
4. Run integrity check on backup.
5. Compress and store checksum.

### 30.2 Project export

Export includes:

- Project manifest.
- Script/fact sources.
- Scene contracts.
- Asset/file/license references.
- Voice/caption artifacts.
- Render manifest and profiles.
- QC results.
- Thumbnail/package metadata.
- Publication record.

Optionally include originals and final output.

### 30.3 Restore

- Stop service host.
- Validate backup integrity.
- Restore database.
- Verify configured media paths.
- Scan hashes for missing originals.
- Rebuild missing regenerable derivatives.
- Resume durable jobs only after consistency check.

---

## 31. Packaging and updates

### 31.1 Installer

- Windows x64 Squirrel installer through Electron Forge.
- Per-user installation is acceptable for one operator.
- Bundle application assets and required native modules.
- FFmpeg strategy must be documented:
  - bundled approved binary, or
  - first-run managed install, or
  - configured local binary path.

### 31.2 Code signing

P1 but recommended to avoid Windows warnings. Signing credentials must not be stored in the repository.

### 31.3 Updates

P1 options:

- Signed releases from private GitHub Releases.
- Static internal storage feed.
- Manual installer update initially.

Updates must not interrupt active final renders or uploads. Apply on restart after jobs reach safe checkpoints.

---

## 32. Test architecture

### 32.1 Unit tests

- Normalizers/parsers.
- Location hierarchy and compatibility.
- Coverage and opportunity scoring.
- Candidate score components.
- Global diversity penalties.
- State transitions.
- Idempotency keys.
- Effective-resolution calculations.
- Manifest validation.
- QC rules.

### 32.2 Integration tests

- SQLite migrations and repositories.
- FTS indexing/search.
- Import/diff on realistic 26k-row fixture.
- File watcher and completion detection.
- ffprobe/proxy/segment pipeline.
- Provider adapters with recorded fixtures.
- YouTube client against mocks/sandbox where possible.
- Backup/restore.

### 32.3 Media fixtures

Include small licensed/generated fixtures for:

- 4K ProRes.
- 1080p H.264.
- Vertical source.
- Variable frame rate.
- Alpha source.
- HDR/log metadata.
- Black/frozen frames.
- Corrupt/truncated file.
- Silent and clipped audio.

Do not commit Envato source assets to a public repository.

### 32.4 End-to-end tests

Use Playwright Electron for:

- First-run setup.
- Catalog import.
- Guided topic creation.
- Download simulation into watched folder.
- Final review approval.
- Restart/recovery.

### 32.5 Golden render tests

- Render short deterministic timelines.
- Verify ffprobe metadata and hashes where stable.
- Compare sampled frames/perceptual hashes within tolerance.
- Verify shot timing and audio sync.

Detailed acceptance tests are in `06-ACCEPTANCE-TESTS.md`.

---

## 33. Performance and resource targets

### 33.1 Catalog

- 26,000 rows minimum.
- Design indexes for at least 100,000 assets and 500,000 derived segments.
- Common filtered search target p95 < 300 ms after warm-up.

### 33.2 UI

- Renderer main thread must not parse spreadsheets, hash large files, or run FFmpeg.
- Virtualize tables/grids.
- Paginate or cursor large result sets.
- Debounce search.
- Use thumbnail sizes appropriate to display.

### 33.3 Media

- Limit concurrent encode processes.
- Use proxies for UI.
- Use source trimming to minimize decode work where practical.
- Cache derived segments and graphics by hash.
- Do not re-render unaffected ranges during edit preview.

### 33.4 Network/API

- Cache keyword/research responses by freshness window.
- Batch provider calls where supported.
- Send contact sheets rather than full video.
- Use resumable YouTube upload.

---

## 34. Failure handling examples

### 34.1 Application closes during proxy generation

- FFmpeg process ends.
- Partial output remains `.partial` and is deleted on recovery.
- Expired job lease returns job to retryable.
- Original remains valid.
- Job retries without duplicating DB artifacts.

### 34.2 Application closes during final render

- Checkpoint identifies render job and partial file.
- Partial is removed unless resumable segmentation strategy is enabled.
- Unchanged generated inputs remain cached.
- Render restarts; earlier paid AI/TTS work is not repeated.

### 34.3 Network fails during YouTube upload

- Persist resumable session data when available.
- Retry the same upload session.
- Never create a second upload unless the prior session is conclusively invalid and no YouTube ID exists.

### 34.4 Downloaded file is wrong

- ffprobe/visual mismatch lowers mapping confidence.
- File is quarantined or returned to ingest folder.
- Acquisition item remains incomplete.
- Operator gets one mapping exception with candidate choices.

### 34.5 Final source is unavailable

- Select alternate.
- Recompute acquisition manifest.
- Rewrite scene if no exact alternative.
- Do not substitute unrelated footage.

---

## 35. Deferred architecture decisions

These must remain pluggable and are not required to begin:

- Exact AI provider/model IDs.
- Exact TTS provider.
- Vector-search library.
- Advanced map animation engine.
- Multi-machine rendering.
- Local model inference.
- Cross-platform macOS build.
- Automated title/thumbnail experiment integration.

---

## 36. Technical definition of done

The implementation is technically complete only when:

1. The packaged Windows app installs and starts without a developer environment.
2. The renderer has no direct Node/filesystem/database access.
3. The full catalog imports, indexes, diffs, and searches correctly.
4. Project/job state survives forced process termination and machine restart.
5. The app produces one complete real video through the two routine human gates.
6. All exact-location and license blockers are enforced.
7. Final output is valid H.264/AAC MP4 and passes no-upscaling rules.
8. Private YouTube upload, thumbnail, and caption track succeed.
9. Duplicate paid calls/renders/uploads are prevented by idempotency.
10. Backup/restore reproduces the project database and identifies media integrity.
11. The full acceptance suite passes.
12. Five pilot videos complete, with at least four requiring no routine manual editing beyond acquisition and final approval.
