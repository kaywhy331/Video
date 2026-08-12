---
title: "VideoFactory Desktop"
subtitle: "Desktop Product Requirements Document and Technical Specification"
author: "Prepared for Kevin"
date: "July 30, 2026"
subject: "Internal automated stock-footage-to-YouTube production system"
keywords: [Electron, FFmpeg, SQLite, YouTube, Envato, desktop application, video automation]
---

[[PAGEBREAK]]
# Document Contents

This build package is organized for direct handoff from product definition to implementation.

- **Build-Ready Baseline** - frozen operating model, companion artifacts, and implementation assumptions.
- **Part I - Product Requirements Document** - product goals, automation workflow, UX, metadata operations, content intelligence, media production, publishing, and success criteria.
- **Part II - Technical Specification** - application architecture, local processes, SQLite model, IPC, provider adapters, footage matching, rendering, security, packaging, and recovery behavior.
- **State Machine** - durable project, job, approval, exception, acquisition, render, and publication transitions.
- **IPC and Provider Contracts** - typed desktop commands, events, provider interfaces, validation, retries, and idempotency.
- **Acceptance Test Plan** - functional, media, workflow, resilience, security, licensing, and end-to-end release tests.
- **Implementation Plan** - vertical-slice milestones, sequencing, release gates, and definition of done.
- **Official References** - current primary technical and policy sources used to establish implementation constraints.

[[PAGEBREAK]]
# Build-Ready Baseline

**Version:** 1.0  
**Status:** Approved baseline for implementation planning  
**Primary platform:** Windows 10/11 x64  
**Operating model:** Single-user internal desktop application  
**Routine human gates:** Manual Envato licensing/download and final publication approval

This document combines the product requirements, technical architecture, state machine, contracts, acceptance tests, and implementation plan. Machine-readable companion artifacts are provided separately in the specification package.

## Companion artifacts

- `03-DATA-MODEL.sql`
- `schemas/scene-contract.schema.json`
- `schemas/render-manifest.schema.json`
- `config/default-autopilot-policy.json`
- `config/render-profiles.json`



[[PAGEBREAK]]
# Part I - Product Requirements Document

## 1. Document control

| Field | Value |
|---|---|
| Product working name | VideoFactory Desktop |
| Document version | 1.0 |
| Product type | Internal Windows desktop application |
| Primary operator | One in-house channel operator |
| Primary input | 26,000+ row Envato footage metadata catalog plus manually downloaded source files |
| Primary output | YouTube-ready H.264/AAC MP4, thumbnail, captions, title, description, chapters, and upload record |
| Routine human gates | Envato licensing/download; final publication approval |
| Default production mode | Autopilot |

### 1.1 Decision hierarchy

When requirements conflict, use this priority order:

1. Geographic and factual accuracy.
2. Licensing and auditability.
3. Viewer value and retention.
4. Reproducibility and failure recovery.
5. Operator time saved.
6. Rendering speed and compute cost.
7. Visual polish.

The application must never trade a higher-priority requirement for a lower-priority convenience.

---

## 2. Executive summary

VideoFactory Desktop converts a large stock-footage metadata catalog into a mostly autonomous YouTube production system.

The key difference from generic script-to-video products is that the system does not generate a script first and then attach broadly related stock clips. It begins with the footage catalog, verifies what destinations and visual subjects are supportable, chooses a topic with sufficient visual coverage, generates a constrained script, and requires every place-specific narration claim to map to footage verified at the same or greater geographic specificity.

The application runs locally, keeps large source files on local or NAS storage, and uses cloud APIs only for selected operations such as research, language generation, vision analysis, voice generation, keyword metrics, YouTube upload, and analytics. Original high-resolution footage is not uploaded to AI providers; only metadata, low-resolution keyframes, contact sheets, or short proxies are sent when needed.

The default operator experience is:

```text
Autopilot plans the next video
-> operator downloads the requested Envato assets
-> application finishes production and uploads privately
-> operator approves publication
```

All other review is exception-driven.

---

## 3. Problem statement

Existing AI video builders are optimized for speed rather than factual visual grounding. They commonly:

- Match scenes using loose keyword or semantic similarity.
- Use generic beach, city, food, or aerial footage unrelated to the named place.
- Repeat similar clips.
- Write scripts that exceed the available visual coverage.
- Require substantial manual scene replacement.
- Hide confidence and selection logic.
- Create a polished-looking video that is visually inaccurate.

The in-house workflow already has a major advantage: a catalog of more than 26,000 stock-video records with source URLs and detailed metadata such as author, country, city, location, activity, shot type, scene, object, time of day, style, duration, resolution, frame rate, codec, orientation, and thumbnail.

The product must convert that catalog into a reliable production system without pre-downloading the full library.

---

## 4. Product vision

> Produce accurate, engaging, repeatable YouTube videos from licensed stock footage with only two routine operator actions: acquire the requested assets and approve the final upload.

### 4.1 Product principles

1. **Inventory before ideation.** The available footage constrains the topic and script.
2. **Exact geography is a gate.** Visual beauty never overrides location accuracy.
3. **Facts are sourced.** Every material factual claim is traceable to a research source.
4. **Automation is exception-driven.** The operator reviews problems, not every routine success.
5. **One source file, many references.** Never duplicate multi-gigabyte originals between projects.
6. **Proxy for planning, original for final.** Use 720p proxies for interaction and the original for final rendering.
7. **No silent fallback.** Missing exact footage causes rewrite, graphic substitution, acquisition, or scene removal.
8. **Reproducibility over hidden magic.** Every published video can be rebuilt from its manifest, hashes, script, voice, and render profile.
9. **Private-first publishing.** The system uploads privately before any public release.
10. **Learning requires evidence.** Performance weights change only after sufficient channel data exists.

---

## 5. Goals

### 5.1 Primary goals

- Import and continuously maintain the complete footage catalog.
- Identify content topics that are both searchable and visually supportable.
- Generate sourced scripts constrained by verified footage coverage.
- Match narration to exact-location footage with transparent confidence.
- Minimize the number of Envato assets the operator must acquire.
- Automatically ingest and process downloaded files.
- Assemble videos with visual shots no longer than seven seconds.
- Generate natural voiceover, captions, music ducking, graphics, titles, thumbnails, and descriptions.
- Render compliant 1080p MP4 output by default and true 4K only when qualified.
- Upload privately to YouTube and wait for final approval.
- Collect analytics and map retention results back to production decisions.
- Recover from application, network, and worker failures without duplicate paid calls or lost state.

### 5.2 Secondary goals

- Reuse previously downloaded source files under newly recorded project licenses.
- Support additional uploaders, channels, languages, and formats later.
- Export a complete project archive for audit or migration.
- Allow the operator to intervene at any stage without making manual intervention mandatory.

---

## 6. Non-goals for version 1

The first release will not include:

- Automated Envato account login, licensing, scraping, or downloading.
- A public SaaS product.
- User accounts, teams, permissions, or collaboration.
- A general-purpose nonlinear editor comparable to Premiere Pro.
- Real-time multiplayer editing.
- Automatic public publishing without a final approval gate.
- AI upscaling, generative frame interpolation, or invented destination imagery.
- HDR delivery.
- Shorts or vertical-video production.
- Automated comment replies or community management.
- Custom model training.
- Cloud rendering or cloud storage of all source footage.
- Kubernetes, microservices, or a server database.
- A promise of exact YouTube monthly search volume when only proxy data is available.

---

## 7. Operating assumptions

### 7.1 Default environment

- Windows 10 or Windows 11, x64.
- One operator.
- One primary YouTube channel.
- Long-form English-language 16:9 videos.
- Target duration initially 6-10 minutes.
- Source library primarily 1080p and 4K horizontal footage.
- Local NVMe drive for active cache and renders.
- Large local drive or NAS for original footage and archives.
- Active SQLite database stored locally, not on the NAS.
- Internet access for AI APIs, research, YouTube, and optional keyword services.

### 7.2 Required external accounts

- Active Envato Elements subscription.
- YouTube/Google OAuth access for the channel.
- At least one configured language-model provider.
- At least one configured TTS provider.
- At least one web-search/research provider.
- Optional Google Ads account/API access for Google Search demand proxy data.

### 7.3 Input spreadsheet baseline

The current catalog includes or can map the following fields:

| Current field | Canonical application field |
|---|---|
| ID | source_row_id |
| Page | canonical_page_url |
| Author | author_name |
| Attributes | raw_attributes |
| Item Tags | raw_tags |
| Title | title |
| Description | description |
| Extracted Data | raw_extracted_data |
| Country | country |
| City | city |
| Location | location_name |
| Activity | activity |
| Shot | shot_type |
| Scene | scene_description |
| Object | objects |
| Time of Day | time_of_day |
| Style | style |
| Length | declared_duration |
| Thumbnail | thumbnail_url |
| Resolution | declared_resolution |
| File Size | declared_file_size |
| Frame Rate | declared_frame_rate |
| Alpha Channel | declared_alpha |
| Looped | declared_looped |
| Video Encoding | declared_codec |
| Orientation | orientation |

The application must preserve the original imported row as immutable source evidence even after normalization or correction.

---

## 8. Users and roles

### 8.1 Operator

The only required role. The operator:

- Configures the channel and content policy.
- Imports or refreshes the footage catalog.
- Manually licenses/downloads requested Envato assets.
- Reviews exceptions when automation cannot safely continue.
- Reviews the private final video.
- Approves publication or scheduling.

### 8.2 Automation engine

The automation engine:

- Maintains the production queue.
- Selects topics.
- Conducts research.
- Generates scripts and storyboards.
- Creates acquisition manifests.
- Processes footage.
- Generates narration and edits.
- Runs QC.
- Creates YouTube packaging.
- Uploads privately.
- Retrieves and interprets analytics.

No separate administrator role is needed in version 1.

---

## 9. Success metrics

### 9.1 Operational metrics

- Routine human interaction is limited to acquisition and final approval for at least 80% of clean projects.
- At least 90% of provisional storyboard shots are usable after actual footage verification.
- No published visual shot exceeds 7.0 seconds.
- Zero published exact-location mismatches.
- Zero final uploads with missing asset-license status.
- A failed or interrupted workflow resumes without restarting completed stages.
- No paid AI, TTS, render, or upload operation is repeated when its validated output already exists.

### 9.2 Quality metrics

- At least 95% of final narration duration is supported by exact footage, contextual verified footage, maps/graphics, or explicitly permitted text/archival treatments.
- Unsupported narration is automatically removed or rewritten before final rendering.
- Final audio passes loudness, clipping, silence, and intelligibility checks.
- Final output passes resolution, codec, duration, black-frame, duplicate-scene, and caption checks.

### 9.3 Channel metrics

The system tracks rather than guarantees:

- Impressions and click-through rate.
- First 30-second retention.
- Average view duration and average percentage viewed.
- Search, suggested, browse, and external traffic.
- Subscribers gained per video.
- Retention changes by scene type, shot duration, destination, hook pattern, and voice pacing.

---

## 10. End-to-end operating workflow

### 10.1 Autopilot flow

```text
1. Scheduler requests next production.
2. Catalog coverage engine identifies strong destination/topic clusters.
3. Opportunity engine evaluates demand, competition, channel fit, and production feasibility.
4. Highest-qualified topic is selected.
5. Research agent builds a cited fact pack.
6. Script agent creates a provisional visual-first script.
7. Script is split into chapters, narration beats, and visual-shot requirements.
8. Matching engine assigns metadata-based candidate assets.
9. Global optimizer removes repetition and improves visual continuity.
10. Acquisition planner minimizes required downloads and generates an Envato manifest.
11. Project enters WAITING_FOR_DOWNLOADS.
12. Operator licenses/downloads requested assets.
13. Download watcher detects and maps completed files.
14. Media pipeline validates, proxies, segments, and visually verifies footage.
15. Failed candidates are replaced automatically; unsupported narration is rewritten or converted to graphics.
16. Final script is locked.
17. Voiceover and word timing are generated.
18. Timeline, captions, graphics, music, and audio mix are assembled.
19. Draft render and automated QC run.
20. Correctable failures are repaired automatically.
21. Final 1080p or qualified 4K MP4 is rendered.
22. Title, thumbnail, description, chapters, tags, and disclosures are generated.
23. Video, thumbnail, and captions upload privately to YouTube.
24. Project enters WAITING_FOR_FINAL_APPROVAL.
25. Operator approves publication/schedule or sends the project back with a reason.
26. Published analytics are collected and mapped to the timeline.
```

### 10.2 Routine human gates

#### Gate A - Acquisition

The operator is shown an ordered queue of required assets. For each item the app provides:

- Envato URL.
- Project/license name to use.
- Why the asset is needed.
- Scenes it supports.
- Primary or alternate status.
- Whether the physical file already exists and only a new license is needed.

The app opens the next URL and watches the selected download folder. It does not click the Envato download button or automate the account.

#### Gate B - Final publication approval

The application uploads the completed video privately, displays the final QC report, title/thumbnail alternatives, description, chapters, and source audit, and waits for one of:

- Approve and schedule.
- Approve and publish.
- Keep private.
- Return for revision with a reason.

### 10.3 Exception gates

An exception gate is permitted only when the system cannot safely resolve a condition, including:

- Geographic conflict.
- No supportable footage after acquisition.
- Downloaded file cannot be mapped.
- Asset unavailable.
- License status missing.
- Research sources materially disagree.
- AI or API budget exceeded.
- Authentication expired.
- Repeated render/QC failure.
- Insufficient disk space.

---

## 11. Product modes

### 11.1 Autopilot mode

Default. The application chooses the next qualified video and advances automatically until a human gate or exception.

### 11.2 Guided mode

The operator selects a destination, topic, target duration, or starting script. All later stages remain automated.

### 11.3 Manual recovery mode

Used only to repair or override a blocked project. The operator can replace a clip, edit narration, change a title, or mark an exception resolved.

---

## 12. Functional requirements

Priority labels:

- **P0:** Required for the first complete production release.
- **P1:** Required after the vertical slice, before routine channel operation.
- **P2:** Valuable later enhancement.

### 12.1 Installation and first-run setup

#### P0 requirements

- Install as a Windows desktop application.
- Allow configuration of:
  - Catalog import file.
  - Envato ingest/download folder.
  - Local cache path.
  - Original media vault path.
  - Project/output path.
  - Backup path.
  - YouTube channel OAuth.
  - AI provider credentials.
  - TTS credentials and voice.
  - Research provider credentials.
  - Publishing cadence.
- Detect FFmpeg/ffprobe availability and supported hardware encoders.
- Validate read/write permissions and available disk space.
- Create initial database and storage folders.
- Run a system diagnostic and save the result.

#### P1 requirements

- Import/export settings profile.
- Application update checker.
- Optional code-signed installer.

### 12.2 Catalog import and synchronization

#### P0 requirements

- Import XLSX and CSV files.
- Map source columns to canonical fields.
- Preview mapping before commit.
- Preserve the full raw row and source import ID.
- Normalize `Not Found`, empty strings, malformed durations, file sizes, resolutions, and booleans.
- Upsert using a stable provider asset key or canonical URL, never spreadsheet row position alone.
- Produce a diff before applying a refresh:
  - New assets.
  - Changed source data.
  - Conflicts with human overrides.
  - Missing/removed rows.
  - Unchanged rows.
- Never delete a prior asset solely because it disappears from a later import.
- Rebuild/update search indexes after import.
- Support at least 26,000 rows without UI lockup.

#### P1 requirements

- Optional read-only Google Sheets synchronization.
- Scheduled catalog refresh.
- Import validation templates per uploader/source.

### 12.3 Metadata model and editing

#### P0 requirements

Every metadata field must support four layers:

1. Raw imported value.
2. Normalized value.
3. AI-derived suggestion.
4. Human override.

The effective value uses this precedence:

```text
human verified override
> trusted normalized/imported value
> accepted AI suggestion
> raw imported value
```

Each metadata assertion records:

- Source.
- Confidence.
- Verification state.
- Created/updated date.
- Responsible operator or model.
- Evidence reference.

The operator can:

- Edit one asset.
- Bulk edit selected assets.
- Accept/reject AI suggestions.
- Merge duplicate locations.
- Split an incorrectly merged location.
- Export filtered rows.
- Undo metadata edits through revision history.

### 12.4 Place and geographic evidence system

#### P0 requirements

The canonical place hierarchy is:

```text
Country -> Region -> City -> Neighborhood -> Landmark -> Specific feature
```

Each asset has:

- Canonical place ID.
- Geographic granularity.
- Location confidence.
- Evidence type.
- Verification status.

Evidence levels:

| Level | Meaning | Allowed narration |
|---|---|---|
| A | Creator/uploader confirmed, coordinates, or manually verified unmistakable landmark | Exact named place/feature |
| B | Strong source metadata plus actual footage confirmation | Exact place after automated or human validation |
| C | City/region verified; exact attraction uncertain | City/region narration only |
| D | Country/general context only | Country-level or generic narration only |
| E | Inferred or conflicting | Cannot support factual location narration |

Rule:

```text
verified footage granularity must be at least as specific as required narration granularity
```

A visually similar location never satisfies an exact-location requirement.

### 12.5 Library browsing and coverage analysis

#### P0 requirements

The Library provides:

- Thumbnail grid.
- Spreadsheet table.
- Filters for all imported and normalized metadata.
- Local/downloaded status.
- Used/unused status.
- Location confidence.
- License/project history.
- Technical media status.
- Search across title, description, tags, activity, object, scene, style, and geography.

Coverage analysis must calculate by destination/topic cluster:

- Total assets.
- Unique likely usable assets.
- Aerial/wide/medium/detail balance.
- Activities and objects represented.
- Day/night/weather variety.
- Landscape/vertical mix.
- 1080p/4K eligibility.
- Exact-location confidence distribution.
- Estimated unique 2-7 second visual shots.
- Repetition risk.
- Missing visual categories.

### 12.6 Topic opportunity engine

#### P0 requirements

The engine generates topics only from visually supportable catalog clusters.

A topic passes the feasibility gate only if:

- Required locations meet confidence thresholds.
- Estimated unique shot coverage meets target runtime.
- No critical section depends on unsupported footage.
- Expected acquisition count is within configured limits.
- The concept has a distinct viewer promise.

Initial normalized opportunity score:

```text
Opportunity =
  22% visual coverage and diversity
+ 18% estimated demand
+ 16% low competition / weak incumbent coverage
+ 12% exact-location confidence
+ 10% channel fit
+  8% evergreen value
+  6% freshness or seasonality
+  5% production efficiency
+  3% strategic portfolio value
```

Hard feasibility gates are evaluated before the weighted score.

Demand inputs may include:

- YouTube search-result volume and relevance signals.
- View velocity of competing videos.
- Existing channel search terms and performance.
- Google Search historical metrics explicitly labeled as a proxy.
- Optional third-party YouTube keyword estimates.

The app must not label Google Search data or inferred scores as exact YouTube monthly search volume.

### 12.7 Research and fact pack

#### P0 requirements

Before writing the script, the system creates a fact pack containing:

- Claim.
- Source URL/title.
- Source date or access date.
- Confidence.
- Whether the claim is stable or time-sensitive.
- Applicable location.
- Script usage restrictions.

Rules:

- Material factual claims require source support.
- Time-sensitive travel facts are stamped with a freshness date.
- Conflicting claims are surfaced or omitted.
- No citation fabrication.
- The final script references fact IDs internally even if citations are not spoken.

### 12.8 Script generation

#### P0 requirements

The script is generated in two passes.

**Pass 1 - Provisional visual-first script**

Inputs:

- Topic brief.
- Fact pack.
- Catalog coverage report.
- Available candidate assets.
- Channel style.
- Target duration and pacing.

Outputs:

- Hook.
- Chapters.
- Narration sections.
- Narration beats.
- Required places, objects, activities, and shot types.
- Allowed visual treatment for each beat.
- Coverage confidence.

**Pass 2 - Final script**

Runs only after actual footage is ingested and verified. It:

- Rewrites unsupported wording.
- Adjusts timing to actual clips.
- Converts abstract or historical claims to graphics/maps when appropriate.
- Removes unsupported specificity.
- Locks pronunciation notes and section breaks.

The script must not require footage that is unavailable after final verification.

### 12.9 Narrative hierarchy

The application must distinguish:

```text
Project
  Chapter
    Narration section
      Narration beat
        Visual shot(s)
          Overlay(s)
```

A narration beat may last 5-20 seconds and may contain multiple 2-7 second visual shots. The system must not force every sentence to map to one long stock clip.

### 12.10 Scene contracts and provisional storyboard

#### P0 requirements

Each narration beat creates a structured scene contract containing:

- Narration text.
- Target duration.
- Required place ID and granularity.
- Required/desired objects and activities.
- Preferred shot types and camera movement.
- Allowed visual treatment.
- Candidate source assets.
- Match explanations and confidence.
- Maximum visual shot duration.

The metadata-based storyboard is marked provisional until source video verification.

The operator can optionally inspect it, but no routine approval is required.

### 12.11 Matching and global storyboard optimization

#### P0 requirements

Matching must apply hard filters before scoring:

- Approved source/uploader.
- Required geography.
- Required orientation.
- Minimum effective resolution.
- Availability and acquisition state.
- Excluded content policy.

Candidates that pass are ranked by:

- Metadata/text match.
- Required object/activity match.
- Shot and framing match.
- Time/style match.
- Visual continuity.
- Crop suitability.
- Uniqueness.

A second global optimization pass must:

- Limit source reuse.
- Penalize near-duplicate thumbnails and shots.
- Vary aerial, wide, medium, and detail perspectives.
- Avoid repeated camera motion patterns.
- Preserve reasonable geographic and time-of-day continuity.
- Reserve strongest shots for hook and transitions.
- Avoid severe crops.

The UI explains why each chosen clip was selected.

### 12.12 Acquisition planning

#### P0 requirements

The application generates a minimum-cost acquisition manifest.

Acquisition policy:

| Risk | Required acquisition |
|---|---|
| High-confidence supporting scene | One primary asset |
| Medium-confidence scene | Primary plus one alternate |
| Hook/hero shot | Two or three candidates |
| Weak exact-location metadata | Two candidates or exception |
| Map/graphic beat | No stock download |
| File already local | License-only task if needed |

Manifest item fields:

- Project name.
- Envato URL.
- Asset ID/title.
- Primary/alternate status.
- Scenes supported.
- Match confidence.
- Expected technical metadata.
- Download or license-only action.
- Completion status.

### 12.13 Manual Envato acquisition experience

#### P0 requirements

- Display one clear ordered queue.
- Copy project/license name with one click.
- Open the exact Envato item URL through the system browser.
- Allow a batch-level operator attestation that all downloads are being licensed to the displayed project.
- Watch configured download folders.
- Ignore temporary browser extensions such as `.crdownload`, `.part`, and incomplete files.
- Consider a file complete only after size is stable and it can be opened.
- Map the completed file to the active manifest item automatically.
- Ask the operator only when mapping is ambiguous.
- Support license-only tasks for already-local files.
- Allow optional license certificate attachment.
- Block final publication when a used asset lacks at least an operator-attested project license state.

### 12.14 Download ingestion and media processing

#### P0 requirements

For every completed source file:

1. Compute SHA-256.
2. Detect duplicate physical media.
3. Preserve the original unchanged.
4. Extract actual media metadata with ffprobe.
5. Compare declared vs actual metadata.
6. Create a 720p H.264 proxy.
7. Extract keyframes/contact sheets.
8. Detect black/frozen/corrupt sections.
9. Detect or estimate shot boundaries.
10. Generate candidate 2-7 second segments.
11. Generate visual metadata from low-resolution frames.
12. Verify scene-contract compatibility.
13. Store derivatives and results.

Original footage must never be overwritten.

### 12.15 Actual-footage verification

#### P0 requirements

The verification engine must determine:

- Whether the downloaded file corresponds to the expected source asset.
- Whether the visual content matches the metadata and scene contract.
- Whether the location evidence remains valid.
- Whether usable in/out ranges exist.
- Whether effective resolution after crop is sufficient.
- Whether the segment is visually distinct from neighboring scenes.

When a candidate fails:

1. Try an already-downloaded alternate.
2. Add a new acquisition item if policy allows.
3. Rewrite narration to available footage.
4. Use a map/graphic/text treatment.
5. Remove the beat if it is nonessential.
6. Raise an exception only when none of the above is safe.

### 12.16 Voiceover

#### P0 requirements

- Generate voice in logical 15-45 second sections, not one entire file or one file per sentence.
- Maintain a stable selected narrator and style profile.
- Support pronunciation overrides for place names.
- Obtain word-level timing directly or through forced alignment.
- Cache by text, voice, settings, model, and pronunciation dictionary hash.
- Regenerate only changed sections.
- Normalize joins between sections.
- Detect missing, clipped, or silent sections.

### 12.17 Captions

#### P0 requirements

- Generate timed SRT and WebVTT.
- Derive timing from final aligned narration.
- Support optional burned-in captions based on channel settings.
- Validate line length, duration, and overlap.
- Upload a timed caption track to YouTube.

### 12.18 Music and ambient sound

#### P1 requirements

- Maintain a local licensed music library.
- Select tracks by mood, tempo, and duration.
- Automatically duck under narration.
- Allow subtle source ambience when useful.
- Prevent abrupt music cuts.
- Track project license/use records for music.

Version 1 may ship with one configured background track or no music if the music module is not yet complete.

### 12.19 Automated editing

#### P0 requirements

The timeline engine must:

- Synchronize visual shots to narration timing.
- Keep every visual shot between configured minimum and 7.0 seconds maximum.
- Use hard cuts by default.
- Use transitions sparingly and consistently.
- Support maps, location labels, chapter cards, lower thirds, logo, and data callouts.
- Apply safe crop/reframe without prohibited upscaling.
- Normalize mixed codecs, pixel formats, and frame rates at render time.
- Preserve reasonable visual continuity.
- Generate scene-only, range, draft, and final renders.

### 12.20 Resolution and output rules

#### P0 requirements

Default final output:

- MP4 container.
- H.264 video.
- AAC-LC stereo audio at 48 kHz.
- 1920x1080.
- Progressive scan.
- yuv420p.
- BT.709 SDR.
- Fast-start metadata.

No automatic upscaling:

- A full-screen 1080p shot must retain at least 1920x1080 effective pixels after crop.
- Lower-resolution footage must be rejected or used as a smaller inset/graphic treatment without enlargement.

Qualified 4K:

- Output 3840x2160 only when every full-screen shot retains at least 3840x2160 effective pixels after crop/reframe.
- All raster graphics must be 4K-ready.
- No scene may rely on enlargement.
- If any scene fails, output is 1080p.

The app displays the exact scenes blocking 4K.

### 12.21 Automated quality control

#### P0 requirements

QC categories:

**Story and grounding**

- Unsupported factual claim.
- Geographic mismatch.
- Missing required location label.
- Script/visual contradiction.

**Media**

- Missing source.
- Corrupt frames.
- Black/frozen frames.
- Shot over 7.0 seconds.
- Effective-resolution failure.
- Severe crop.
- Duplicate/near-duplicate shots.
- Unexpected letterbox/pillarbox.
- Color-space mismatch.

**Audio**

- Clipping.
- Excessive silence.
- Missing narration.
- Loudness outside policy.
- Music overpowering speech.
- Abrupt section joins.

**Captions and packaging**

- Missing/overlapping captions.
- Title or thumbnail promise unsupported by video.
- Thumbnail exceeds upload limits.
- Description or chapters invalid.

**Rights and publishing**

- Missing license status.
- Duplicate upload attempt.
- Incorrect privacy state.
- Authentication or quota failure.

Correctable issues should be repaired automatically before raising an exception.

### 12.22 Title, thumbnail, description, and chapters

#### P0 requirements

The system generates three distinct packaging concepts, each with:

- Title.
- Search intent.
- Viewer promise.
- Thumbnail frame and template.
- Curiosity/benefit mechanism.
- Misleading-risk check.

Thumbnail rules:

- Use a frame from actual selected footage.
- Do not invent or replace the destination.
- Allow crop, contrast, blur, graphic shapes, labels, and typography.
- Export JPEG or PNG under 2 MB.
- Default 1280x720.

Description includes:

- Strong first lines.
- Natural keywords.
- Chapters.
- Concise summary.
- Relevant source links when appropriate.
- Required sponsorship/affiliate/synthetic-media disclosures.
- Related playlist/video links.

The application selects a recommended package but shows alternatives at final review.

### 12.23 YouTube upload and publishing

#### P0 requirements

- Use OAuth 2.0.
- Upload the final MP4 using resumable upload.
- Default privacy status: private.
- Upload custom thumbnail.
- Upload timed caption track.
- Set title, description, category, tags, playlist, audience setting, and disclosure flags.
- Record YouTube video ID, upload status, processing status, and errors.
- Prevent duplicate upload of the same final-render hash.
- Wait for processing completion before final review.
- After approval, publish or schedule when API/project permissions permit.
- Provide a fallback button to open the exact video in YouTube Studio.

### 12.24 Final review

#### P0 requirements

Final Review displays:

- Embedded/private video preview.
- QC pass/fail summary.
- Duration, resolution, shot count, average shot length.
- Unsupported claims: zero required.
- Location conflicts: zero required.
- License blockers: zero required.
- Title and thumbnail variants.
- Description and chapters.
- Complete scene audit reel.

Actions:

- Approve and schedule.
- Approve and publish.
- Keep private.
- Send back with reason.

A send-back reason should automatically route to the smallest affected stage.

### 12.25 Analytics and learning

#### P1 requirements

Collect snapshots at configurable intervals such as 1, 3, 7, 28, and 90 days.

Track:

- Views.
- Impressions and CTR when available.
- Watch time.
- Average view duration.
- Average percentage viewed.
- Audience retention curve.
- Relative retention.
- Traffic sources and search terms.
- Subscribers gained.
- Playlist/end-screen performance where available.

Map retention intervals to:

- Chapter.
- Narration beat.
- Visual shot.
- Shot length.
- Shot type.
- Location.
- Camera motion.
- On-screen text density.
- Voice pace.

Learning policy:

- Do not automatically change core strategy from one video.
- Require minimum views and repeated evidence.
- Store every weight update with before/after values and rationale.
- Allow operator rollback.

### 12.26 Autopilot scheduler

#### P1 requirements

- Configurable publication cadence.
- Configurable production queue depth.
- Do not create unlimited projects waiting for downloads.
- Default maximum:
  - Two active projects.
  - One project waiting for acquisition.
  - One private upload waiting for approval.
- Pause automatically when monthly API budget, disk-space minimum, or authentication state is invalid.
- Resume after resolution.

### 12.27 Exception inbox

#### P0 requirements

The app must provide one consolidated exception inbox with:

- Severity.
- Project.
- Stage.
- Plain-language problem.
- Evidence.
- Recommended action.
- Safe automated alternatives.
- Retry button.
- Resolve/override action.
- Audit trail.

Exception severity:

- **Blocker:** Cannot continue or publish.
- **High:** Automation can continue only through a defined fallback.
- **Medium:** Quality warning requiring later review.
- **Low:** Informational or maintenance issue.

### 12.28 Cost and quota controls

#### P0 requirements

- Track every external provider call.
- Record input/output hashes, provider, model, cost estimate, latency, and retries.
- Per-project and monthly budget limits.
- Bounded retries.
- No automatic retry for permanent validation errors.
- Reuse cached results.
- Surface quota exhaustion before starting a new project.

### 12.29 Backup and restore

#### P0 requirements

- Automated SQLite backup after clean checkpoint.
- Configurable daily/weekly/monthly retention.
- Export project manifest, metadata, scripts, license records, and final outputs.
- Restore database from backup.
- Verify original media by hash.
- Rebuild proxies and derivatives from originals.
- Never require the cache folder for disaster recovery.

---

## 13. UI/UX requirements

### 13.1 Design principles

- Show next action first.
- Use one primary action per screen.
- Keep status visible.
- Prefer progressive disclosure.
- Use side drawers instead of modal chains.
- Expose confidence and evidence without forcing the operator to inspect it.
- Batch routine decisions.
- Surface only exceptions by default.
- Preserve operator changes and provide undo.

### 13.2 Primary navigation

```text
Autopilot
Downloads
Final Review
Library
Settings
```

An exception badge is globally visible.

### 13.3 Autopilot screen

Must show:

- Current project and stage.
- Overall pipeline progress.
- Production queue.
- Waiting human actions.
- Blocked exceptions.
- Media worker/render/upload status.
- Disk and API budget health.

Primary controls:

- Start next video.
- Pause/resume autopilot.
- Open current project.
- View exceptions.

### 13.4 Downloads screen

Must show:

- Project/license name.
- Ordered remaining queue.
- Current required asset.
- Match confidence and supported scenes.
- Download vs license-only action.
- Open next asset.
- Copy project name.
- Detected file progress.
- Mapping/processing result.

The screen should advance automatically after a successful ingest.

### 13.5 Final Review screen

Layout:

```text
Video preview
QC summary
Title/thumbnail variants
Description/chapters
Approval actions
Expandable scene audit
```

The operator should be able to approve a clean project without entering the editor.

### 13.6 Project detail screen

Available when needed. Tabs:

- Overview.
- Research.
- Script & coverage.
- Storyboard.
- Assets/licenses.
- Voice/audio.
- Renders/QC.
- Publishing/analytics.
- Audit log.

### 13.7 Storyboard exception editor

Three-pane layout:

```text
Narration beats | Preview | Candidate shots / evidence
```

Actions:

- Replace shot.
- Compare candidates.
- Rewrite narration.
- Use map/graphic.
- Split/merge beat.
- Verify/reject location.
- Regenerate only affected range.

### 13.8 Library views

- Grid.
- Table.
- Coverage matrix.
- Map.
- Metadata exception inbox.

### 13.9 Accessibility and keyboard behavior

- Full keyboard navigation for primary actions.
- Visible focus states.
- Status is not communicated by color alone.
- Captions and readable contrast in previews.
- Shortcuts for next download, retry, approve, pause, and open exception.

---

## 14. Business and editorial rules

### 14.1 Permitted visual treatments

Every visual shot must be classified as one of:

1. Exact-location footage.
2. Contextual verified footage at the narration's allowed granularity.
3. Map/diagram/informational graphic.
4. Text, quotation, or properly licensed archival image.

There is no generic "semantically similar stock" fallback.

### 14.2 Shot-duration policy

- Hard maximum: 7.0 seconds.
- Preferred range: 3.0-5.5 seconds.
- Minimum: 1.5 seconds unless used as a deliberate rapid montage.
- The system may change shots under continuous narration.
- Retention analytics can later adjust the preferred distribution, not the 7.0-second hard maximum unless the operator changes policy.

### 14.3 Repetition policy

Default limits:

- Same exact segment: once per video.
- Same source asset: normally no more than two visual shots.
- Same perceptual duplicate cluster: no adjacent use.
- Same camera-motion/shot-type combination: no more than three consecutive shots.

### 14.4 Accuracy policy

- Named place requires matching place evidence.
- Fact source must support the actual wording used.
- The title and thumbnail must accurately represent the final video.
- When uncertain, reduce specificity rather than invent confidence.

### 14.5 Licensing policy

- Every used Envato asset must have a project-specific license state.
- The physical file may be reused locally; a new project-use license must be tracked when required.
- License records and optional certificates are retained with the project.
- The app never automates Envato downloads or account interactions.

### 14.6 AI content policy

- Original footage is not sent in full to AI providers.
- AI output is treated as a proposal until schema and evidence checks pass.
- Models cannot directly mutate human-verified metadata.
- Provider/model/version is recorded for every generated artifact.
- Synthetic-media disclosure is set when the final content materially alters or generates a realistic place, event, or person.

---

## 15. Non-functional requirements

### 15.1 Reliability

- Durable local job state.
- Crash-safe database transactions.
- Resume after app restart or machine reboot.
- No duplicate upload or paid-provider operation.
- Original media integrity verified by hash.

### 15.2 Performance

Target behavior on a typical modern Windows workstation:

- Initial 26,000-row import completes without UI freezing.
- Common filtered catalog searches return in under 300 ms after indexing.
- App opens to usable dashboard in under 5 seconds, excluding migrations.
- Progress updates at least every 2 seconds for long-running work.
- Preview playback and scrolling remain responsive while background jobs run.
- Hardware-accelerated draft rendering is used when available.

Hardware-dependent render duration is measured and reported rather than treated as a universal hard guarantee.

### 15.3 Security

- No Node.js access in the renderer.
- Context isolation and process sandboxing enabled.
- Privileged APIs exposed only through validated preload IPC.
- API secrets and OAuth refresh tokens encrypted with OS-backed storage.
- External URLs restricted to allowlisted HTTPS domains.
- No untrusted remote content loaded into privileged windows.
- Local media paths are served through a controlled protocol or validated IPC, not unrestricted file access.

### 15.4 Maintainability

- Strict TypeScript.
- Versioned schemas and migrations.
- Provider adapters.
- Structured logs.
- Deterministic manifests.
- Unit, integration, media-fixture, and end-to-end tests.
- No business logic embedded exclusively in UI components.

### 15.5 Privacy

- Source videos remain local by default.
- Only minimized derivative data is sent externally.
- Provider-call payloads can be inspected in the audit log with secrets redacted.
- Analytics and OAuth data remain local except required API calls.

---

## 16. Release scope

### 16.1 P0 - First complete production release

- Windows desktop installer.
- XLSX/CSV import and diff.
- Library/FTS search.
- Place hierarchy and confidence.
- Coverage and opportunity scoring.
- Research/fact pack.
- Provisional script and storyboard.
- Exact-location hard filters.
- Acquisition manifest and watched folder.
- ffprobe/proxy/keyframe/segment processing.
- Actual-footage verification.
- Final script and voiceover.
- FFmpeg timeline and 1080p final render.
- Core QC.
- Titles/thumbnails/descriptions/chapters.
- Private YouTube upload, thumbnail, captions.
- Final approval screen.
- Durable jobs, cost controls, backup/restore.

### 16.2 P1 - Routine autonomous channel operation

- Autopilot cadence and queue limits.
- Music library and audio ducking.
- Full analytics/retention mapping.
- Weight-learning recommendations.
- Google Sheets sync.
- Qualified 4K output.
- App auto-update and signing.
- More advanced duplicate and continuity analysis.

### 16.3 P2 - Expansion

- Multiple channels.
- Multiple languages/voices.
- Shorts/vertical formats.
- Advanced animated maps.
- Local AI providers.
- Multi-machine render worker.
- Direct uploader feeds and contracts.

---

## 17. Product acceptance criteria

The product is not ready for routine use until all of the following are demonstrated on real data:

1. Import the full catalog and preserve raw data.
2. Generate viable topics from visual coverage, not generic ideation.
3. Produce a complete provisional storyboard without source downloads.
4. Generate a minimal acquisition queue.
5. Detect and map manually downloaded files.
6. Validate actual footage and replace/rewrite failures automatically.
7. Produce a final script with no unsupported place-specific claims.
8. Generate coherent voiceover and timed captions.
9. Render a 1080p H.264/AAC MP4 with no full-screen upscaling.
10. Keep every visual shot at or below 7.0 seconds.
11. Pass geographic, media, audio, caption, licensing, and packaging QC.
12. Upload privately with thumbnail and captions.
13. Require final approval before public release.
14. Resume after forced shutdown without duplicate paid work.
15. Rebuild a published video from its stored manifest and source hashes.
16. Complete at least five pilot videos from three destination clusters.
17. Achieve the routine two-gate workflow on at least four of the five pilots.

Detailed tests are defined in `06-ACCEPTANCE-TESTS.md`.

---

## 18. Key risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Metadata is incorrect or incomplete | Visual mismatch | Preserve evidence layers; hard location confidence gates; actual footage verification |
| Source clip does not match thumbnail | Rework | Acquire alternates based on risk; verify before final script |
| Too few clips for target runtime | Repetition | Coverage gate; narrow topic; use maps/graphics; reject concept |
| Envato item becomes unavailable | Blocked acquisition | Download promptly after project approval; alternate candidates; local reuse |
| AI hallucinates facts | Reputation risk | Sourced fact pack; claim IDs; validation; omit conflicts |
| Generic AI selection repeats shots | Low retention | Global diversity optimization and perceptual duplicate penalties |
| Large media files overwhelm storage | Cost/delay | Metadata-first acquisition, content-addressed storage, proxy/cache lifecycle |
| Desktop app crashes mid-render | Lost time | Durable jobs, checkpointing, child processes, resumable stages |
| Paid API retries run away | Cost | Input hashes, bounded retries, project/monthly budgets |
| Unverified YouTube API limits visibility | Publishing friction | Private-first workflow; audit project; Studio fallback |
| Electron attack surface | Credential/data risk | Context isolation, sandbox, IPC validation, safe storage, allowlists |
| Fully autonomous output becomes formulaic | Channel performance/monetization risk | Original research, structured editorial templates, analytics learning, final human review |

---

## 19. Open configuration decisions

These are settings, not blockers:

- Channel name and brand system.
- Default target duration.
- Initial narrator and TTS provider.
- Preferred research and language-model providers.
- Monthly API budget.
- Publication cadence.
- Default music policy.
- Exact minimum topic/coverage thresholds after pilot calibration.
- Whether final approval can schedule directly or must open YouTube Studio.

The technical architecture must keep these configurable without code changes.



[[PAGEBREAK]]
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



[[PAGEBREAK]]
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



[[PAGEBREAK]]
# IPC and External Provider Contracts

## 1. Contract goals

- Renderer remains unprivileged.
- Every request and response is runtime-validated.
- Long-running operations return durable job IDs.
- Provider output is normalized behind stable internal interfaces.
- No provider-specific object leaks into domain or UI layers.
- Contract changes are versioned and tested.

---

## 2. Renderer preload API

```ts
interface VideoFactoryDesktopApi {
  command<TName extends CommandName>(
    name: TName,
    payload: CommandPayload<TName>
  ): Promise<CommandAccepted>;

  query<TName extends QueryName>(
    name: TName,
    payload: QueryPayload<TName>
  ): Promise<QueryResult<TName>>;

  subscribe<TName extends EventName>(
    name: TName,
    handler: (event: EventPayload<TName>) => void
  ): () => void;
}
```

The preload must not expose:

- Raw `ipcRenderer`.
- Arbitrary paths.
- `child_process`.
- Generic SQL.
- Generic HTTP fetch with secrets.
- Arbitrary `shell.openExternal`.

---

## 3. Common envelopes

```ts
interface RequestEnvelope<T> {
  contractVersion: 1;
  requestId: string;
  method: string;
  payload: T;
}

interface SuccessEnvelope<T> {
  contractVersion: 1;
  requestId: string;
  ok: true;
  data: T;
}

interface ErrorEnvelope {
  contractVersion: 1;
  requestId: string;
  ok: false;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details?: unknown;
  };
}

interface CommandAccepted {
  jobId?: string;
  projectId?: string;
  acceptedAt: string;
}
```

---

## 4. P0 command catalog

### Application/setup

```text
app.runDiagnostics
app.selectPath
app.saveSettings
app.connectYouTube
app.disconnectProvider
app.createBackup
app.restoreBackup
```

### Catalog

```text
catalog.stageImport
catalog.applyImport
catalog.cancelImport
catalog.updateAssetMetadata
catalog.bulkUpdateMetadata
catalog.acceptMetadataSuggestion
catalog.rejectMetadataSuggestion
catalog.mergePlaces
catalog.splitPlace
```

### Production

```text
project.startAutopilot
project.createGuided
project.pause
project.resume
project.cancel
project.retryStage
project.resolveException
project.overrideSetting
```

### Acquisition

```text
acquisition.beginBatch
acquisition.openNextAsset
acquisition.markLicenseOnlyComplete
acquisition.mapFile
acquisition.rejectFile
acquisition.attachLicenseCertificate
```

### Storyboard/recovery

```text
storyboard.replaceShot
storyboard.rewriteBeat
storyboard.useGraphic
storyboard.splitBeat
storyboard.mergeBeats
storyboard.verifyLocation
storyboard.rejectCandidate
```

### Render/publishing

```text
render.previewRange
render.retry
publication.approveAndSchedule
publication.approveAndPublish
publication.keepPrivate
publication.sendBack
publication.openYouTubeStudio
```

---

## 5. P0 query catalog

```text
app.getHealth
app.getSettings
app.getDiagnostics
app.getStorageStatus
app.getProviderHealth

autopilot.getDashboard
project.get
project.list
project.getTimelineAudit
project.getQcSummary
project.getAuditLog

catalog.search
catalog.getAsset
catalog.getCoverage
catalog.getImportPreview
catalog.getMetadataExceptions

acquisition.getQueue
acquisition.getActiveItem

exceptions.list
exceptions.get

publication.getFinalReview
```

P1:

```text
analytics.getChannelDashboard
analytics.getProjectRetention
analytics.getRecommendations
```

---

## 6. Event catalog

```text
app.health_changed
app.notification
storage.space_changed
provider.health_changed
job.created
job.progress
job.completed
job.failed
project.state_changed
project.updated
acquisition.item_changed
acquisition.file_detected
acquisition.file_mapped
exception.created
exception.resolved
render.progress
render.ready
publication.upload_progress
publication.processing_status
publication.ready_for_review
analytics.snapshot_ready
```

### Example progress event

```json
{
  "eventName": "render.progress",
  "contractVersion": 1,
  "timestamp": "2026-07-30T12:00:00Z",
  "payload": {
    "projectId": "prj_01",
    "jobId": "job_44",
    "renderId": "rnd_08",
    "phase": "encoding",
    "progress": 0.64,
    "processedMs": 287400,
    "expectedMs": 449000,
    "speed": 1.82,
    "etaSeconds": 89
  }
}
```

---

## 7. Catalog search contract

### Request

```ts
interface CatalogSearchRequest {
  text?: string;
  authorIds?: string[];
  placeIds?: string[];
  includeDescendants?: boolean;
  activities?: string[];
  shotTypes?: string[];
  objects?: string[];
  timeOfDay?: string[];
  styles?: string[];
  orientations?: Array<'horizontal' | 'vertical' | 'square' | 'unknown'>;
  minimumDeclaredWidth?: number;
  minimumLocationConfidence?: number;
  localStatus?: Array<'not_downloaded' | 'local' | 'processed'>;
  verificationStatus?: string[];
  usedStatus?: Array<'used' | 'unused'>;
  sort?: 'relevance' | 'newest' | 'quality' | 'coverage';
  cursor?: string;
  limit?: number;
}
```

### Response

```ts
interface CatalogSearchResult {
  items: Array<{
    assetId: string;
    title: string;
    thumbnailUri?: string;
    authorName?: string;
    effectivePlace?: PlaceSummary;
    locationConfidence?: number;
    tags: string[];
    durationMs?: number;
    declaredResolution?: { width: number; height: number };
    localStatus: string;
    relevanceScore?: number;
  }>;
  nextCursor?: string;
  totalApproximate: number;
}
```

---

## 8. Project creation contract

```ts
interface StartAutopilotRequest {
  channelId: string;
  requestedStart?: 'now' | 'next_schedule';
  optionalConstraints?: {
    allowedPlaceIds?: string[];
    blockedPlaceIds?: string[];
    targetDurationMs?: number;
    maximumDownloads?: number;
  };
}

interface CreateGuidedProjectRequest {
  channelId: string;
  titleOrTopic?: string;
  placeIds?: string[];
  startingScript?: string;
  targetDurationMs?: number;
  mode: 'guided';
}
```

---

## 9. Exception-resolution contract

```ts
interface ResolveExceptionRequest {
  exceptionId: string;
  action:
    | 'retry'
    | 'use_alternate'
    | 'rewrite'
    | 'use_graphic'
    | 'map_file'
    | 'reauthenticate'
    | 'increase_budget'
    | 'change_storage'
    | 'operator_override'
    | 'cancel_project';
  parameters?: Record<string, unknown>;
  note?: string;
}
```

The service validates whether an override is permitted for the exception type.

---

## 10. Language-model provider

```ts
interface LanguageModelProvider {
  generateStructured<T>(request: {
    operation: 'topic_candidates' | 'research_plan' | 'fact_extraction' |
      'provisional_script' | 'final_script' | 'scene_contracts' |
      'packaging' | 'repair';
    systemPolicy: string;
    input: unknown;
    outputSchema: JsonSchema;
    model?: string;
    temperature?: number;
    maxOutputTokens?: number;
    idempotencyKey: string;
  }): Promise<ProviderResult<T>>;
}
```

Requirements:

- Schema-constrained output.
- Usage/cost reporting.
- Provider request ID.
- No hidden mutation of application data.
- One corrective retry after validation failure.

---

## 11. Vision provider

```ts
interface VisionProvider {
  analyzeContactSheet(request: {
    operation: 'asset_verify' | 'segment_rank' | 'semantic_qc';
    imagePaths: string[];
    metadata: Record<string, unknown>;
    sceneContract?: SceneContract;
    outputSchema: JsonSchema;
    idempotencyKey: string;
  }): Promise<ProviderResult<VisionAnalysis>>;
}

interface VisionAnalysis {
  visibleObjects: Array<{ value: string; confidence: number }>;
  activities: Array<{ value: string; confidence: number }>;
  shotType?: string;
  cameraMotion?: string;
  timeOfDay?: string;
  weather?: string;
  textOrLogos?: string[];
  qualityWarnings: string[];
  contractMatch?: {
    pass: boolean;
    score: number;
    mismatches: string[];
  };
}
```

The provider is not the sole authority for exact location unless the landmark is unmistakable and policy allows the evidence type.

---

## 12. Web research provider

```ts
interface WebResearchProvider {
  search(request: {
    queries: string[];
    languageCode: string;
    countryCode?: string;
    freshnessDays?: number;
    maxResultsPerQuery: number;
    idempotencyKey: string;
  }): Promise<ProviderResult<SearchResult[]>>;

  fetch(request: {
    url: string;
    extractionMode: 'article' | 'facts' | 'metadata';
    idempotencyKey: string;
  }): Promise<ProviderResult<FetchedSource>>;
}
```

Provider results must identify the real URL and source metadata. The application must not permit the language model to invent a source record.

---

## 13. TTS provider

```ts
interface TextToSpeechProvider {
  synthesize(request: {
    text: string;
    voiceId: string;
    model?: string;
    speed?: number;
    styleSettings?: Record<string, unknown>;
    pronunciationDictionary?: Record<string, string>;
    outputFormat: 'wav' | 'mp3';
    requestTimings: boolean;
    idempotencyKey: string;
  }): Promise<ProviderResult<{
    audioPath: string;
    durationMs: number;
    wordTimings?: Array<{
      word: string;
      startMs: number;
      endMs: number;
    }>;
  }>>;
}
```

---

## 14. Alignment provider

```ts
interface SpeechAlignmentProvider {
  align(request: {
    audioPath: string;
    transcript: string;
    languageCode: string;
    idempotencyKey: string;
  }): Promise<ProviderResult<{
    words: Array<{ word: string; startMs: number; endMs: number; confidence: number }>;
    transcriptMatchScore: number;
  }>>;
}
```

---

## 15. Keyword metrics provider

```ts
interface KeywordMetricsProvider {
  getMetrics(request: {
    keywords: string[];
    countryCode?: string;
    languageCode: string;
    idempotencyKey: string;
  }): Promise<ProviderResult<Array<{
    keyword: string;
    metricType: string;
    value: number | null;
    provider: string;
    youtubeNative: boolean;
    confidence: number;
    metadata: Record<string, unknown>;
  }>>>;
}
```

The UI and domain must preserve `youtubeNative` so Google Search proxy metrics cannot be mislabeled.

---

## 16. YouTube provider

```ts
interface YouTubeProvider {
  uploadVideo(request: UploadVideoRequest): Promise<UploadSessionResult>;
  resumeUpload(request: ResumeUploadRequest): Promise<UploadSessionResult>;
  getProcessingStatus(videoId: string): Promise<ProcessingStatus>;
  setThumbnail(videoId: string, filePath: string): Promise<void>;
  insertCaption(videoId: string, filePath: string, language: string): Promise<string>;
  addToPlaylist(videoId: string, playlistId: string): Promise<void>;
  updateVideo(request: UpdateVideoRequest): Promise<void>;
  queryAnalytics(request: AnalyticsQuery): Promise<AnalyticsResult>;
}
```

### Upload request

```ts
interface UploadVideoRequest {
  channelId: string;
  filePath: string;
  fileSha256: string;
  title: string;
  description: string;
  tags: string[];
  categoryId: string;
  privacyStatus: 'private';
  madeForKids: boolean;
  containsSyntheticMedia: boolean;
  idempotencyKey: string;
}
```

---

## 17. Provider result wrapper

```ts
interface ProviderResult<T> {
  data: T;
  provider: string;
  model?: string;
  requestId?: string;
  usage?: Record<string, number>;
  estimatedCostUsd?: number;
  latencyMs: number;
  cached: boolean;
  rawResponseRef?: string;
}
```

---

## 18. Render worker contract

### Request

```ts
interface StartRenderRequest {
  projectId: string;
  renderManifestId: string;
  renderType: 'scene_preview' | 'range_preview' | 'draft' | 'final_1080p' | 'final_4k';
  range?: { startMs: number; endMs: number };
  force?: boolean;
}
```

### Progress

```ts
interface RenderProgress {
  renderId: string;
  phase: 'preparing' | 'decoding' | 'filtering' | 'encoding' | 'validating';
  progress: number;
  processedMs?: number;
  expectedMs?: number;
  fps?: number;
  speed?: number;
  etaSeconds?: number;
}
```

---

## 19. Contract security tests

The test suite must verify:

- Unknown IPC method rejected.
- Invalid payload rejected before main/service call.
- Renderer cannot pass arbitrary filesystem path to open/delete operations.
- External URL outside allowlist rejected.
- Event unsubscribe works and does not leak listeners.
- Provider response with extra/missing required fields rejected.
- Secret values never appear in renderer responses or logs.
- Contract version mismatch fails clearly.



[[PAGEBREAK]]
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

## 20. Release gates

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



[[PAGEBREAK]]
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



[[PAGEBREAK]]
# Official Technical and Policy References

Accessed July 30, 2026. These references support implementation constraints and should be rechecked during development because APIs, quotas, and policies can change.

## Electron

1. Electron process model: https://electronjs.org/docs/latest/tutorial/process-model
2. Electron security checklist: https://electronjs.org/docs/latest/tutorial/security
3. Context isolation: https://electronjs.org/docs/latest/tutorial/context-isolation
4. Process sandboxing: https://electronjs.org/docs/latest/tutorial/sandbox
5. Utility processes: https://electronjs.org/docs/latest/api/utility-process
6. Inter-process communication: https://electronjs.org/docs/latest/tutorial/ipc
7. OS-backed safe storage: https://electronjs.org/docs/latest/api/safe-storage
8. Power-save blocker: https://electronjs.org/docs/latest/api/power-save-blocker
9. Code signing: https://electronjs.org/docs/latest/tutorial/code-signing
10. Updating applications: https://electronjs.org/docs/latest/tutorial/updates
11. Electron performance guidance: https://electronjs.org/docs/latest/tutorial/performance
12. Electron Forge Squirrel.Windows maker: https://www.electronforge.io/config/makers/squirrel.windows

## SQLite

13. SQLite home/documentation: https://sqlite.org/
14. SQLite appropriate uses for desktop application files: https://sqlite.org/whentouse.html
15. SQLite Write-Ahead Logging: https://sqlite.org/wal.html
16. SQLite FTS5: https://sqlite.org/fts5.html
17. SQLite PRAGMA reference: https://sqlite.org/pragma.html

## FFmpeg

18. FFmpeg documentation: https://ffmpeg.org/ffmpeg-all.html
19. FFmpeg filter documentation: https://ffmpeg.org/ffmpeg-filters.html
20. ffprobe documentation: https://ffmpeg.org/ffprobe-all.html

## YouTube and Google APIs

21. YouTube recommended upload encoding: https://support.google.com/youtube/answer/1722171
22. YouTube videos.insert: https://developers.google.com/youtube/v3/docs/videos/insert
23. YouTube video resource/status fields, including scheduling and synthetic-media disclosure: https://developers.google.com/youtube/v3/docs/videos
24. YouTube thumbnails.set: https://developers.google.com/youtube/v3/docs/thumbnails/set
25. YouTube captions.insert: https://developers.google.com/youtube/v3/docs/captions/insert
26. YouTube Analytics metrics: https://developers.google.com/youtube/analytics/metrics
27. YouTube Analytics dimensions: https://developers.google.com/youtube/analytics/dimensions
28. YouTube Analytics channel reports: https://developers.google.com/youtube/analytics/channel_reports
29. Google Ads Keyword Planner historical metrics: https://developers.google.com/google-ads/api/docs/keyword-planning/generate-historical-metrics

## Envato Elements

30. Download limits and prohibition on automated/bulk downloading: https://help.elements.envato.com/hc/en-us/articles/360000621703-Do-any-limits-apply-to-downloads
31. Envato Elements license: https://help.elements.envato.com/hc/en-us/articles/360000628966-Envato-Elements-License
32. Creating a new license without re-downloading: https://help.elements.envato.com/hc/en-us/articles/360000621763-How-to-Create-a-New-License-on-Envato
33. License certificates: https://help.elements.envato.com/hc/en-us/articles/360000621443-Envato-item-license-certificate
34. License FAQ: https://help.elements.envato.com/hc/en-us/articles/360000629346-Envato-Elements-License-FAQ

## Interpretation notes

- Envato account actions remain manual because current Envato rules prohibit scripts, bots, and automated mass-download tools.
- Envato licenses are tracked per project use; an already-downloaded physical file may be reused locally after creating the appropriate new project license.
- SQLite WAL is kept on a local filesystem because WAL is not supported across a network filesystem.
- Electron renderer security follows context isolation, sandboxing, no Node integration, restrictive navigation, validated IPC, and OS-backed credential storage.
- Automatic YouTube uploads are private first. Unverified API projects may be restricted to private visibility until audit.
- Google Ads historical metrics are Google Search metrics and are treated only as a demand proxy, never exact YouTube search volume.

