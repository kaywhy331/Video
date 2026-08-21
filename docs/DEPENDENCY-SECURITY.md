# Dependency Security and Artifact Provenance

VideoFactory treats the lockfile as release input. Production and CI installs use `npm ci`; dependency changes must update and review both `package.json` and `package-lock.json`.

## Required release checks

1. Run `npm run validate` against the release lockfile. Its canonical pipeline includes the low-severity dependency audit, CycloneDX SBOM, tests, build, Electron E2E, and acceptance receipt; any failed stage blocks packaging.
2. Build the Windows installer and ZIP from the same exact commit and Node version recorded by validation.
3. Attach the validation status, acceptance receipt, test reports, and `release/videofactory-sbom.cdx.json`, then run `npm run release:manifest -- --require-validation` and `npm run release:verify`.
4. Re-run the affected provider, import, packaging, and security tests after dependency changes.

Critical and high findings block packaging. Moderate findings block promotion until assessed. Exceptions must identify the advisory, affected path, exploitability, compensating control, owner, and expiry; silent suppression is not allowed.

## Non-registry packages

SheetJS Community Edition is pinned to the official 0.20.3 tarball because the npm registry ends at the vulnerable 0.18.5 release. The lockfile records its resolved URL and integrity hash. Changing that URL or integrity is a security-sensitive review event.

## Evidence

Linux CI records the exact source and runner/toolchain, runs the audit and CycloneDX 1.5 SBOM stages inside the full validation pipeline, and uploads the complete validation evidence. The Windows job depends on that exact-head result, attaches the evidence to the installer/ZIP bundle, and generates `RELEASE_PROVENANCE.json` plus `SHA256SUMS.txt`. Verification rejects changed, missing, duplicate, or extra artifacts and stale version evidence. These hashes detect integrity drift but are not an authenticity mechanism; Windows installers remain unsigned until the separate signing gate is completed.
