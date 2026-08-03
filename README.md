# VideoFactory Desktop

**Build:** 0.1.0-alpha.2 launcher repair

VideoFactory Desktop is a single-user Windows production application that turns a metadata catalog of licensed stock footage into exact-location-grounded YouTube videos.

It is intentionally **not** a generic text-to-video generator. A narration scene can only use:

1. exact-location footage,
2. contextual footage whose verified geography is no more specific than the narration,
3. a map/graphic, or
4. a text/archival treatment.

There is no silent “looks similar” fallback.

## What this alpha implements

- Electron + React + TypeScript desktop shell
- Local SQLite database with WAL and FTS5 using Electron’s bundled `node:sqlite`
- XLSX/CSV import, detected column mapping, import diffs, raw-row retention
- Searchable 26K+ asset library with geographic coverage clusters
- Human metadata overrides that survive later spreadsheet imports
- Metadata-first Autopilot project creation
- Scene contracts and exact-location hard filtering
- Globally penalized source reuse
- Project-specific Envato acquisition queue
- Operator-controlled Envato page opening and license attestation
- Watched download folder that ignores partial browser downloads
- SHA-256 content-addressed original storage
- FFprobe inspection, 720p proxies, contact sheets, and 2–7 second candidate segments
- Strict no-upscale 1080p eligibility
- Built-in Windows SAPI narration fallback
- FFmpeg scene synchronization, captions, draft render, final H.264/AAC MP4 render, and loudness normalization
- Automated render, rights, duration, and grounding checks
- Three packaging concepts and extracted thumbnail frames
- Google OAuth desktop flow and private-first YouTube upload
- Final human publication/scheduling gate
- Local durable job records, progress events, restart recovery, exception inbox, and diagnostics

## Routine human actions

1. License and download the asset requested by the Downloads screen.
2. Approve the completed private YouTube upload.

Uncertain mappings, media failures, location conflicts, rights gaps, and no-upscale violations become exceptions rather than unsafe automatic guesses.

## Development prerequisites

- Windows 10 or Windows 11
- Node.js 22.12+ LTS recommended; Node.js 24 is also supported
- npm
- Sufficient local media storage

FFmpeg and FFprobe are included through static packages. Paths can be overridden in Settings.

## Run on Windows

1. Fully extract the ZIP to a local folder such as `D:\VideoFactoryDesktop`.
2. Double-click `RUN-ON-WINDOWS.cmd`.
3. Leave the terminal open while the development build is running.

The first launch installs the declared npm dependencies. The application uses Electron’s bundled SQLite runtime, so no native SQLite compiler toolchain is required. A failed launch no longer disappears: the terminal stays open and writes `VideoFactory-Last-Startup.log` beside the launcher.

Manual equivalent:

```powershell
npm install --include=dev --no-fund --no-audit
npm run doctor
npm run dev
```

## Validate

```powershell
npm run validate
```

This runs TypeScript checking, automated tests, and the production bundle build.

## Package for Windows

```powershell
npm run package:win
```

Artifacts are written to `release/`.

## First-run walkthrough

1. Open **Library**.
2. Import the 26K-row XLSX or CSV.
3. Review the detected field mapping and commit the import.
4. Open **Settings** and set the media library, watched download folder, narrator, optional LLM endpoint, and YouTube OAuth credentials.
5. Run diagnostics.
6. Open **Autopilot** and start the next video.
7. In **Downloads**, copy the Envato project name, open each requested asset, license/download it, and record the license.
8. The watcher ingests completed downloads, generates proxies and segments, and verifies 1080p eligibility.
9. Autopilot renders the draft and final MP4.
10. Review the private upload in **Final Review** and approve publishing or scheduling.

## Demo catalog and media

A small sample catalog is included at:

```text
samples/demo-catalog.csv
```

Generate matching local test videos with:

```powershell
npm run demo:media
```

The sample URLs are intentionally non-operational placeholders. Use **Map downloaded file** to attach the generated clips to sample acquisition items.

## Data locations

The first run defaults to:

```text
Documents\VideoFactory\
  data\
  ingest\envato\
  media\
  projects\
  output\
  backups\
```

Originals are stored once by SHA-256. Projects reference files and segments rather than copying multi-gigabyte media.

## Security

- Renderer has no Node.js access.
- IPC is allowlisted and schema-validated.
- External navigation is deny-by-default.
- Only allowlisted Envato and YouTube HTTPS links can open.
- API credentials and OAuth tokens use Electron `safeStorage`.
- Logs redact common secret patterns.
- The active SQLite WAL database remains local.
- Uploads begin private.

## Output policy

Default final output:

```text
MP4
H.264
AAC
1920×1080
30 fps
yuv420p
48 kHz audio
fast-start metadata
```

No AI or conventional upscaling is silently applied. A source that cannot fill 1080p is blocked or must be intentionally reframed as an inset. The architecture includes a qualified-4K policy, while the current vertical slice renders final 1080p.

## Current release level

This repository is a functional **vertical-slice alpha**, not yet a production-validated release. The full release gate in the included specification requires five representative pilot videos and completion of all P0 acceptance tests. See:

- `docs/IMPLEMENTATION-COVERAGE.md`
- `docs/PRODUCTION-HARDENING.md`
- `docs/spec/`
