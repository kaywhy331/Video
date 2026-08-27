# Windows system qualification

This field procedure supplies the external evidence for `SYS-001`, `SYS-003`, and `SYS-004`. It does not weaken release validation: every observation is bound to a released app version, clean exact source commit/tree, complete release checksum inventory, and the SHA-256 of the released qualifier.

## Target machines

Use three representative, non-CI Windows 10/11 x64 machines: one NVIDIA NVENC device, one Intel Quick Sync device, and one AMD AMF device. The target machines must not expose developer-tool commands such as Git, Node.js, npm, Python, or MSBuild. Download or copy the complete unsigned release artifact directory, including `SHA256SUMS.txt`, `RELEASE_PROVENANCE.json`, the NSIS installer, and `QUALIFY_WINDOWS_SYSTEM.ps1`.

At least one target must also expose four real storage conditions:

- a directory whose current user cannot write;
- an absolute path that does not exist;
- an unreachable UNC share such as `\\offline-host\offline-share`;
- a writable volume with less than 25 GiB free.

Create a storage input such as:

```json
{
  "schemaVersion": 1,
  "cases": [
    { "kind": "read_only", "path": "R:\\read-only" },
    { "kind": "missing", "path": "C:\\definitely-missing\\videofactory" },
    { "kind": "offline_nas", "path": "\\\\offline-host\\offline-share" },
    { "kind": "insufficient_space", "path": "L:\\low-space" }
  ]
}
```

## Capture observations

From ordinary Windows PowerShell, run the released script on each device. Use a unique, non-sensitive device-class label; it is hashed by the collector and is not retained verbatim.

```powershell
.\QUALIFY_WINDOWS_SYSTEM.ps1 `
  -ReleaseDirectory .\VideoFactory-release `
  -HardwareClass nvidia `
  -DeviceClass "Windows11-NVIDIA-class-A" `
  -StorageMatrixPath .\storage-matrix.json `
  -OutputPath .\SYSTEM_NVIDIA.json
```

Repeat with `-HardwareClass intel` and `-HardwareClass amd`. The script verifies every released checksum, silently installs into an isolated directory, launches only the packaged executable, records persisted diagnostics and setup state, probes the optional storage matrix, verifies SQLite did not change during those failure probes, silently uninstalls, and removes its temporary data. A failed condition produces no passing observation.

## Aggregate and admit

Copy the three raw observations to a development workstation. Check out the exact released commit with a clean index and worktree, install its locked dependencies, and run:

```bash
npm run qualify:windows-system -- \
  --observation=/evidence/SYSTEM_NVIDIA.json \
  --observation=/evidence/SYSTEM_INTEL.json \
  --observation=/evidence/SYSTEM_AMD.json
```

The collector writes ignored `validation/results/windows-system.json` and updates ignored `validation/external-qualification/index.json`. It rejects wrong versions, mismatched commit/tree identities, changed qualifier bytes, duplicate observations/devices, missing hardware classes, synthetic storage assertions, database drift, developer/CI targets, or any non-canonical schema. Run `npm run validate:release` on that same clean exact source to re-admit the indexed receipt. Release provenance copies the receipt as `EXTERNAL_WINDOWS_SYSTEM.json` and independently checks its version and qualifier hash.

Raw observations can contain operating-system and artifact metadata. Retain them with the release audit record; publish only the aggregate receipt, which hashes the bounded device label and does not retain filesystem paths.
