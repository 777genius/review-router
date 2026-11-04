# Plan: make OCR native preview the selection authority (2026-11-04)

Status: **implemented in draft PR #371; final CI/E2E qualification and merge pending**. Scope: public ReviewRouter Action adapter and focused tests. No runtime activation/deployment implied.

## Evidence and fixed baseline

- SaaS production (read-only evidence): private228 source `a3db73fd77eda829480f57ffe3f40ed7c9f9da06`; public Action229 `755a6443420b4e6eaa9dd953a9df157bafc73f74`; native `ocr-managed-v5`, version `1.13.1-rr.6`, upstream `8eb83340a487b1150af00701b94f01af97e4b4d6` plus the 12 pinned patches in `tools/ocr/qualifications/unified-model-routes-v3.manifest`.
- PR 777genius/review-router-ai#811, run 41770044290: one tracked `vendor/account-gateway/candidate-sdk-provenance.json` was displayed as "file content unavailable"; native completion reported `missing_paths`, scope 6/7, three preliminary findings held from inline publication. Upstream-pinned `internal/diff/git.go` excludes `vendor/`, and `internal/agent/preview.go` exposes `exclude_reason=provider_directory`. The exact run's raw preview is not retained as an accessible artifact; do not pretend it was independently inspected.
- Agent-runtime#249 run 41809715442 and agent_teams_orchestrator#209 run 41809673920: closed exit-0 OCR with `no_model_requests`, followed by `required_work_exhausted`; exact `eligiblePaths=0` preview is **not proven**.
- Action `planOcrReviewAssignments` assigns all PR paths, `prepare` reduces preview to selected paths, unselected becomes `Unavailable`, and native outcome reconciliation erroneously compares groups against all assigned paths. Generic projection then labels `Unavailable` as unavailable file content.
- Existing guarantees: immutable request/manifests and hashes; unknown/paid Gateway effect fences; actual model attribution; required reviewer lanes; normalization/span checks; lifecycle mutation holds; App publication/recovery, Statistics, Usage.

## Required behavior and ownership

One owner per fact:
1. **SCM / RR work planner:** exact changed-file inventory, admitted revision/identity, required reviewer lane, assigned work. Do not drop a changed file merely because OCR selects nothing.
2. **Native OCR:** which assigned files will be reviewed, reasons for intentional exclusions, and outcome groups and execution phases. Obtain these facts from the **same pinned executable/config/revision** via its existing model-free `--preview`.
3. **RR OCR adapter:** bounded, strict reconciliation of the native preview against the admitted SCM set, mapping to existing `ReviewPromptPathCoverageKind` values; accept only selected paths in native outcome reconciliation.
4. **Shared RR projection / SaaS:** retain policy for required incompleteness, failing findings, held inline/lifecycle/snapshot, app ownership, Usage/Statistics. Do not grant OCR a special bypass.

A file can be:
- `FullPatch` only if native preview selects it (which proves *offered to review*, not proof the model read every line);
- `PolicyExcluded` only if native preview explicitly says `will_review=false` with a recognized **intentional, nonrecoverable selection exclusion** (e.g., `provider_directory`, `binary`, `deleted`, `secret_exclude`, `unsupported_ext`, `default_path`). Record its native reason in the narrow adapter diagnostics; no second list of path prefixes or globs;
- `Unavailable` if no preview entry, contradictory/malformed decision, recoverable inability to review (`too_large`), or an unknown reason. Such a required file remains incomplete. `user_exclude` must be investigated against managed rules rather than being silently whitelisted.

Invariants: preview cannot expand authority beyond assigned set; duplicates/unknown paths and contradictory `will_review`/reason are rejected, not ignored; missing preview entries never become exclusions. If the native preview schema is absent or malformed, fail closed, not "all intentionally excluded". Native outcome groups must be unique, subset of *selected* paths and reconcile to selected paths; a missing selected group stays partial, not a clean review. No findings is not the same as no execution.

## Implementation slices

### Slice 1 — native selection mapping, no new protocol

1. In `src/review-orchestration/infrastructure/ocr-review-invocation-adapter.ts`, replace lossy `parseOcrPreviewSelection` with a pure bounded decoder/reconciler of the pinned native `files: [{path,status,will_review,exclude_reason}]` shape. Keep narrow legacy selected-path fallback only if it can never infer exclusions from absence; otherwise reject with a clear local error. Expose a small internal immutable result: selected paths and per-assigned-path mapped coverage; do not add a general eligibility framework.
2. Preserve all original assigned paths and their content hashes in `createReviewPromptCoverageManifest`, but map explicit native exclusions to `PolicyExcluded`. Reuse the existing coverage hash/immutable preimage. Ensure a failed or truncated preview is not accepted as a successful empty selection. Do not infer "content unavailable" from native policy.
3. In `acceptOcrManagedReviewResult`, compare `reviewrouter_outcome.groups` to **preview-selected** paths, not all originally assigned paths. Preserve the original assigned-set guard on each native finding. Keep outside/duplicate group rejection and missing selected-group partial detection; do not weaken phase, actual-model, process-close, gateway effect or span validation.
4. Keep the existing generic `promptCoverageToManifestFile` mapping and app publication policy. Make the OCR-specific cause observable in existing safe diagnostics without adding new output protocol or wiring native reason text into GitHub finding content.

### Slice 2 — explicitly zero eligible work (separate compatibility gate)

The current `RunT0ReviewOrchestration` explicitly rejects empty work-slot plans and `ReviewObservationPayload.actualModel` is mandatory; the normalizer can fall back to requestedModel. **Never create a fake successful model observation for `no_model_requests`.**

1. First validate with the actual pinned preview that `selectedPaths=[]`, all assigned paths have admissible native reasons, and the native terminal state is a clean skip; separately verify no rejected/unknown Gateway dispatch effect.
2. Check existing orchestration / SaaS terminal contracts for a legitimate no-applicable-work outcome *before* editing their schemas. If already supported, adapt narrowly and test readback, neutral check, no complete-review Stats fact, no usage model call and no lifecycle mutation.
3. If the current contracts cannot represent no-work without changing persisted/public protocol, **do not invent compatibility or fake a completed review**. Keep safe fail-closed behavior and document the exact blocked contract as a follow-up. This slice cannot be conflated with Slice 1's successful selected-work acceptance.

### Slice 3 — scoped regression and E2E

Changed-path tests only; use the existing Jest suites and existing actual managed binary / synthetic loopback harness:
- Unit: `vendor/*.json` with one ordinary selected file => one `PolicyExcluded`, one `FullPatch`, complete only if selected outcome succeeds. No hardcoded `vendor/` in Action.
- Unit: selected file absent from native outcome => `missing_paths`, partial; native group outside selected => contract mismatch, not silently ignored; malformed/duplicate/omitted preview entries and unknown/`too_large` exclusions never produce green.
- Unit: binary/deleted/renamed, `user_exclude` ambiguity, previews with legacy shape, full selected coverage with zero findings, cancellation and terminal process/effect failures.
- Test existing required-vs-optional multi-reviewer and batching coverage; old manifest/restore/hash compatibility remains fail closed; no lifecycle/verified-clean changes.
- Add one deterministic native-CLI integration to `__tests__/integration/ocr-managed/ocr-managed-real-cli.test.ts` or an existing neighboring suite that uses the pinned `ocr-managed-v5` candidate with synthetic loopback, checking actual preview vs outcome (ordinary `calc.ts` + tracked `vendor/candidate.json`). No paid model calls, new disposable repositories, deployment or live production reviews.
- Existing successful tests are not repeated without changed risk. CI must confirm source tests, typecheck, and produced action bundle identity where required by AGENTS/docs.

## Delivery sequence

1. Plan critique (two distinct passes below), commit/push this plan immediately, open **draft** PR.
2. Implement Slice 1, commit/push immediately. Focused tests -> inspect diff/diagnostics -> fix.
3. Determine Slice 2 feasibility from exact contracts; implement only if supported without unrelated schema migration; never silently reinterpret older evidence. Commit/push each coherent fix immediately.
4. Focused/real-native synthetic E2E and CI/review; at least two post-implementation critique rounds. Fix all confirmed in-scope defects, then revalidate changed paths and accepted CI.
5. Only after green required checks, validated exact PR head and no unresolved critical review threads, mark ready and squash merge into `main`; verify post-merge SHA/status. Runtime activation is separate and **not** authorized by this PR.

## Plan critique rounds and revisions (reasoning audit; no external agents or model calls)

**Round 1 — security/fail-open critic.** Original tempting idea ("trust previewSelectedPaths as expectedPaths") could hide malformed/unreported paths. Correction: reconcile every original SCM assigned path, reject unknown and duplicate native paths, accept `PolicyExcluded` only on explicit admissible reasons, keep `too_large` incomplete, keep outcome groups exact against selected. Do not equate no findings with no execution.

**Round 2 — operations/contracts critic.** Original temptation ("treat no_model_requests as success") fabricates actualModel and complete review statistics and can undermine required reviewer lanes, restore and billing. Correction: first prove zero selected and native skip, then require a native no-work contract; otherwise report a hard incompatibility and leave no-op fail closed. Avoid SaaS/schema/DB/flag changes until concrete contract proof.

**Round 3 — projection/evidence critic.** A prepared `FullPatch` means provider-visible selected diff; if selected group later fails/missing, qualityFlags must still force partial, no inline/lifecycle all-clear. Existing immutable prepared manifest cannot be silently mutated after execution. Avoid claiming 100% *executed* review from preview selection alone. Preserve cause in diagnostics and do not broaden work into a new per-file runtime receipt protocol without evidence.

## Explicit non-goals

No changes to OCR fork patches, CodeRabbit/OCR model choice, retry policy, Gateway transport, payment/usage pricing, SaaS DB/migrations, repo onboarding, flags, UI redesign, legacy OAuth workflows, PR #370/#812, or unrelated issue fixing. No deployment. This is a bounded Action-owned coverage fix with tests.

## Completion evidence required

Plan in draft PR; source diff and expected-head SHA; complete two critical rounds after implementation; passing relevant CI / actual native synthetic E2E at the pushed head; no unresolved scoped findings; merge and post-merge readback. If CI or native binary cannot be run, explicitly report the blocker and do not claim E2E or merge success.

## Implementation review after source changes

- **Critic pass 1 (security):** exact native preview decisions are reconciled to the original assigned inventory, native-selected groups must match the selected set, and malformed/stale preview or unexpected selected paths fail closed. Out-of-scope files excluded with native `user_exclude` are permitted only when not selected.
- **Critic pass 2 (behavior and compatibility):** retain both old and current native preview selection shapes without inferring an exclusion from absent paths. Native-managed `provider_directory` evidence classifies the tracked vendor JSON as an explicit policy exclusion instead of `Unavailable`. Partial outcomes, unverified spans, observed model identity, Gateway effects, immutable manifests and required reviewer votes are unchanged.
- **Critic pass 3 (E2E):** add actual managed OCR binary coverage of an ordinary changed TypeScript file plus a tracked `vendor/**/*.json` exclusion using the existing synthetic loopback fixture, plus negative tests for missing selected groups, duplicate/out-of-scope paths, malformed schema and stale preview output. Generated `dist` is committed from the exact Action source.
- **Zero eligible work:** existing public/SaaS terminal contracts do not encode a no-applicable-work success without fake model attribution or incorrect settled review facts. This PR deliberately leaves the no-model-request rejection fail-closed; do not misrepresent it as fixed or trigger a new protocol/migration in this bounded change. A separately authorized protocol-level no-op outcome is needed to fix workflow-only PRs safely.
- **Release scope:** merge of this public Action source is not a production deployment, and no hosted runtime activation is implied.
