# VideoFactory Desktop alpha.2 - Validation Report

Generated: 2026-07-31T04:25:20.947386+00:00

## Root cause addressed

The original alpha.1 package omitted the npm runtime and development dependency declarations. Its launcher therefore reached `npm run dev` without Electron/Vite installed and closed without preserving the error.

Alpha.2 adds the dependency declarations, durable startup logging, an always-visible launcher result, preflight checks, corrected Electron/Vite module output, and Electron-bundled SQLite access that avoids a native SQLite npm add-on.

## Checks completed in this environment

| Check | Result |
|---|---|
| Source/package preflight | Passed |
| TypeScript/TSX syntax transpilation | Passed for 44 source/test files |
| Core normalization/geography/media-policy smoke tests | Passed |
| SQLite schema + FTS5 trigger + integrity smoke test | Passed |
| Imported-package declaration audit | Passed for 12 external packages |
| Original alpha.1 failure evidence retained | Yes, under `validation-logs/alpha1-failure-evidence/` |

## Checks that still require a networked Windows machine

This container cannot reach the npm registry, so it could not install the declared dependencies. The following checks are intentionally **not represented as passed**:

- `npm install`
- full `npm run typecheck`
- Vitest execution
- Electron/Vite production bundle
- Windows runtime launch
- portable/installer packaging

`RUN-ON-WINDOWS.cmd` now performs those installation and startup steps on the target machine, keeps the console open on every exit, and writes `VideoFactory-Last-Startup.log` beside the launcher.
