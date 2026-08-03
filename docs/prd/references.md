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
