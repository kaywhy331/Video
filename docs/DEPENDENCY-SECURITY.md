# Dependency Security and Artifact Provenance

VideoFactory treats the lockfile as release input. Production and CI installs use `npm ci`; dependency changes must update and review both `package.json` and `package-lock.json`.

## Required release checks

1. Run `npm run security:audit`. Any npm advisory at low severity or above fails the release gate until it is upgraded, removed, or documented with a time-bounded exception approved by the owner.
2. Run `npm run validate` against the same lockfile.
3. Run `npm run security:sbom`. Preserve `release/videofactory-sbom.cdx.json` with the build and the acceptance receipt.
4. Re-run the affected provider, import, packaging, and security tests after dependency changes.

Critical and high findings block packaging. Moderate findings block promotion until assessed. Exceptions must identify the advisory, affected path, exploitability, compensating control, owner, and expiry; silent suppression is not allowed.

## Non-registry packages

SheetJS Community Edition is pinned to the official 0.20.3 tarball because the npm registry ends at the vulnerable 0.18.5 release. The lockfile records its resolved URL and integrity hash. Changing that URL or integrity is a security-sensitive review event.

## Evidence

Linux CI runs the audit after the full validation suite, generates a CycloneDX 1.5 SBOM, and uploads the SBOM together with `VALIDATION_ACCEPTANCE_RECEIPT.json`. Windows installers remain unsigned until the separate signing gate is completed.
