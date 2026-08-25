# Critical Gap Remediation PRD and Delivery Plan

## 1. Document control

| Field | Value |
|---|---|
| Product | VideoFactory Desktop |
| Document status | Proposed remediation baseline; implementation not started |
| Baseline reviewed | `fb291abd401ec1e06bbc6494cc60d145d28ac024` |
| Audit date | 2026-08-25 |
| Target | Next security/integrity prerelease after alpha.7 |
| Qualification effect | `production_ready` remains `false` until this plan and the existing external gates pass |
| Source | Adversarial repository audit covering validation, OAuth, providers, jobs, publishing, and settings import |

All completion boxes in this document are intentionally unchecked. An item may be checked only after its implementation is merged and its named evidence is attached to an exact clean commit.

---

## 2. Executive summary

The alpha.7 application has broad automated coverage and a published unsigned prerelease, but a follow-up adversarial audit found seven locally actionable gaps:

1. Checked-in validation receipts describe a different dirty commit and can be mistaken for evidence about the current checkout.
2. YouTube OAuth does not bind the browser callback with `state` or PKCE and persists tokens before the operator confirms the channel.
3. Provider base URLs can redirect credentials and production data to an arbitrary origin without a centralized endpoint trust policy.
4. Manual job retry can requeue any state and clear leases without a compare-and-set transition.
5. YouTube upload and approval select a succeeded final render by list order instead of using the project's authoritative `finalRenderId`.
6. The validation input digest excludes documents that make release and qualification claims.
7. A portable settings profile can import FFmpeg and FFprobe executable paths that later run with the application environment.

This PRD makes all seven gaps release-blocking for the remediation milestone. It does not change the existing external qualification gates, relax the private-first publication rule, or claim production readiness.

### 2.1 Severity and disposition

| Gap | Audit classification | Required disposition |
|---|---|---|
| RG-VAL | High confirmed evidence-integrity defect | Fix before the remediation release |
| RG-OAUTH | High confirmed account-binding defect | Fix before any further live YouTube rehearsal |
| RG-NET | High design risk | Define and enforce a provider trust boundary before the remediation release |
| RG-JOB | Medium confirmed workflow defect | Fix before unattended workflow rehearsal |
| RG-FINAL | Medium confirmed publishing defect | Fix before any further live upload rehearsal |
| RG-CLAIMS | Medium evidence-design risk | Bind claims before the remediation release |
| RG-TOOLS | Medium executable-trust risk | Fix before settings profiles are treated as portable/safe |

---

## 3. Goals and success outcomes

### 3.1 Goals

- Make every release-grade validation receipt prove one exact clean source commit and prevent historical evidence from appearing current.
- Bind YouTube authorization to the initiating app session and require an explicit, visible channel confirmation before tokens become active.
- Preserve managed, custom, and local provider flexibility without silently reusing credentials across untrusted origins.
- Make manual retry a durable, audited state-machine transition that cannot disturb active or completed work.
- Use one immutable active-final identity from review through upload, processing, and publication approval.
- Bind human-readable release claims to machine-readable evidence without creating self-referential hashes.
- Prevent portable configuration from silently introducing an executable that the operator has not locally trusted.
- Add exact automated acceptance bindings for every locally testable requirement in this PRD.

### 3.2 Measurable outcomes

- Zero release manifests accept `source.dirty: true`, a stale source SHA, or evidence from a different commit.
- Zero OAuth callbacks succeed with a missing, mismatched, expired, or reused `state`; every code exchange uses PKCE S256.
- Zero stored provider secrets are sent after the configured canonical origin changes until that origin is explicitly trusted and the credential is rebound.
- Zero invalid manual retry requests change the job row, project lock, resource lease, or attempt history.
- Zero upload, resume, or approval operations use a render other than the snapshotted `project.finalRenderId` and its SHA-256.
- Every document that asserts release or qualification status is either included in a claims digest or generated/validated from a machine-readable receipt.
- Zero imported profile keys can modify executable trust or cause a new executable to run.

### 3.3 Non-goals

- Removing support for OpenAI-compatible, generic HTTP TTS, or intentionally local providers.
- Replacing Google OAuth, the YouTube Data API, FFmpeg, or FFprobe.
- Turning the desktop app into a multi-user permission system.
- Retrofitting cryptographic signatures onto old local development receipts.
- Declaring the application production-ready or waiving any existing Windows, live-provider, licensed-media, interruption, performance, or pilot gate.
- Automatically publishing a video without the existing final human approval.

---

## 4. Cross-cutting product and engineering rules

1. **Fail closed at a privileged boundary.** Renderer visibility controls are not authorization. Validation must occur in the Electron main process or lower-level service that owns the effect.
2. **One canonical identity per effect.** Origins, jobs, renders, publications, receipts, and executable binaries must be identified by immutable IDs and hashes rather than list order or display text.
3. **No silent trust transfer.** Imported settings, changed endpoints, changed binaries, and changed final renders must invalidate prior approval rather than inherit it.
4. **Transactional transitions.** State changes that release locks, grant another attempt, bind a final render, or persist tokens must be atomic and check their expected prior state.
5. **Historical evidence must look historical.** A tracked index may point to an earlier release, but a generated receipt must not imply it validates the current checkout unless it does.
6. **Secrets stay origin-bound and redacted.** Logs, audit events, errors, test fixtures, and receipts must not contain OAuth codes, verifiers, access/refresh tokens, API keys, URL credentials, or full sensitive payloads.
7. **New requirements join canonical traceability.** Implementation is incomplete until the new acceptance IDs are added to `06-ACCEPTANCE-TESTS.md`, mapped once, and bound to exact assertions in `validation/acceptance-bindings.json`.
8. **Source and packaged migrations remain identical.** Any new database migration must have byte-identical source and `resources` copies and pass contiguous migration preflight.
9. **Compatibility must fail safely.** Existing tokens, publication rows, provider settings, and tool overrides may be preserved for inspection, but they cannot perform a privileged effect until upgraded or reconfirmed.

### Cross-cutting completion criteria

- [ ] Every new privileged IPC route has schema validation, sender validation, typed errors, and a negative test.
- [ ] Every new database migration exists identically under `src/main/database` and `resources`.
- [ ] Every new log and audit event passes secret-redaction tests.
- [ ] Every new acceptance ID is mapped exactly once and bound to an exact passing assertion or an explicit external reason.
- [ ] `npm run typecheck`, `npm run test`, `npm run build`, Electron E2E, audit, SBOM, and `npm run validate:acceptance` pass from a clean checkout.
- [ ] No completion claim relies only on a renderer control being disabled or hidden.

---

## 5. RG-VAL — Exact, clean, non-stale validation evidence

### 5.1 Problem

`VALIDATION_STATUS.json` and `VALIDATION_ACCEPTANCE_RECEIPT.json` in the baseline checkout identify commit `551bb37377dae21387af68347198e195989f7c8e` with `dirty: true`, while the reviewed `main` commit is `fb291abd401ec1e06bbc6494cc60d145d28ac024`. `scripts/run-validation.mjs` records dirty state but does not reject it, and record mode in `scripts/validate-acceptance.mjs` requires only a syntactically valid 40-character commit.

The hosted release workflow already transfers exact-SHA evidence between jobs and checks several commit relationships. The gap is the definition and presentation of local/tracked evidence, plus the absence of a universal clean-source release gate.

### 5.2 Product decision

Generated validation output is ephemeral evidence, not source documentation. Root-level generated receipts may exist in a working directory or CI artifact, but they must no longer be tracked or described as validating the current checkout. Permanent release evidence belongs in immutable release assets plus a small tracked historical index that explicitly names the release commit and URLs.

Validation has two modes:

- `development`: may run from a dirty tree, but every output is labeled non-release and cannot satisfy release provenance.
- `release`: requires a clean tree at admission, captures the exact HEAD and tree hash, and fails if HEAD or validation inputs change before completion.

### 5.3 Functional requirements

| ID | Requirement |
|---|---|
| VAL-001 | Capture `HEAD`, branch/ref, repository, tree hash, and dirty state before deleting or generating any validation output. |
| VAL-002 | Release mode must exit nonzero before running stages when the source worktree is dirty or HEAD is not a full 40-character commit. |
| VAL-003 | After all stages, release mode must re-read HEAD and the source tree hash and fail if either differs from the admitted values. |
| VAL-004 | `validate-acceptance --record-validated` must require the pipeline source commit to equal admitted HEAD and must preserve the pipeline's clean/dirty qualification. |
| VAL-005 | `generate-release-manifest` and verification mode must reject missing validation, `dirty: true`, source mismatch, tree mismatch, input mismatch, or a non-release validation mode. |
| VAL-006 | `VALIDATION_STATUS.json`, `VALIDATION_ACCEPTANCE_RECEIPT.json`, and `validation/results/*` must be untracked generated outputs; CI and release jobs must continue to upload them. |
| VAL-007 | Add a tracked, versioned release-evidence index containing release tag, release commit, workflow run IDs/URLs, artifact names, digests, and publication time. It must identify itself as historical release evidence, not current-checkout validation. |
| VAL-008 | Development-mode receipts must include `qualification: "development"`; release-mode receipts must include `qualification: "release"`. |
| VAL-009 | Receipt JSON schemas or equivalent validators must reject absent or unknown qualification, source, tree, and digest fields. |
| VAL-010 | CI artifact names must retain the exact source SHA, and Windows packaging must download only evidence for `${{ github.sha }}`. |

### 5.4 Implementation plan

1. Add a validation-admission helper that captures Git state once before generated files are touched.
2. Add explicit CLI modes, such as `npm run validate` for development and `npm run validate:release` for clean release evidence; GitHub Actions uses release mode.
3. Include admitted Git identity in pipeline, status, acceptance, package-smoke, and release-provenance documents.
4. Revalidate HEAD, tree, and the input digest after stages complete.
5. Remove tracked generated outputs from version control and add narrowly scoped ignore entries. Do not ignore immutable release-evidence indexes.
6. Add a migration note for consumers that previously read root receipts: use the current CI artifact or release asset instead.
7. Add fixture receipts for clean/current, dirty, stale-commit, changed-tree, and development-mode cases.

### 5.5 Verification and acceptance

Proposed canonical acceptance IDs:

- `REL-001` — release validation requires an exact clean source identity.
- `REL-002` — stale, dirty, or cross-commit evidence is rejected.
- `REL-003` — generated receipts are delivered as exact-SHA artifacts and not represented as current tracked state.

Required tests:

- Unit tests for admission parsing and receipt validation.
- Integration tests using temporary Git repositories for clean, dirty, detached-HEAD, HEAD-change, and input-change cases.
- Release-manifest negative fixtures for dirty, stale, tampered, and development receipts.
- CI assertion that uploaded validation artifact metadata equals the workflow SHA.

### 5.6 Completion criteria

- [x] Release validation refuses a dirty checkout before any evidence is recorded as passing.
- [x] Changing HEAD or a validation input during a run causes a deterministic failure.
- [x] Acceptance recording rejects a pipeline from another commit or qualification mode.
- [x] Release manifest generation and verification reject dirty, stale, or development evidence.
- [x] Generated root receipts and result files are no longer tracked as current source evidence.
- [x] A tracked historical evidence index points to the alpha.7 release without implying it validates later commits.
- [ ] Exact-SHA CI artifact transfer still passes on Linux-to-Windows packaging.
- [x] `REL-001` through `REL-003` have exact automated bindings and negative fixtures.
- [x] Documentation tells operators where to obtain current checkout, CI, and immutable release evidence.

Local implementation and canonical development-qualified validation completed on 2026-08-25. The remaining checkbox requires the first hosted CI run of the committed change; the workflow and regression assertion preserve the exact `${{ github.sha }}` artifact name and Windows download.

---

## 6. RG-OAUTH — YouTube OAuth session and channel binding

### 6.1 Problem

`YouTubeService.authorize()` accepts any authorization code arriving at the loopback callback path. The generated authorization URL has neither `state` nor a PKCE challenge, and returned tokens are saved before the operator confirms the resulting channel identity.

For a private-first publishing product, successful authentication is not enough: the app must prove that the callback belongs to the initiating authorization session and that the operator intended to bind the displayed channel.

### 6.2 Product decision

YouTube connection becomes a two-step flow:

```text
begin authorization
-> state-bound PKCE callback
-> exchange into an in-memory pending credential
-> fetch and display exact channel title + channel ID
-> operator confirms
-> persist tokens and channel binding
```

No access or refresh token becomes active before confirmation. An existing confirmed connection remains usable, but the first run after this change must display and confirm its channel before any new upload or publication action.

### 6.3 Functional requirements

| ID | Requirement |
|---|---|
| OAUTH-001 | Generate at least 256 bits of cryptographically random `state` per authorization attempt. |
| OAUTH-002 | Generate a PKCE verifier and S256 challenge that meet RFC 7636 length and character requirements. |
| OAUTH-003 | Store pending state, verifier, redirect URI, creation time, and one-time-use status only in main-process memory with a maximum five-minute TTL. |
| OAUTH-004 | Accept only `GET /oauth2callback` on the loopback listener; construct the callback URL from the known listener address rather than an untrusted Host header. |
| OAUTH-005 | Reject missing, mismatched, expired, or already-consumed state before exchanging a code. Comparison must not leak useful timing information. |
| OAUTH-006 | Send the PKCE verifier with the token request and mark the pending state consumed before or atomically with exchange. |
| OAUTH-007 | Hold exchanged tokens in an in-memory pending connection, call `channels.list(mine=true)`, and return exact channel ID/title for confirmation. |
| OAUTH-008 | Persist tokens and the confirmed channel ID only after an explicit confirmation IPC carrying the pending authorization ID and expected channel ID. |
| OAUTH-009 | Cancel, timeout, app shutdown, channel mismatch, or confirmation rejection must discard pending tokens and close the listener; revoke the candidate token where supported. |
| OAUTH-010 | Switching from an existing channel must show both old and new channel identities and require a separate replacement confirmation. |
| OAUTH-011 | OAuth codes, state, verifier, tokens, and callback query strings must never enter logs, audit rows, errors, or renderer state. |
| OAUTH-012 | Upload and approval must require a confirmed channel binding that matches the publication record's channel ID. |

### 6.4 IPC and UX requirements

- Replace the single implicit authorization result with typed `begin`, `confirm`, and `cancel` operations.
- The renderer receives only a short-lived pending authorization ID plus channel title/ID; it never receives tokens, code, state, or verifier.
- The confirmation view must state that all future private uploads and publication approvals target the displayed channel.
- A timeout or mismatch must show a recoverable error and leave the previous confirmed connection unchanged.
- The connection status must distinguish `not_configured`, `authorization_required`, `confirmation_required`, and `confirmed`.

### 6.5 Verification and acceptance

Proposed canonical acceptance IDs:

- `YT-009` — OAuth callback state and PKCE enforcement.
- `YT-010` — explicit YouTube channel confirmation and replacement.
- `SEC-009` — OAuth secret and callback-data redaction.

Required tests:

- Missing, wrong, expired, and replayed-state callbacks.
- Verification that `code_challenge_method=S256` is present and the correct verifier reaches token exchange.
- Callback to the wrong path or method.
- Timeout and listener cleanup.
- Token exchange success followed by confirmation, rejection, channel mismatch, and app shutdown.
- Existing-channel replacement warning and no-change-on-cancel behavior.
- Log/audit snapshots containing no sensitive OAuth values.

### 6.6 Completion criteria

- [ ] Every authorization URL contains unique `state`, `code_challenge`, and `code_challenge_method=S256` values.
- [ ] Missing, mismatched, expired, and replayed callbacks fail before token exchange.
- [ ] The callback listener closes on success, error, timeout, cancellation, and shutdown.
- [ ] Tokens remain memory-only until the operator confirms the exact channel ID.
- [ ] Cancelling or rejecting a new connection preserves the prior confirmed connection.
- [ ] Upload and approval reject an unconfirmed or mismatched channel binding.
- [ ] OAuth secrets and callback query data are absent from logs, audit history, renderer payloads, and receipts.
- [ ] `YT-009`, `YT-010`, and `SEC-009` have exact automated bindings.
- [ ] A live OAuth rehearsal is repeated after the automated suite passes and remains an external production-qualification receipt.

---

## 7. RG-NET — Provider endpoint and credential trust policy

### 7.1 Problem

TTS, LLM, vision, and research base URLs currently accept any syntactically valid URL. Provider services then send bearer credentials and potentially sensitive prompts, research inputs, scripts, contact sheets, or audio requests to those origins. A settings import, renderer compromise, or operator mistake can silently redirect an existing credential to an unintended host.

Custom adapters and local models are legitimate product requirements, so a hardcoded vendor-only allowlist is not sufficient.

### 7.2 Product decision

Introduce one main-process `ProviderEndpointPolicy` used at settings validation and immediately before every network request. Each provider configuration has an explicit trust mode:

- `managed`: origin is fixed by the adapter and remote HTTPS is mandatory.
- `custom_remote`: operator confirms one canonical HTTPS origin and binds a credential to it.
- `custom_local`: operator explicitly enables a loopback HTTP/HTTPS origin; no reusable remote API secret may be attached.

Private-network endpoints other than loopback are denied in production builds. Any future lab/developer override must be local-only, visibly unsafe, non-exportable, disabled by default, and unable to reuse production credentials.

### 7.3 Functional requirements

| ID | Requirement |
|---|---|
| NET-001 | Parse every provider endpoint centrally and allow only `https:` for remote modes; allow `http:` only for explicitly trusted loopback local mode. |
| NET-002 | Reject URL user information, fragments, unsupported protocols, malformed ports, and ambiguous/canonicalization failures. |
| NET-003 | Reject loopback, private, link-local, multicast, unspecified, and cloud-metadata destinations in remote modes for both IPv4 and IPv6. |
| NET-004 | Resolve each hostname once per hop, validate every returned address, and ensure the connection uses that validated resolution; revalidate every redirect target and cap redirects. |
| NET-005 | Bind each stored secret to provider identity plus canonical origin. Changing origin invalidates that binding and makes the provider unconfigured until explicit re-entry/rebinding. |
| NET-006 | A profile import may propose endpoint changes but must not silently apply a change that would reuse an existing credential; it must report a pending confirmation. |
| NET-007 | All provider calls must use the policy-produced URL rather than rebuilding strings from raw settings. |
| NET-008 | Set bounded connect/overall timeouts, response-size limits, and abort handling for every provider call. |
| NET-009 | The settings UI must display canonical origin, trust mode, credential-binding status, and the categories of data sent by that adapter. |
| NET-010 | Audit endpoint trust, rejection, and rebinding using provider and canonical origin only; never record credentials or sensitive request bodies. |
| NET-011 | Redirects may not downgrade HTTPS, cross to an untrusted origin, or cross trust modes. |
| NET-012 | Provider health must distinguish invalid endpoint, untrusted endpoint, credential-origin mismatch, timeout, and provider/API failure. |

### 7.4 Compatibility behavior

- Existing managed/default endpoints are normalized automatically when they match the adapter's expected origin.
- Existing custom HTTPS endpoints enter `confirmation_required` once; their stored secrets remain inaccessible to calls until confirmed.
- Existing loopback HTTP endpoints may be converted to `custom_local`, but any stored API key is disabled until removed or the endpoint is migrated to an approved HTTPS remote origin.
- Existing non-loopback private-network or plain-HTTP endpoints are preserved for display but blocked from calls.
- Changing a base URL must never delete the old secret silently; it invalidates the binding and explains the recovery action.

### 7.5 Verification and acceptance

Proposed canonical acceptance IDs:

- `SEC-010` — provider endpoint trust and SSRF boundary.
- `SEC-011` — provider credential-to-origin binding.
- `JOB-010` — bounded provider request timeout and cancellation.

Required tests:

- HTTP remote, URL credentials, fragments, alternate numeric IP forms, IPv4/IPv6 loopback, RFC1918, link-local, unspecified, multicast, and metadata endpoints.
- DNS answers containing any disallowed address and DNS/redirect rebinding simulations.
- Cross-origin, private-origin, and HTTPS-to-HTTP redirects.
- Origin changes with an existing secret, including profile-imported changes.
- Explicit loopback local mode with no secret and rejection when a secret is attached.
- Timeout, abort, oversized response, and stable typed-error behavior for all four provider services.

### 7.6 Completion criteria

- [ ] TTS, LLM, vision, and research all consume URLs produced by one centralized endpoint policy.
- [ ] Remote calls cannot target HTTP, URL-credential, loopback, private, link-local, or metadata endpoints.
- [ ] Every redirect target is revalidated and cannot downgrade or change to an untrusted origin.
- [ ] Changing or importing an endpoint cannot reuse a previously stored credential silently.
- [ ] Explicit local-provider mode works on loopback without a reusable remote credential.
- [ ] Provider requests have tested timeouts, aborts, redirect caps, and response-size limits.
- [ ] UI and health diagnostics expose trust/binding state without exposing secrets.
- [ ] `SEC-010`, `SEC-011`, and `JOB-010` have exact negative and positive bindings.
- [ ] Managed and custom provider fixtures continue to pass without weakening the trust policy.

---

## 8. RG-JOB — State-safe, audited manual retry

### 8.1 Problem

`JobService.retry()` currently updates a job to `QUEUED`, clears errors and leases, and releases locks without checking whether the job is running, successful, cancelled, waiting, or already scheduled. A malformed IPC request or compromised renderer can therefore disturb active work or resurrect a completed side effect.

### 8.2 Product decision

Manual retry is a compare-and-set state transition, not a generic reset. Waiting states use dedicated resume/reconcile commands; scheduled retries use an optional `expedite` command; cancelled or succeeded jobs require a new job identity if the product explicitly supports repeating the action.

### 8.3 Allowed transition matrix

| Current state | `retry` behavior | Required alternative |
|---|---|---|
| `FAILED_RETRYABLE` | Allowed when dependencies and job-kind policy permit | None |
| `FAILED_PERMANENT` | Allowed only with operator reason and one explicitly granted attempt | None |
| `RETRY_SCHEDULED` | Reject as already scheduled | Optional typed `expedite` operation |
| `WAITING_EXTERNAL` | Reject | Provider-specific reconcile/resume |
| `WAITING_HUMAN` | Reject | Human-decision completion operation |
| `QUEUED` / `READY` | Reject as already runnable | None |
| `RUNNING` | Reject without changing row or leases | Cancel-at-checkpoint if supported |
| `SUCCEEDED` | Reject | Explicitly create a new job with a new idempotency identity |
| `CANCELLED` | Reject | Explicit clone/restart workflow after confirmation |

### 8.4 Functional requirements

| ID | Requirement |
|---|---|
| RETRY-001 | Read job kind, state, attempts, project, and lease information inside one database transaction. |
| RETRY-002 | Update with `WHERE id = ? AND state IN (...)`; require exactly one changed row or return a stable invalid-state/concurrent-change error. |
| RETRY-003 | Invalid retry must leave state, error, output, completion time, project lock, resource lease, attempt counters, and availability unchanged. |
| RETRY-004 | Manual retry of a permanent failure must record operator reason, prior error, prior state, and the granted extra-attempt count in durable audit history. |
| RETRY-005 | A granted manual attempt must update the attempt budget explicitly; attempts must never exceed the recorded budget implicitly. |
| RETRY-006 | Side-effecting job kinds such as upload or publication must reconcile remote state and reuse the original idempotency identity before becoming runnable. |
| RETRY-007 | Two concurrent retry requests may produce at most one successful transition. |
| RETRY-008 | Locks and resource leases may be released only when owned by the retried failed job and as part of the successful transition transaction. |
| RETRY-009 | IPC and UI must expose stable outcomes: `retry_started`, `already_scheduled`, `invalid_state`, `reconciliation_required`, and `concurrent_change`. |
| RETRY-010 | UI retry controls must be derived from the backend capability result, not a duplicated renderer state list. |

### 8.5 Verification and acceptance

Proposed canonical acceptance IDs:

- `JOB-011` — manual retry transition allowlist and compare-and-set behavior.
- `JOB-012` — manual retry attempt grant and audit history.
- `JOB-013` — side-effect job reconciliation before retry.

Required tests:

- Table-driven test over every `JobState` asserting outcome and complete row/lock/lease preservation.
- Two-connection or interleaved concurrency test proving only one retry wins.
- Failed final-render retry retaining dependencies and safe resource lease behavior.
- Upload retry with remote video already created, upload session unknown, and no remote effect.
- IPC negative tests that call retry regardless of renderer button visibility.
- Audit redaction and attempt-budget tests.

### 8.6 Completion criteria

- [ ] Only the documented failed states can enter `QUEUED` through manual retry.
- [ ] Invalid retry of every other state is side-effect free, including lock and lease state.
- [ ] SQL compare-and-set makes concurrent retry deterministic.
- [ ] Permanent-failure retry requires and records an operator reason and explicit attempt grant.
- [ ] Upload/publication retry cannot run before remote reconciliation succeeds.
- [ ] Renderer controls consume backend retry capability and stable typed errors.
- [ ] Existing deferred final-render behavior uses `expedite` or natural scheduling rather than generic retry.
- [ ] `JOB-011` through `JOB-013` have exact automated bindings.

---

## 9. RG-FINAL — Active final-render identity through publication

### 9.1 Problem

Final Review resolves `project.finalRenderId`, but YouTube upload and approval use the first succeeded final render in a list ordered by creation time. With multiple succeeded finals, review can approve one artifact while upload or approval fingerprints another.

The defect also creates a race: even after selecting the correct render, the active pointer can change while a durable upload job is queued or while YouTube is processing.

### 9.2 Product decision

Create one main-process active-final resolver and snapshot its identity into every publication operation. The publication identity is:

```text
projectId
+ finalRenderId
+ finalSha256
+ selectedPackageId
+ package/thumbnail approval hash
+ confirmedChannelId
```

Changing any component invalidates approval and prevents publication of the stale snapshot. A remotely uploaded stale video remains private and is surfaced as an actionable exception; it is never silently published.

### 9.3 Functional requirements

| ID | Requirement |
|---|---|
| FINAL-001 | Add a single `requireActiveFinal(projectId)` resolver used by Final Review, upload creation/resume, approval fingerprinting, and publication. |
| FINAL-002 | The resolver must require `project.finalRenderId`, same-project ownership, `kind=final`, `state=SUCCEEDED`, an existing managed output, and a matching persisted SHA-256. |
| FINAL-003 | Upload job input and publication records must persist `finalRenderId` in addition to `finalSha256`. |
| FINAL-004 | Before each side-effect boundary—upload creation/resume, metadata update, thumbnail/caption attachment, and publish/schedule—the service must compare the current active final and package identity with the snapshot. |
| FINAL-005 | A pointer or hash mismatch must keep any remote video private, stop the workflow, invalidate approval, and create a deduplicated actionable exception. |
| FINAL-006 | Resumable upload lookup must include project, confirmed channel, final render ID, and final SHA; SHA alone is insufficient ownership. |
| FINAL-007 | Approval fingerprints must be computed from the same snapshotted final record used for upload. |
| FINAL-008 | Revisions that change final output must invalidate publication snapshots transactionally with the final pointer change. |
| FINAL-009 | Legacy publication rows without a render ID may be backfilled only when project + SHA resolve to exactly one final render; ambiguous rows require re-upload/review. |
| FINAL-010 | Operator views must show the final render ID/hash associated with a private upload and clearly flag a stale remote upload. |

### 9.4 Data and migration plan

- Add `final_render_id` and any required snapshot-version field to `publication_records` with a foreign key where SQLite migration constraints permit.
- Backfill only uniquely resolvable rows; record an explicit legacy/unbound state for the rest.
- Include final render ID in publication uniqueness/idempotency decisions with channel ID and hash.
- Keep the existing SHA-256 as the content-integrity key; do not replace it with a mutable path.
- Update source and packaged migrations together and exercise upgrade from a schema-18 fixture.

### 9.5 Verification and acceptance

Proposed canonical acceptance IDs:

- `YT-011` — upload and approval use the authoritative active final render.
- `YT-012` — active-final changes keep stale uploads private and invalidate approval.
- `REN-015` — active-final resolver rejects missing, cross-project, failed, missing-file, and hash-mismatched renders.

Required tests:

- Multiple succeeded finals where `finalRenderId` is older than the newest row.
- Pointer change before upload starts, during resumable upload, during processing, and before approval.
- Same SHA across projects/channels without cross-project publication reuse.
- Missing file and hash mismatch at each side-effect boundary.
- Unique and ambiguous legacy publication migration fixtures.

### 9.6 Completion criteria

- [ ] Final Review, upload, resumable lookup, approval, publish, and schedule all use one active-final resolver/snapshot.
- [ ] Multiple-final tests prove list ordering cannot select the publication artifact.
- [ ] Publication records persist both final render ID and final SHA-256.
- [ ] A changed final or package cannot update or publish a stale private upload.
- [ ] Stale remote uploads remain private and produce one actionable exception.
- [ ] Legacy rows are safely backfilled or blocked without guessing.
- [ ] Schema-18 upgrade and fresh-database migration tests pass for source and packaged migrations.
- [ ] `YT-011`, `YT-012`, and `REN-015` have exact automated bindings.

---

## 10. RG-CLAIMS — Release-claim digest and evidence projection

### 10.1 Problem

`scripts/validation-input.mjs` hashes implementation, tests, acceptance data, and selected configuration, but excludes `README.md`, `VALIDATION_REPORT.md`, `docs/IMPLEMENTATION-COVERAGE.md`, and `docs/PRODUCTION-HARDENING.md`. These documents make strong release, coverage, and qualification claims, so they can change without affecting the current validation input hash.

Simply adding every generated report to the runtime input hash would create confusing or circular provenance. Runtime correctness and release claims therefore need related but distinct digests.

### 10.2 Product decision

Produce two non-circular digests:

- `runtimeInputSha256`: source, tests, migrations, workflows, normative PRD/contracts, and build configuration.
- `claimsInputSha256`: human-readable files that assert release, coverage, security, or qualification status plus the immutable machine-readable release-evidence index they cite.

The release manifest records both. Claim documents never embed a hash of a manifest that itself hashes those documents. Post-publication receipt updates may produce a new claims digest on a later docs commit, but must state which earlier release commit/artifacts they describe.

### 10.3 Functional requirements

| ID | Requirement |
|---|---|
| CLAIM-001 | Include normative PRD, technical specification, state-machine, provider-contract, acceptance, and hardening policy files in `runtimeInputSha256`. |
| CLAIM-002 | Define an explicit claims file list including `README.md`, `VALIDATION_REPORT.md`, `docs/IMPLEMENTATION-COVERAGE.md`, `docs/PRODUCTION-HARDENING.md`, and `docs/DEPENDENCY-SECURITY.md`. |
| CLAIM-003 | Hash normalized paths and raw bytes deterministically; record file count and per-file digests in a claims manifest. |
| CLAIM-004 | Add a machine-readable immutable release-evidence index for each published release containing exact commit, tag, run/job IDs, conclusions/timings, release ID/URL, asset names/sizes/digests, and qualification flags. |
| CLAIM-005 | Add a claim validator that rejects a document's release tag, commit, run ID, asset count, signed/unsigned state, or `production_ready` status when it conflicts with the evidence index. |
| CLAIM-006 | Release provenance must contain both runtime and claims digests and identify the commit at which each was calculated. |
| CLAIM-007 | A docs-only post-publication receipt must clearly identify that it describes an earlier immutable tag and must not move or replace that tag. |
| CLAIM-008 | Generated narrative, if introduced, must be deterministic from the evidence index; hand-authored narrative remains allowed only when validated for machine-checkable claims. |
| CLAIM-009 | CI must run claim validation on every pull request that changes a claims file or release-evidence index. |
| CLAIM-010 | The truthful-release rule remains authoritative: passing automation cannot set `production_ready: true` while external gates are pending. |

### 10.4 Evidence lifecycle

1. Candidate commit runs clean release validation and produces runtime evidence.
2. Tag workflow packages the exact commit and produces immutable release provenance/assets.
3. Publication verification records remote release metadata in a versioned evidence index on a later docs branch.
4. Claim validation binds the docs commit to that index and the index to the immutable release commit.
5. The original tag and release stay unchanged; the docs commit is a receipt, not a rebuilt binary release.

### 10.5 Verification and acceptance

Proposed canonical acceptance IDs:

- `REL-004` — runtime and release-claim digests are separate, deterministic, and recorded.
- `REL-005` — human-readable release claims must match immutable machine evidence.
- `REL-006` — post-publication docs receipts cannot imply a moved tag or production qualification.

Required tests:

- One-byte changes in every runtime and claims file change only the expected digest(s).
- Reordered filesystem enumeration yields identical digests.
- Tampered tag, SHA, run ID, timing, asset count/digest, prerelease state, signature state, and production-ready claim fixtures.
- Docs-only receipt fixture that correctly points to an older release commit.
- Circularity check proving no manifest hashes content that embeds that manifest's own digest.

### 10.6 Completion criteria

- [ ] Runtime inputs include normative product/security/acceptance documents.
- [ ] All release-claim documents and the evidence index are covered by a deterministic claims digest.
- [ ] Release provenance records both digests and their source commits without a hash cycle.
- [ ] Claim validation rejects every tested false or stale machine-checkable claim.
- [ ] Post-publication docs receipts explicitly distinguish docs commit from immutable release commit.
- [ ] The truthful-release rule cannot be overridden by CI success or narrative text.
- [ ] `REL-004` through `REL-006` have exact automated bindings.
- [ ] Existing alpha.7 evidence is migrated into the new historical index and validates without moving its tag/release.

---

## 11. RG-TOOLS — Trusted FFmpeg/FFprobe overrides and safe profiles

### 11.1 Problem

Portable profiles currently include `ffmpegPath` and `ffprobePath`. Import applies them through the generic settings schema, and resolution prefers an existing configured path before bundled tools. The selected executable later runs directly with the application environment.

Custom tool overrides are useful for diagnostics and controlled operator workflows, but executable trust must be local, explicit, and non-portable.

### 11.2 Product decision

Executable paths and trust records are device-local privileged settings. They are excluded from profile export, ignored with a warning on import, and changed only through a dedicated main-process trust flow. Bundled binaries remain preferred in packaged production operation.

### 11.3 Functional requirements

| ID | Requirement |
|---|---|
| TOOL-001 | Exclude `ffmpegPath`, `ffprobePath`, binary hashes, trust timestamps, and unsafe/developer flags from profile export. |
| TOOL-002 | Strip those keys from profile import before generic schema parsing, record warnings, and never mark them as applied. |
| TOOL-003 | Remove executable overrides from generic settings update IPC; use a dedicated local binary selection/confirmation operation. |
| TOOL-004 | Accept only an absolute path resolving to an existing regular file; resolve canonical/real path and reject directories, devices, and unresolved links. |
| TOOL-005 | Before trust, inspect SHA-256, size, platform signature metadata when available, and product role without executing the candidate; show that identity to the operator. |
| TOOL-006 | Persist a device-local trust record containing canonical path, SHA-256, role, trust time, and application version. |
| TOOL-007 | Before first general use and every later execution, require bundled identity or a matching trusted canonical path/hash. The first post-trust version probe must have a minimal environment and timeout; failure revokes trust. |
| TOOL-008 | Packaged production builds prefer bundled binaries; PATH discovery is development/diagnostic fallback and is visibly labeled. |
| TOOL-009 | Existing custom paths become `confirmation_required` after upgrade and cannot execute until trusted; bundled fallback may continue safely. |
| TOOL-010 | Tool execution audit records role, canonical path category (`bundled` or `custom`), and hash prefix without command payloads that may expose project paths. |
| TOOL-011 | A profile cannot import a binary trust record or mark a custom binary trusted. |
| TOOL-012 | Clearing a custom override removes its trust record and returns resolution to the bundled/default tool. |
| TOOL-013 | FFmpeg/FFprobe subprocesses receive an allowlisted environment that excludes provider credentials, OAuth material, and unrelated application secrets. |

### 11.4 Profile schema and UX

- Increment the portable profile schema version and retain a compatible reader for schema version 1.
- Version-1 imports containing tool paths succeed for safe settings but warn that executable overrides were ignored.
- Export reports must list tool overrides among intentionally excluded device-local values.
- Before confirmation, Settings shows bundled/custom source, canonical path, hash, signature metadata when available, and trust status; version output appears only after the trusted bounded probe.
- Trust confirmation must identify that the executable will process local media with the app's operating-system permissions.

### 11.5 Verification and acceptance

Proposed canonical acceptance IDs:

- `SEC-012` — portable profiles cannot import executable paths or trust.
- `SYS-007` — custom FFmpeg/FFprobe require local hash-bound confirmation.
- `SYS-008` — changed or missing trusted binary fails closed to a safe bundled/default path.

Required tests:

- Version-1 and version-2 profile export/import with tool paths and forged trust fields.
- Relative path, directory, missing path, link, changed binary, and role mismatch fixtures.
- Successful bundled resolution and explicitly trusted custom resolution.
- Upgrade fixture with an existing custom override.
- IPC test proving generic settings update cannot change executable paths.
- Child-process environment test proving provider and OAuth secrets are absent.

### 11.6 Completion criteria

- [ ] Portable exports contain no executable path or trust metadata.
- [ ] Imports ignore executable-related keys, apply other safe settings, and return explicit warnings.
- [ ] Generic settings IPC cannot modify FFmpeg/FFprobe execution identity.
- [ ] Custom binaries require local confirmation tied to canonical path and SHA-256.
- [ ] A changed, missing, or untrusted custom binary never executes.
- [ ] Custom media-tool processes receive a minimal environment without provider or OAuth secrets.
- [ ] Packaged builds continue to use bundled tools by default.
- [ ] Existing custom overrides are quarantined safely during upgrade.
- [ ] `SEC-012`, `SYS-007`, and `SYS-008` have exact automated bindings.

---

## 12. Integrated data, API, and migration changes

### 12.1 Expected persisted changes

The implementation may combine migrations when safe, but must provide these logical capabilities:

- Publication records bind `final_render_id` and a snapshot/version to the existing final hash and channel.
- YouTube connection state records confirmed channel ID/title and confirmation time separately from encrypted tokens.
- Provider credential metadata binds a secret handle to provider identity and canonical origin without storing the secret in SQLite.
- Device-local tool trust records bind role, canonical path, and SHA-256.
- Manual retry grants and prior failure context remain reconstructable through existing audit storage or a dedicated attempt/transition table.

### 12.2 IPC/API changes

Expected typed operations:

- `youtube.authorization.begin`, `.confirm`, and `.cancel`.
- `providers.endpoint.validate`, `.trust`, and `.clearTrust` or equivalent main-owned settings operations.
- `jobs.retryCapability`, `.retry`, and optional `.expedite` with expected state/version and operator reason where required.
- `tools.inspect`, `.trust`, and `.clearOverride`.
- Publication responses expose snapshotted final render ID/hash and stale status.

Names may follow current IPC conventions, but behavior and privilege separation are mandatory.

### 12.3 Migration and rollback requirements

- Database upgrade from schema 18 must be automatic, transactional, backed up, and tested.
- A failed migration must leave the previous database usable and must not partially activate new trust or publication semantics.
- Existing OAuth tokens remain encrypted but are marked channel-confirmation-required before upload/publish.
- Existing provider secrets remain encrypted but unavailable to a changed/unconfirmed origin.
- Existing tool paths remain visible for recovery but untrusted until confirmed.
- Existing publication rows are backfilled only when final identity is unambiguous.
- Rollback to an older binary must not cause it to publish an unbound/stale final; document any minimum-compatible database version.

### Integrated migration completion criteria

- [ ] Fresh install and schema-18 upgrade produce identical current schemas.
- [ ] Source and packaged migration sets are byte-identical and contiguous.
- [ ] Migration failure injection proves atomic rollback.
- [ ] No legacy token, endpoint, publication, or binary trust is silently elevated.
- [ ] Backup/restore preserves new binding and audit fields.
- [ ] An older incompatible app version is blocked or warned before it can mutate upgraded state unsafely.

---

## 13. Delivery sequence and PR boundaries

The work should land as independently reviewable, revertible pull requests. Security-sensitive behavior must not be hidden inside a broad refactor.

| Phase | Pull-request scope | Dependencies | Exit gate |
|---|---|---|---|
| 0 | Shared test architecture, typed-error conventions, migration allocation, and proposed-ID reservation in this PRD | This PRD | No canonical ID is added without a passing assertion; each implementation lane carries its IDs atomically |
| 1 | RG-VAL validation modes, clean/exact identity, generated-evidence lifecycle | Phase 0 | `REL-001`–`REL-003` pass |
| 2 | RG-CLAIMS claims digest, evidence index, claim validator | Phase 1 | `REL-004`–`REL-006` pass |
| 3 | RG-OAUTH state, PKCE, pending tokens, channel confirmation | Phase 0 | `YT-009`, `YT-010`, `SEC-009` pass |
| 4 | RG-NET centralized endpoint and credential-origin policy | Phase 0; coordinate settings changes with phase 6 | `SEC-010`, `SEC-011`, `JOB-010` pass |
| 5 | RG-JOB retry compare-and-set, audit, reconciliation | Phase 0 | `JOB-011`–`JOB-013` pass |
| 6 | RG-TOOLS profile filtering and device-local binary trust | Phase 0; after conflicting settings-schema changes in phase 4 | `SEC-012`, `SYS-007`, `SYS-008` pass |
| 7 | RG-FINAL resolver, publication snapshot, schema migration | Phase 0; coordinate YouTube service changes with phase 3 | `YT-011`, `YT-012`, `REN-015` pass |
| 8 | Full integration, migration rehearsal, documentation, release candidate | Phases 1–7 | Entire remediation release gate passes |

### 13.1 Merge discipline

- Rebase each lane on the latest staging/main baseline before final CI.
- Require exact-head CI before merge and post-merge CI before starting release promotion.
- Do not combine OAuth and active-final changes in one review unless file overlap makes separation impossible; retain separate commits and test evidence.
- Do not mark an acceptance ID automated until its exact assertion exists and passes in fresh reports.
- Do not regenerate or move the alpha.7 tag/release while implementing this plan.

### Delivery completion criteria

- [ ] Each phase is represented by a focused PR with threat-model notes and exact acceptance evidence.
- [ ] Settings and YouTube service overlap is sequenced without dropping another phase's protections.
- [ ] Every merged phase passes post-merge CI before dependent work is promoted.
- [ ] No phase moves or replaces an existing release tag.
- [ ] The integration PR contains no unexplained acceptance, migration, or documentation drift.

---

## 14. Verification matrix

| Area | Unit | Integration | Built Electron | Hosted/release | External |
|---|---|---|---|---|---|
| Exact validation evidence | Git admission and schema fixtures | Temporary Git repositories | Not required | Exact-SHA Linux/Windows transfer and tag verification | Not required |
| OAuth binding | State/PKCE/session fixtures | Mock loopback callback and Google client | Confirmation/cancel UX | Packaged callback smoke without real credentials | Live Google channel authorization |
| Provider trust | URL/address/redirect policy | Local HTTP/DNS/redirect fixtures | Trust/health UI | Packaged network-policy smoke | Managed and approved custom provider rehearsal |
| Job retry | State table and CAS | SQLite concurrency, locks, reconciliation | Retry capability/error UX | Standard CI | Forced interruption remains an external gate |
| Active final | Resolver and fingerprint | Multiple finals, resumable publication, migration | Stale-upload warning UX | Windows package and CI | Live private upload/publish rehearsal |
| Claims binding | Deterministic digest and tamper fixtures | Release-evidence index validation | Not required | PR/main/tag receipt chain | Remote release metadata verification |
| Tool trust | Profile filter and hash verifier | Schema-1 upgrade and changed binary | Trust/clear/warning UX | Packaged bundled-tool smoke | Clean-machine tool discovery |

### 14.1 Required negative evidence

Passing happy paths alone is insufficient. The release receipt must preserve exact passing assertions for:

- Dirty and stale validation rejection.
- OAuth state mismatch, replay, expiration, and rejected channel confirmation.
- Private/local/redirect endpoint rejection and credential-origin mismatch.
- Retry rejection for `RUNNING`, `SUCCEEDED`, `CANCELLED`, waiting, and already-runnable states.
- Active-final change at every publishing side-effect boundary.
- Tampered release claims and evidence indexes.
- Imported, missing, changed, and untrusted executable overrides.

### Verification completion criteria

- [ ] Every row in the matrix has the required evidence or an explicit retained external-gate reason.
- [ ] Negative assertions are present in Vitest/Playwright reports and exact acceptance bindings.
- [ ] CI uploads evidence from the exact tested head and Windows packaging consumes that same evidence.
- [ ] The final release manifest verifies runtime digest, claims digest, package hashes, and package-smoke identity.
- [ ] Live OAuth/provider/upload rehearsals do not replace automated negative tests.

---

## 15. Security, privacy, and observability requirements

### 15.1 Security events

Record structured, redacted events for:

- Validation admission/rejection and qualification mode.
- OAuth authorization start, callback acceptance/rejection category, channel confirmation, cancellation, and replacement.
- Provider endpoint trust, rejection category, origin change, and credential binding invalidation.
- Manual retry request, expected/actual state, result, reason, and granted attempt.
- Publication snapshot creation, stale detection, and approval invalidation.
- Tool binary inspection, trust, hash mismatch, and trust removal.

### 15.2 Prohibited data

Never record:

- OAuth codes, state values, PKCE verifiers, access tokens, or refresh tokens.
- API keys, Authorization headers, URL user information, or secret-store payloads.
- Full prompts, scripts, contact-sheet bytes, narration text, or media content in security events.
- Full executable command lines when they contain project or media paths.

### 15.3 Operational signals

Health/diagnostics should surface counts and categories without sensitive values:

- Unconfirmed OAuth channel binding.
- Untrusted or credential-mismatched provider configuration.
- Failed jobs eligible/ineligible for retry.
- Stale private uploads awaiting re-upload/review.
- Untrusted or changed custom media tools.
- Current validation qualification and the exact commit it proves.

### Security/observability completion criteria

- [ ] Every privileged rejection has a stable code and a redacted structured event.
- [ ] Redaction tests cover OAuth, provider, publication, retry, and tool-trust flows.
- [ ] Health UI distinguishes configuration/trust failures from provider/runtime failures.
- [ ] Security events are sufficient to reconstruct decisions without retaining secrets or sensitive content.
- [ ] Renderer-visible messages contain actionable recovery steps but no privileged material.

---

## 16. Remediation release gate

The remediation milestone may be declared complete only when all criteria below are satisfied.

### 16.1 Code and acceptance

- [ ] All seven workstream completion checklists are complete.
- [ ] All proposed acceptance IDs have been added to `06-ACCEPTANCE-TESTS.md` with exactly one coverage classification.
- [ ] Every automated ID has at least one exact assertion binding and fresh passing result.
- [ ] All source and packaged migrations match and pass fresh-install plus schema-18 upgrade tests.
- [ ] There are no open Critical or High defects in the remediation scope.

### 16.2 Validation and packaging

- [ ] Full canonical validation passes from a clean exact-head checkout.
- [ ] The receipt records release qualification, exact commit, tree hash, runtime digest, claims digest, toolchain, and `dirty: false`.
- [ ] Hosted Windows ZIP and NSIS package lifecycle smoke passes for the same exact commit and package hashes.
- [ ] Tampered, stale, dirty, mismatched, unsafe-name, extra-artifact, and missing-evidence fixtures all fail closed.
- [ ] The published artifact inventory and SHA-256 values match locally verified release provenance.

### 16.3 Product and operator behavior

- [ ] A YouTube connection cannot become active without state, PKCE, and explicit channel confirmation.
- [ ] Provider credentials cannot cross an untrusted origin change.
- [ ] Invalid manual retry cannot mutate a job or its locks/leases.
- [ ] Upload and publication remain bound to one active final snapshot.
- [ ] Portable profiles cannot install executable trust.
- [ ] Release documentation claims match the immutable evidence index.

### 16.4 Qualification truthfulness

- [ ] The application and release remain marked unsigned unless code signing is actually completed.
- [ ] `production_ready` remains `false` while any existing external qualification gate is pending.
- [ ] The external Windows, licensed-media, live-provider, forced-interruption, performance, cadence, and five-video pilot gates remain visible and are not recast as locally complete.
- [ ] The prior alpha.7 tag and release remain immutable.

---

## 17. Final definition of done

This plan is done only when the code, database, IPC, UI, tests, receipts, and documentation tell the same story:

- evidence proves the exact clean source it claims;
- browser authorization is session-bound and channel-confirmed;
- credentials and executable trust cannot move through portable settings;
- retries and publication are state- and identity-safe;
- narrative release claims are machine-verifiable; and
- all remaining external gates are still reported honestly.

Completing implementation is not permission to mark production readiness. It closes the seven audit gaps and creates trustworthy evidence for the next qualification decision.
