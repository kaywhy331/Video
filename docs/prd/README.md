# VideoFactory Desktop - Build Specification Package

**Version:** 1.0  
**Status:** Build-ready baseline  
**Primary platform:** Windows 10/11 x64  
**Operating model:** Single-user, internal desktop application  
**Primary output:** Long-form 16:9 YouTube videos assembled from licensed Envato stock footage

## Purpose

This package defines the product requirements, technical architecture, data model, workflow state machine, contracts, render profiles, acceptance tests, and phased implementation plan for a mostly autonomous desktop video-production system.

The application is intended to operate as an internal **autopilot video factory**. It should independently select viable topics, research facts, generate scripts, match scenes to a 26,000+ row stock-footage catalog, create a download manifest, ingest manually downloaded Envato assets, verify the actual visuals, generate narration, edit and render the video, produce YouTube packaging, upload privately, and wait for final publication approval.

The only routine human actions are:

1. License/download the requested Envato assets.
2. Review the private YouTube upload and approve publication or scheduling.

Exceptions are surfaced only when the system cannot continue safely or accurately.

## Canonical documents

- `01-PRD.md` - Product requirements and UX behavior.
- `02-TECHNICAL-SPEC.md` - Architecture and implementation specification.
- `03-DATA-MODEL.sql` - SQLite core schema baseline.
- `04-STATE-MACHINE.md` - Project, job, approval, and exception states.
- `05-IPC-AND-PROVIDER-CONTRACTS.md` - Desktop IPC and external-provider interfaces.
- `06-ACCEPTANCE-TESTS.md` - End-to-end, functional, resilience, media, and security tests.
- `07-IMPLEMENTATION-PLAN.md` - Milestones, sequencing, gates, and definition of done.
- `08-CRITICAL-GAP-REMEDIATION-PRD.md` - Security, evidence-integrity, workflow, and publishing remediation requirements discovered after alpha.7.
- `schemas/scene-contract.schema.json` - Machine-readable narration/visual contract.
- `schemas/render-manifest.schema.json` - Machine-readable final timeline/render contract.
- `config/default-autopilot-policy.json` - Initial automated decision thresholds.
- `config/render-profiles.json` - Draft, 1080p, and qualified 4K render profiles.
- `references.md` - Official technical and policy references.

## Architecture decisions frozen for version 1

- Electron + React + TypeScript desktop app.
- SQLite + FTS5 local database; active database stays on a local disk.
- FFmpeg/ffprobe-first media pipeline.
- Local content-addressed media vault.
- Metadata-first planning; source videos are downloaded only after topic/storyboard selection.
- Exact-location matching is a hard gate, not a soft relevance score.
- Narration beats and visual shots are separate entities.
- Every visual shot is 2-7 seconds; no shot may exceed 7.0 seconds.
- 1080p H.264/AAC MP4 is the default final output.
- 4K is permitted only when every full-screen source remains true 4K after crop/reframe.
- No automatic AI upscaling or frame interpolation.
- Envato account download and licensing actions remain manual.
- Finished videos upload privately before final human approval.
- The renderer, AI providers, TTS provider, keyword provider, and search provider are replaceable adapters.

## Build order

The implementation must follow the vertical-slice order in `07-IMPLEMENTATION-PLAN.md`. Do not build a general-purpose timeline editor, SaaS infrastructure, multi-user permissions, or autonomous public publishing before the complete single-video workflow passes the acceptance suite.
