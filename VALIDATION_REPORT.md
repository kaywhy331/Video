# VideoFactory Desktop alpha.3 — Validation Report

Generated: 2026-08-12T13:04:46-07:00 (America/Los_Angeles)

## Outcome

The imported alpha.2 vertical slice has been hardened into 0.1.0-alpha.3, with automated repair routing and semantic footage verification implemented. Full local source validation passes, including real FFmpeg media operations. GitHub Actions evidence for this branch remains pending publication. The release remains an alpha and is not production-qualified because Windows clean-machine, live provider, and five-video pilot gates are external and unrun.

## Local validation

| Check | Result |
|---|---|
| `npm run doctor` | Passed |
| TypeScript typecheck | Passed |
| Focused semantic/repair/contracts suite | Passed; recovery/provider/repair coverage included in full suite |
| Full Vitest suite | Passed; 28 files / 87 tests |
| Real FFmpeg analysis fixture | Passed |
| Real concat/two-pass normalization fixture | Passed |
| Application migration wrapper (001 + 002 + 003 + 004) | Passed in focused validation; versions recorded, reopen idempotent, integrity `ok` |
| Source/resource migration parity | Passed |
| Electron/Vite main, preload, renderer build | Passed |
| `git diff --check` | Passed |

## GitHub Actions validation

The last merged `main` run [31627007086](https://github.com/kaywhy331/Video/actions/runs/31627007086) passed before this semantic milestone. Branch CI evidence is pending publication.

| Job | Result |
|---|---|
| Prior `main` Linux `validate` | Passed |
| Prior `main` Windows `package-windows` | Passed |
| This semantic branch | Pending |

This proves the Windows packages can be produced by the hosted runner. It does not replace a clean-machine installation and runtime test.

## Validated changes

- canonical audited project state transitions and fail-closed exception recovery;
- nested SQLite transactions and atomic forward migration records;
- durable job dependencies, cycles, leases, project locks, bounded retry, and stale-process recovery;
- scheduled checksummed backups, configurable rotation, staged restore, safety copy, and missing-original scan;
- strict IPC schemas, sender/origin validation, managed-path containment, URL allowlists, and secret redaction;
- actual FFmpeg black/freeze analysis, rotation-aware resolution policy, corrupt/duplicate quarantine, and declared/actual conflict evidence;
- narration splitting without audio truncation, SRT/WebVTT output, concat-before-analysis, two-pass EBU R128 normalization, and output profile/fast-start QC;
- rights fail-closed checks, package/final-render fingerprints, and strict final approval receipts;
- persisted resumable YouTube sessions, byte-offset recovery, duplicate final-hash guard, private-first metadata, processing polling, captions, thumbnails, playlist attachment, and configurable synthetic-media disclosure;
- queue/spend/duplicate/coverage planning gates and catalog-backed sources/claims;
- deterministic per-scene shot-candidate ranks and bounded residual-risk alternate acquisition;
- automatic failed-footage routing that revalidates geography, on-disk source, no-upscale/black/freeze limits, and project license before promotion;
- classified final-QC repair policy, monotonic artifact versions, two-attempt output retry, smallest-safe state routing, exhaustion stop, audit log, and operator-visible repair history;
- canonical geographic hierarchies with parent-aware disambiguation and human-over-vision evidence precedence;
- scene-specific contact-sheet-only semantic provider requests with strict schema validation, one corrective retry, caching, persisted provider/error receipts, and fail-closed policy;
- semantic receipt-gated media attachment and alternate promotion, explicit operator retry, blocker lifecycle handling, and startup re-verification for legacy waiting alternates.

## Historical alpha.2 validation

Alpha.2 repaired the original incomplete package by restoring dependency declarations, startup logging, Electron/Vite output, and Electron-bundled SQLite. The 2026-08-04 validation passed 12 tests and the production bundle. That evidence remains historical and is superseded by alpha.3 validation.

## External gates not run

| Gate | Status |
|---|---|
| Clean Windows 10/11 install and runtime | Unverified |
| Windows installer launch/upgrade/uninstall | Unverified; CI packaging is not runtime validation |
| Five representative real-video pilot | Unverified |
| Live Envato licensing/download workflow | Unverified |
| Live Google OAuth/YouTube private upload and publish rehearsal | Unverified |
| Live semantic vision provider against representative licensed footage | Unverified; mocked protocol/policy coverage is not provider qualification |
| Forced restart during real ingest/render/upload | Unverified |
| Representative production-data restore drill | Unverified |

These are not waived or counted as passes. `production_ready` remains `false`.
