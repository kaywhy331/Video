# Production Recovery Qualification

This is the canonical non-CI field procedure for `E2E-004`. It deliberately terminates a packaged Windows process tree at six durable boundaries, restarts the same packaged executable and data root, and verifies recovery from the real schema-24 database and filesystem artifacts. No checked-in receipt qualifies this gate; `E2E-004` remains pending until all six real drills pass on one representative Windows x64 workstation.

## Safety and prerequisites

- Use a clean checkout whose exact `HEAD` and tree match the packaged release's `RELEASE_PROVENANCE.json`.
- Use the same packaged application executable, release provenance, representative Windows x64 machine, and non-sensitive device-class label for all six drills.
- Install Node 22/24 and Git for this operator harness. This is separate from the developer-tool-free clean-install system gate.
- Work outside CI. The harness rejects common CI environments.
- Use a representative, integrity-checked copy of production data rather than the only copy. The restore drill replaces the selected database and every drill force-kills the application process tree.
- Use private YouTube uploads and an account where real quota consumption is authorized. Provider drills can incur real charges. Preserve raw observations privately because they contain local work identifiers; the aggregate receipt hashes those identities.
- Keep each drill under four hours. Do not edit tracked files, change commits, rebuild the app, or switch machines between observations and aggregation.

The packaged application must own the database at `<DataRoot>\data\videofactory.sqlite`. The recorder rejects a database that does not match the data-root settings persisted inside it.

## Required drill set

| Kind | `WorkId` | Boundary and required completion |
|---|---|---|
| `provider` | A pending/running `workflow_finalize_script` or `workflow_generate_voice` job ID | At least one completed paid production-provider receipt exists before termination; restart completes one new job attempt without changing or charging a completed call again. |
| `ingest` | An acquisition-item ID | Termination follows the certificate-backed source's `original_preserved` / `FILE_STABLE` checkpoint; startup recovery creates verified derivatives, reaches `complete` / `COMPLETE`, and records the durable recovery audit. |
| `render` | A pending/running `render_draft` or `render_final` job ID | Termination occurs while `Assembling timeline` is `RUNNING`; restart produces a hash-matching, independently probed final with no unsafe partials. |
| `upload_session` | A pending/running `workflow_upload_private` job ID | A live Google resumable session exists but no video ID is durable; restart records `remote_session_reused`, keeps the same session, and completes one current private publication. |
| `upload_commit` | A different pending/running `workflow_upload_private` job ID | A live remote video ID is already durable; restart records `remote_effect_reused`, keeps the same session/video identities, and finishes thumbnail, timed captions, and processing without another publication. |
| `restore` | The selected backup's absolute `.sqlite` path | A validated staged restore exists before termination; restart applies it, preserves an intact safety database, rebuilds all project artifacts, verifies every original exists, records the restore audit, and acknowledges the completion marker. |

Use two independent real upload jobs for the two upload boundaries. Synthetic protocol fixtures, manual JSON, development processes, hosted CI, and copied database rows are supporting evidence only and cannot qualify this receipt.

## Select work and run each drill

List local candidate IDs without emitting qualification evidence:

```powershell
npm run qualify:production-recovery:candidates -- --database="D:\VideoFactory\data\videofactory.sqlite" --kind=provider
```

Repeat with `ingest`, `render`, `upload_session`, `upload_commit`, or `restore`. Queue the applicable real operation first when a job must exist; the harness polls a pending job until the required durable boundary appears. For restore, stage the selected backup through the application before starting the harness.

Run the packaged app against the representative data root and retain its main-process PID:

```powershell
$env:VIDEOFACTORY_DEV_DATA_ROOT = "D:\VideoFactory"
$appProcess = Start-Process `
  -FilePath "C:\Program Files\VideoFactory Desktop\VideoFactory Desktop.exe" `
  -PassThru
```

Then invoke:

```powershell
& .\scripts\windows\qualify-production-recovery.ps1 `
  -Kind provider `
  -DatabasePath "D:\VideoFactory\data\videofactory.sqlite" `
  -WorkId "<job-or-acquisition-id-or-backup-path>" `
  -InitialPid $appProcess.Id `
  -AppExecutable "C:\Program Files\VideoFactory Desktop\VideoFactory Desktop.exe" `
  -ReleaseProvenance "D:\release\RELEASE_PROVENANCE.json" `
  -DataRoot "D:\VideoFactory" `
  -DeviceClass "desktop-rtx4070-32gb"
```

The script polls rather than relying on an operator timestamp. Once the recorder proves the requested boundary, it runs Windows forced process-tree termination, observes exit, restarts the exact executable with the same data root, and polls until stage-specific recovery is proven. Its default output is the ignored file `validation/results/production-recovery-<kind>-observation.json`. The restarted application remains open; the script prints its PID for use as the next drill's `InitialPid`.

If a timeout or assertion fails, no observation is admitted. Fix the underlying operation, delete or retain the failed private diagnostic as appropriate, and rerun the entire affected drill; do not edit raw JSON.

## Aggregate and admit

After all six observations exist, aggregate them from the same unchanged clean checkout:

```powershell
npm run qualify:production-recovery -- `
  --observation="validation/results/production-recovery-provider-observation.json" `
  --observation="validation/results/production-recovery-ingest-observation.json" `
  --observation="validation/results/production-recovery-render-observation.json" `
  --observation="validation/results/production-recovery-upload_session-observation.json" `
  --observation="validation/results/production-recovery-upload_commit-observation.json" `
  --observation="validation/results/production-recovery-restore-observation.json"

npm run validate:release
```

The collector requires exactly six unique raw byte streams from one machine and one packaged application/provenance identity. It rechecks source, schema/integrity/foreign keys, forced termination order, distinct PIDs, one durable recovery attempt, provider cost receipts, license/source hashes, media probes, Google session/video identities, current publication state, restore safety bytes, rebuild results, and original-file availability. It emits ignored `validation/results/production-recovery.json`, hashes private device/PID/work identities, updates the shared exact-source external index, and may qualify only `E2E-004`.

Acceptance and release-manifest generation independently re-read and re-assess those exact receipt bytes. A missing receipt leaves `E2E-004` pending. A malformed, edited, moved, stale-source, dirty-source, wrong-version, wrong-machine, non-Windows, CI, development, incomplete, duplicated, or unreferenced receipt fails closed.
