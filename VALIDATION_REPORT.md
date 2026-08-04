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

## Follow-up verification — 2026-08-04

The complete imported source was installed and revalidated in a networked Linux environment:

- `npm ci` / dependency installation: passed
- full TypeScript typecheck: passed
- Vitest: 12/12 tests passed
- Electron/Vite main, preload, and renderer production bundles: passed

The repository owner explicitly waived the Windows 10/11 runtime smoke as a blocking gate on 2026-08-04. This is a temporary acceptance decision, **not** a passed Windows test. Windows runtime launch and portable/installer packaging remain unverified and should be completed before treating this alpha as target-platform qualified.

`RUN-ON-WINDOWS.cmd` performs installation and startup on the target machine, keeps the console open on every exit, and writes `VideoFactory-Last-Startup.log` beside the launcher.
