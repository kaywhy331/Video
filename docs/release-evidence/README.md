# Historical release evidence

Files in this directory are tracked, machine-readable indexes of already published releases. Each index names the immutable tag, release commit, workflow runs, transient Actions artifacts, and durable release assets it describes.

These indexes are historical receipts. They do not validate the current checkout, and a later documentation commit does not move or rebuild the release tag. For current evidence, run `npm run validate:release` from a clean exact commit or download the `VideoFactory-Desktop-<workflow-sha>-validation-evidence` artifact from that commit's GitHub Actions run. Generated `VALIDATION_STATUS.json`, `VALIDATION_ACCEPTANCE_RECEIPT.json`, `validation/results/*.json`, and `validation/external-qualification/*.json` files are intentionally ignored by Git. The generated external index is a current exact-source evidence attachment, not a substitute for this directory's tracked historical release indexes.

Release indexes are claims-digest inputs. They must not contain a runtime or claims digest that would make the hashing graph circular.
