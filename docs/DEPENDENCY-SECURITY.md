# Dependency Security and Artifact Provenance

VideoFactory treats the lockfile as release input. Production and CI installs use `npm ci`; dependency changes must update and review both `package.json` and `package-lock.json`.

## Required release checks

1. From a clean exact release commit, run `npm run validate:release` against the release lockfile. Its canonical pipeline includes historical-index validation, the low-severity dependency audit, CycloneDX SBOM, tests, build, Electron E2E, and acceptance receipt; any failed stage blocks packaging. `npm run validate` is development-qualified and cannot authorize packaging.
2. Build the Windows installer and ZIP from the same exact commit and Node version recorded by validation.
3. On Windows, run `scripts/windows/test-packaged-app.ps1` against the exact installer and ZIP. It must expand/launch the archive, silently install/launch/uninstall NSIS, verify cleanup, and exercise the installed app's 26K worker, close-to-tray, suspend-blocker, and safe-quit lifecycle before writing `release/WINDOWS_PACKAGE_SMOKE.json`.
4. Run `npm run qualify:index-windows-runtime`, rerun acceptance against the exact-head Linux reports, attach the runtime/claims input manifests, final validation status and acceptance receipt, test reports, `release/videofactory-sbom.cdx.json`, and package-smoke receipt, then run `npm run release:manifest -- --require-validation --require-package-smoke` and `npm run release:verify`.
5. Re-run the affected provider, import, packaging, and security tests after dependency changes.

Critical and high findings block packaging. Moderate findings block promotion until assessed. Exceptions must identify the advisory, affected path, exploitability, compensating control, owner, and expiry; silent suppression is not allowed.

## Non-registry packages

SheetJS Community Edition is pinned to the official 0.20.3 tarball because the npm registry ends at the vulnerable 0.18.5 release. The lockfile records its resolved URL and integrity hash. Changing that URL or integrity is a security-sensitive review event.

## Evidence

Linux CI admits a clean exact HEAD/tree, records separate deterministic runtime and release-claims digests plus runner/toolchain provenance, and uploads generated evidence under `VideoFactory-Desktop-<workflow-sha>-validation-evidence`. Its full-history checkout proves each historical index against the recorded immutable Git tag, commits, trees, ancestry, and single content-changing index commit; the claim validator rejects contradictory tag/run/asset/signing/readiness statements in tracked release documents. Optional exact-source production-pilot, Electron-performance, and Windows-system receipts travel with that evidence only when their shared index references their exact bytes. The Windows job downloads only that exact name, checks the receipt commit/tree/qualification, preserves every indexed Linux attachment, launches the packaged ZIP and installed NSIS application with isolated data, records the real setup/tray/background/power lifecycle, and reruns acceptance after indexing those exact receipt bytes. Release generation re-admits every referenced external receipt, ships the checksummed `QUALIFY_WINDOWS_SYSTEM.ps1`, and then writes `RELEASE_PROVENANCE.json` plus `SHA256SUMS.txt`; production-pilot and Windows-system attachments must match the package version, and the system receipt must match the qualifier hash. Generation and verification reject changed, missing, duplicate, extra, renamed, or unreferenced artifacts; dirty, development, stale commit/tree/input evidence; and missing, failed, incomplete, or package-mismatched smoke evidence. Root validation receipts are intentionally untracked; published evidence remains in release assets and the tracked [historical index](release-evidence/v0.1.0-alpha.7.json). The hosted runner includes build tooling, so its package receipt can qualify `SYS-005` and `SYS-006` but not the non-CI system gates. These hashes detect integrity drift but are not an authenticity mechanism; Windows installers remain unsigned until the separate signing gate is completed.
