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
