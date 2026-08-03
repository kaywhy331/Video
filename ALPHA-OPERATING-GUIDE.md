# VideoFactory Desktop Alpha — Operating Guide

## What this build is

This package is the first implementation vertical slice of the desktop PRD. It is designed for one Windows operator and keeps source media local. It automates catalog import, footage-grounded planning, acquisition tracking, watched-folder ingest, proxies/segments, voice, FFmpeg rendering, quality checks, YouTube packaging, and private-first publishing.

## First run

1. Extract the package to a normal local folder such as `D:\VideoFactoryDesktop`.
2. Install Node.js 22 LTS or newer if it is not already installed.
3. Double-click `RUN-ON-WINDOWS.cmd`.
4. In Settings, select:
   - working/data folder
   - Envato download watch folder
   - media vault
   - FFmpeg/ffprobe overrides only if auto-discovery fails
5. Import the real XLSX/CSV catalog in Library.
6. Configure an OpenAI-compatible model endpoint/key if AI scripting is desired.
7. Configure Google OAuth desktop credentials before private YouTube upload.

## Routine workflow

1. Autopilot creates a footage-supported project and download manifest.
2. Downloads opens the next Envato asset in the browser.
3. License the item for the displayed project, download it, and record the license action.
4. The watched folder ingests the completed file and creates local derivatives.
5. The production pipeline creates the synchronized video and uploads privately when credentials are configured.
6. Final Review shows QC, titles, thumbnails, description, and the private video.
7. Approve publication or keep the upload private.

## Safety rules enforced

- Exact-place narration cannot be matched with sibling or unrelated locations.
- Source originals are hashed and preserved.
- Visual shots are capped at seven seconds.
- Full-screen raster footage is never automatically upscaled.
- Final output defaults to 1920×1080 H.264/AAC MP4.
- 4K is allowed only when every full-screen source remains true 4K after crop.
- Used assets must have project-license state before final QC passes.
- Automatic YouTube uploads start private.

## Alpha limitations

- The first pass should be run on one destination and a 4–6 minute pilot.
- Vision verification currently relies on metadata/contact-sheet provider plumbing and needs calibration with the chosen model.
- Search-demand and research providers require operator-owned credentials.
- Windows installer signing and clean-machine testing remain release-hardening work.
- Do not rely on this alpha for unsupervised public publication.
