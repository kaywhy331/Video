# Production Hardening Backlog

The source code is organized so the vertical slice can be hardened without replacing its architecture.

## P0 before unattended channel operation

- Add actual-video visual verification using representative frames and a configurable vision provider.
- Add script factual research with cited fact claims and freshness rules.
- Add automatic alternate-asset selection when downloaded media fails verification.
- Split narration longer than seven seconds into multiple visual shots instead of blocking.
- Add music selection, ducking policy, and ambient-audio policy.
- Add two-pass EBU R128 loudness analysis rather than a single-pass normalization filter.
- Add render cache reuse at scene granularity.
- Add resumable YouTube upload session persistence.
- Add backup scheduler, retention policy, restore UI, and integrity drill.
- Add automated disk-pressure cleanup for regenerable proxies and work files.
- Add release signing, installer update channel, and crash reporting.
- Validate the packaged Windows build against ProRes, H.264, H.265, alpha, variable-frame-rate, and unusual color-space fixtures.

## P1

- Qualified 4K final render profile
- Configurable external TTS provider with word timing
- Google Ads demand-proxy adapter
- YouTube competition scoring and channel-specific opportunity model
- Scene-level retention analytics mapped to render manifests
- Automated title/thumbnail experiment tracking
- Map and route graphic generator
- Destination batch planning
- Automatic expiry/freshness checks for factual claims
- Operator-friendly metadata conflict merge screen

## P2

- Shorts/vertical format
- Multiple YouTube channels
- Multiple languages
- Additional stock providers
- Advanced motion graphics
- Local embedding model
- Custom landmark recognizer
