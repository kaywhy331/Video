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
