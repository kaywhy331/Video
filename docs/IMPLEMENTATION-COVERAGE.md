# Implementation Coverage

## Delivered vertical slice

| Capability | Status |
|---|---|
| Windows desktop shell | Implemented |
| Local SQLite/WAL/FTS5 database | Implemented |
| XLSX/CSV catalog import and mapping | Implemented |
| Raw row preservation and human overrides | Implemented |
| Paginated catalog search and facets | Implemented |
| Destination coverage analysis | Implemented |
| Metadata-only Autopilot fallback | Implemented |
| OpenAI-compatible structured-script adapter | Implemented |
| Exact-location hard gate | Implemented |
| Candidate ranking and reuse penalty | Implemented |
| Envato project acquisition manifest | Implemented |
| Manual Envato browser handoff | Implemented |
| License attestation | Implemented |
| Watched-folder stable-file detection | Implemented |
| Content-addressed originals | Implemented |
| FFprobe, proxy, contact sheet, candidate windows | Implemented |
| 1080p no-upscale gate | Implemented |
| Windows SAPI narration | Implemented |
| FFmpeg synchronized render pipeline | Implemented |
| SRT captions | Implemented |
| Automated QC and exception creation | Implemented |
| Packaging variants and frame thumbnails | Implemented |
| Google OAuth and private upload | Implemented |
| Final publish/schedule approval | Implemented |
| Job records, restart recovery, progress UI | Implemented |

## Deliberately constrained in alpha

- One structured scene track rather than a general nonlinear editor
- One narrator provider in the UI: Windows SAPI
- 1080p final renderer; strict 4K eligibility data is calculated but the 4K final profile is not exposed
- Descriptive metadata-grounded local scripts when no external LLM is configured
- No automated Envato account operation
- No automatic public publishing
- No semantic computer-vision verification beyond metadata and technical inspection
- No scene-level YouTube analytics learning loop yet

## Production gate

The application should be promoted beyond alpha only after:

1. Five representative 4–6 minute pilot videos complete end-to-end.
2. Every used asset has a project-specific license record.
3. No named-location scene uses lower-granularity footage.
4. No rendered shot exceeds seven seconds.
5. No full-screen source is upscaled.
6. Restart recovery is proven during ingest, render, and upload.
7. YouTube duplicate-upload protection is proven.
8. A backup/restore drill succeeds.
