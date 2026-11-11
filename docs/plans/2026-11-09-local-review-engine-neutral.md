# ReviewRouter local review — engine-neutral CLI, native OCR, and agent UX

**Status:** implementation plan; not evidence of working software. **Date:** 2026-11-09. **Base at review:** `main` `5be3999ec621e247ae40cadd5175446b0898413c` (recheck before edits). **Owner:** ReviewRouter Action repository; SaaS changes are out of scope.

## 1. Decision, in one paragraph

**Improve the existing `review-router` / `mpr` CLI, not create a second reviewer.** Preserve the existing local legacy `ReviewOrchestrator` route for compatibility, and expose **native OpenCodeReview (OCR)** as an *explicit, independently configurable engine* through one small engine interface. Let OCR do its own semantic file grouping, rules, retrieval, agent-tool reasoning, review filtering, and native coverage; do not duplicate them in TypeScript or reuse the hosted OCR managed adapter in an unauthorized local context. Normalize both engines into the same CLI outcome and stable machine-readable format. Launch manually or from a coding agent. **Do not install a hook, launch a server, or publish to GitHub automatically.** Pre-push is a separate opt-in follow-up after the CLI passes production-quality E2E.

### Direct user UX (target after implementation, not existing syntax)

```sh
review-router review                           # tracked worktree changes, compatibility default
review-router review --engine ocr              # opt into the native OCR engine
review-router review --engine ocr --include-untracked  # explicit consent for new files
review-router review --engine ocr --scope branch --base origin/main
review-router review --engine ocr --scope commit --ref HEAD
review-router review --engine ocr --format json  # same CLI for Codex/Claude/other agents
review-router doctor                           # no inference; verify CLI / installed engines
mpr review HEAD~1                              # retained legacy spelling
```

**Intent:** a usable CLI, not a guarantee that the OCR native engine has the same authenticated, persisted, hosted lifecycle as a GitHub PR review. Never describe an OCR-only result as a verified hosted review. `--engine` selects the *review engine*, `--provider` / `--model` select that engine's supported *LLM transport*. No engine-implicit provider fallback.

## 2. Verified repository facts and why prior plan changed

1. `bin/mpr` maps `review-router` and `mpr` to `dist/cli/index.js` via package `bin`; `src/cli/index.ts`, `git-reader.ts`, `reviewer.ts`, `formatter.ts` implement local execution. `CLIReviewer` uses the legacy `ReviewOrchestrator`, not managed OCR. `src/setup.ts` injects no-op/dry-run GitHub posting stubs in CLI mode.
2. `tools/ocr/build.sh` pins `alibaba/open-code-review` **v1.13.1** at `8eb83340a487b1150af00701b94f01af97e4b4d6`, applies a managed-mode patch set and produces a qualified, patched binary (`1.13.1-rr.6`). The hosted managed adapter requires Account Gateway authority, a private loopback capability, a GitHub revision manifest and model dispatch observation. **It must not be invoked as a standalone local command via its hosted entrypoint.**
3. Pinned upstream OCR *already* supports `ocr review` workspace (tracked + untracked), `--from/--to` merge-base range, `--commit`, `--preview`, `--format json`, `--audience agent`, `--output`, `--resume` for immutable ranges/commits, review grouping and agentic context. Its JSON has status variants (`complete`, `partial`, `failed`, `skipped` with manifests; older `success` / `completed_with_warnings` / `completed_with_errors` without), summary, comments, and optional manifest/warnings. **An OCR exit code 0 does not prove complete coverage.**
4. Legacy CLI gaps: `git diff HEAD` omits untracked; options parse `'dry-run'` but read `dryRun`; `--config` is parsed but not passed; `help`/`version` demand Git repo; `--days` is a string; range uses two tips not merge-base; diff >10MB / >1000 files can be truncated; there is no JSON review envelope or actual completed live-provider E2E. `package.json` says Node >=20 while CLI bundle targets Node 24.
5. `scripts/install-hooks.sh` is a development pre-commit checker, **not** AI pre-push. Existing Action managed/OCR review and this CLI are separate product execution paths. Open #376 risk-aware review, #377 Apache license, #240 hosted-v4 and #201 sharding are **not** local CLI tasks: do not edit their files or workflows.

Source pointers: [`src/cli`](https://github.com/777genius/review-router/tree/main/src/cli), [`src/setup.ts`](https://github.com/777genius/review-router/blob/main/src/setup.ts), [`tools/ocr/build.sh`](https://github.com/777genius/review-router/blob/main/tools/ocr/build.sh), [`ocr-review-managed-run.ts`](https://github.com/777genius/review-router/blob/main/src/review-orchestration/infrastructure/ocr-review-managed-run.ts), [pinned OCR CLI docs](https://github.com/alibaba/open-code-review/blob/v1.13.1/pages/src/content/docs/en/cli-reference.md).

## 3. Hard scope — acceptance boundaries

### Included in **this PR**

- Preserve `review-router`, `mpr`, old positional `review <commit>` / `review <base>..<head>` and existing output/exit semantics **when no new flags are supplied**, except explicit bug fixes documented below.
- Add explicit `--engine legacy|ocr`; default `legacy` **until OCR native path is qualified**. A future separately approved change may change the default; no implicit auto engine selection or surprise model billing.
- Add a **single** narrow boundary for review execution and results, not a generic plugin framework. Legacy adapter uses existing `CLIReviewer`; OCR adapter invokes an explicitly installed and version-checked OCR executable **without** `--reviewrouter-managed`; do not duplicate OCR algorithms.
- Supported OCR scopes in v1: `worktree`, `branch --base <ref>`, `commit --ref <ref>`. Branch uses merge-base. Preserve legacy positional spellings. Add only if needed `--format json` with a consistent outcome, stable schema, completed/partial/failed/skipped/stale, and explicit engine attribution.
- Make CLI work outside a Git repo for `help`/`version`/`doctor`; fix parser and `dry-run`/config wiring. Warn about tracked-only default and fail safely on ambiguous/untracked exposure (see below). No writes to reviewed source files.
- Preserve inference-only installed authorization; no new SaaS login, secrets storage or GitHub write capability. Diagnostics must not print credentials or raw model transcripts.
- Add deterministic tests for Git inputs, JSON integrity, OCR status mapping, unsupported binaries, timeouts, no model, CLI error codes, workspace change detection, and minimal consumer `npm pack` qualification on supported OS. One *explicitly authorized* actual OCR model smoke only if credentials and a trustworthy binary exist; otherwise report this gate unverified, not PASS.

### Explicitly excluded from **this PR**

- No dedicated `pre-push`/`pre-commit` install/uninstall, automatic network fetch, GitHub publication, write-fix, auto-commit, auto-push, IDE/GUI, MCP server, new database or SaaS modifications.
- No `staged`-only or `outgoing` magic for native OCR v1: upstream native OCR does not expose staged-only, and outgoing target semantics need exact remote/ref selection. **Never lie about these scopes.** Revisit in separate scoped follow-up with snapshot materialization and real `pre-push` ref input if needed.
- No OCR managed Gateway bypass or hosted-to-local protocol fork. No new engine types beyond `legacy` and `ocr`. No unsupported ChatGPT OAuth through OCR inferred from newer upstream docs; verify pinned release compatibility.
- No repository-wide TypeScript/dependency bump, license changes, risk-scoring PR overlap, global CI rewrite or feature flags. Maintain Windows/macOS/Linux compatibility without changing other runtime entrypoints.

## 4. Scope and privacy contracts (precise)

| Selector | What is actually reviewed | Failure / caution |
|---|---|---|
| `review` or `--scope worktree` + legacy | Tracked staged+unstaged diff compared to HEAD (existing default). | Show count of excluded nonignored untracked files; never say *all* changes reviewed. |
| `--engine ocr --scope worktree` | OCR native workspace mode. Its default **includes nonignored untracked files**. | If any untracked files exist, require explicit `--include-untracked` before dispatch; otherwise fail usage without sending code. A documented opt-in, not an implicit privacy change. |
| `--scope branch --base origin/main` | OCR `--from <base> --to <resolved HEAD>`; native computes merge-base; preflight checks it. | No unstaged/staged/untracked content assumed. Ref resolution must be local only; no fetch. |
| `--scope commit --ref HEAD` | OCR `--commit <resolved SHA>` | Initial root commit if OCR supports it; otherwise precise unsupported diagnostic. |
| Existing `review main..feature` | Retain legacy semantics until explicit mode used; no silent interpretation changes. | Show exact resolved refs. |

Do **not** interpret `--dry-run` as suppressing LLM billing; existing CLI already suppresses GitHub posting, and native OCR also has no GitHub publishing through this adapter. Document `--dry-run` narrowly and ensure the flag is applied where implemented. Offer a separate no-model `--preview` only if the selected engine actually supports it; native OCR does. Never send even one model request on an invalid scope / ambiguous privacy decision.

**Data snapshot:** compute one bounded digest of relevant commit refs and Git status plus selected file/diff bytes before run; check again on exit (even if model failed), emit `stale` if different. `stale` may retain informational findings but **never** signal pass. Do not treat snapshot hashes as a sandbox: native OCR has subprocess permissions of the invoking user. Document reviewed-code exfiltration to the configured model. For hosted parity and stronger isolation, investigate a disposable read-only checkout separately; **do not** claim OS-level containment without native platform tests. Set timeouts and output-size limits; use `spawn` without shell and with bounded streaming. Never log env tokens or native `thinking` by default.

**Pinned manifest contract (second review pass):** OCR `v1.13.1` declares `schema_version: "ocr.run-manifest/v1"`, `operation: "review"`, `terminal_state`, `input.mode`, `input.resolved_base/resolved_head`, and disjoint `coverage.{selected,completed,reused,failed,waived}` arrays containing `path`/`item_id`. Require exact manifest version, `operation`, scope identity, preflight preview-selected paths matching manifest `selected` paths and all selected items in completed/reused with no failed/waived before reporting `complete`. If model returns legacy `success` without manifest, treat as `partial`, never infer completeness from a numeric count alone. Validate no duplicate `item_id`/path and no foreign paths; bind `input.resolved_head` to the captured ref in branch/commit scopes. **Do not display native `thinking` or raw error payloads.**

**Coverage:** OCR may skip unsupported files. Interpret the *native manifest* and warnings, and cross-check against the preview-selected files. A `skipped` result is `skipped` (not clean). Missing manifest or ambiguous warnings are incomplete/`partial`, not a green no-findings. Unsupported comment severity remains `unclassified`, never guessed to `minor` or `critical`. Version the JSON output; include engine ID/version, true provider/model if observed, input scope, snapshot hash, findings, coverage, omissions and status. Do **not** fabricate deterministic severity for OCR free text.

**Local credentials:** provider/model configuration is engine-owned: native OCR may read its own user `~/.opencodereview` configuration; RR legacy reads `ConfigLoader`/env. `--engine ocr` must check binary identity/version and installed configuration without leaking secrets. No automatic download/installation; helpful `doctor` instructions. Repository `rule.json` / config may change OCR behavior; treat as untrusted input, disclose which rules were included, do not use repo config to select arbitrary binaries or execute plugins.

## 5. Minimal Clean Architecture (avoid duplicate layers)

```text
bin/mpr -> src/cli/index.ts (argument parsing, usage, presentation)
              |
              v
        LocalReviewRunner (one application function)
          /                        \
  LocalGitSnapshot (Git adapter)   ReviewEngine (2 narrow concrete adapters)
                                /                     \
             LegacyEngine (existing CLIReviewer)    NativeOcrEngine (spawn ocr review)
                            \                        /
                              LocalReviewOutcome (shared DTO)
                                       |
                               terminal / JSON presenter
```

Keep a small `src/local-review/` module or a few files under `src/cli/`; choose the fewer-files layout once code is written. Ports contain **one** `run(request)` and a cancellation signal; do not add a DI container, engine registry, general plugin loading, redundant domain definitions or a second provider discovery stack. Git CLI interactions use `execFile` / `spawn` argv arrays, never shell evaluation. Composition root stays in `src/cli/index.ts`; shared output is a plain typed object. For tests inject narrow functions (Git runner, native subprocess runner), not global mocks.

**Important:** managed OCR's `OcrReviewInvocationAdapter` is tied to Gateway authority, immutable materialization and hosted acceptance. Extract **pure** status normalization helpers only if code reuse is safe; do not rewire the entire hosted T0 orchestration. The OCR native binary's own JSON/manifest is the boundary. If its local output cannot prove expected-file completion at the pinned version, mark partial/unknown, or stop and fix at the supported OCR boundary in a separate approved task; never loosen hosted result acceptance.

## 6. JSON contract and exit behavior

`--format json`: exactly **one** versioned JSON object on stdout; diagnostics to stderr. Bounded source output, no token values or raw `thinking` fields. Example (illustrative):

```json
{
  "schemaVersion": 1,
  "engine": {"id": "ocr", "version": "1.13.1"},
  "status": "complete",
  "input": {"scope": "branch", "base": "<sha>", "head": "<sha>", "snapshotDigest": "sha256:<hex>"},
  "coverage": {"selected": 3, "reviewed": 3, "omitted": [], "complete": true},
  "provider": {"name": "anthropic", "model": "<observed when available>"},
  "findings": [],
  "summary": {"classified": {"critical": 0, "major": 0, "minor": 0}, "unclassified": 0},
  "blocking": false
}
```

Statuses: `complete`, `partial`, `failed`, `stale`, `skipped`. All fields bounded and validated. Treat `complete` as eligible *file coverage*, **not** proof of finding accuracy or a safe merge. Engine output `warnings` may require `partial`, even with process exit 0; `failed`/`stale` never appear as `complete` just because comments array is empty.

Exit codes for new JSON/explicit-engine CLI: `0=complete with no classified blocking finding, or explicit skipped with clear status`, `1=complete with major`, `2=complete with critical`, `3=partial/failed/stale`, `4=bad CLI args, missing engine/auth/config`, `130=interrupted`. Legacy default exit behavior remains compatible; callers **must** read `status` as well as exit code. `unclassified` findings do not get invented severity; report them visibly, and decide gate behavior by a documented policy, not by guessing (default advisory). No `--fail-on` customization in v1.

## 7. Implementation sequence, each as a reviewable commit in **one Draft PR**

**M0 — documentation-first (this commit).** Audit current code, pinned OCR semantics and feature boundary. Include alternatives, constraints and E2E criteria; open Draft PR. Review iterations before code.

**M1 — CLI usability and honest scope.** Strict argument parser, help/version/doctor outside repo, explicit engine & scopes, untracked privacy gate, correct legacy dry-run/config. Preserve positional aliases and existing analytics behavior. No model calls in parser/unit tests. Unit tests first.

**M2 — OCR native adapter, no copy of OCR algorithms.** Explicit binary/version check (trusted PATH / user override only), call upstream native `review` with explicit `--repo/--from/--to/--commit`, `--format json --audience agent`, optionally `--preview`; bounded process/output/cancellation, normalize *pinned* schema. Use existing legacy CLIReviewer for `legacy`. No hosted Gateway or new provider SDK.

**M3 — shared outcome + snapshot completeness.** Bounded pre/post Git fingerprint, complete/partial/stale mapping, normalized finding locations, no false-green on missing/unsupported changes or per-file warnings. Terminal format terse with file/line, JSON one document. Document scope/provider/engine provenance, model disclosure.

**M4 — qualify and release.** Unit (parser/status/bounds) and real Git process E2E (worktree, tracked and untracked gate, staged+unstaged, branch divergence, rename, deletes, empty repo, unborn HEAD, dirty HEAD/stale, changed files during review). Built CLI + isolated executable fake native OCR (`review`/`version`/`preview` contract) on Linux/macOS/Windows via required jobs; `npm pack`/consumer installs; no live credentials in CI. Authorized real OCR smoke with supported binary and user-local auth separately; report as unverified if unavailable. Several review/fix cycles and exact-head required checks. **Only then** merge. Do not run the costly cross-platform suite on every documentation edit if CI permits selective triggers; never skip qualification of final code.

### Gate table

| Gate | Required outcome | Why |
|---|---|---|
| Parser and legacy contract | Deterministic unit + old public CLI smoke | Do not regress users |
| OCR native machine bridge | Pinned-compatible fixture with `complete`, `partial`, `skipped`, `failed`, malformed JSON, huge output and model mismatch | OCR exit-0 alone is insufficient |
| Git scope/input | Real temp Git repos: privacy gate, dirty/worktree, branch, commit, rename, symlink, force stale | No erroneous scope or false green |
| Read-only/user data | Working tree unchanged by ReviewRouter, sanitized output, no credential strings, no shell interpolation | Security and privacy |
| Packaging | Invoking installed `review-router` and `mpr` from packed artifact with correct Node runtime | Usable by users and agents |
| Platforms | Linux, macOS, Windows qualification on final SHA | Pre-push and path behavior varies |
| Live model | Explicitly authorized OCR run, verifiable actual model/coverage and cleanup | Do not label synthetic fixture as live test |
| PR/merge | Reviews addressed, required checks pass on exact head, no unrelated diffs | Safe release |

## 8. Critic rounds and decisions (planning, independently re-evaluate on code changes)

**Round 1 — architecture critic:** Previous plan would rebuild `GitReader`, engine selection and a generic plug-in system while OCR already has worktree/branch/commit. **Correction:** delegate native review algorithm and path selection to OCR; keep one narrow interface, retain legacy CLI for compatibility. No new network service.

**Round 2 — safety critic:** OCR workspace silently includes untracked while legacy default does not; a generic `--engine ocr` would leak new files to a provider without user awareness. **Correction:** explicit untracked consent gate; no silent engine fallback; exact status and revision binding; no false security claim about native process permissions.

**Round 3 — E2E/UX critic:** Native OCR `exit 0` includes warning/partial cases; CLI JSON alone does not prove all selected files reviewed. **Correction:** inspect native manifest/preview and warnings; hard `partial` state, versioned output, privacy-aware `doctor`, no false green; separate live from fake-provider qualification.

**Round 5 — pinned schema critic (post-PR):** Verified the exact pinned Go `internal/session/manifest.go` rather than relying on the current upstream README. **Correction:** validate manifest schema/version, disjoint item sets, preview equality, input SHA, all coverage terminal states and explicit fail-closed semantics; no `success`-without-manifest shortcut.

**Round 4 — scope critic:** Staged-only and pre-push exact-ref behavior cannot be cleanly represented by native OCR's current public flags; adding an isolated checkout/temporary ref machine would greatly expand scope. **Correction:** defer staged-only/outgoing/hook; offer explicit branch/commit/worktree scopes and explain limitations. Hosted Gateway parity and OAuth reuse are separate projects.

## 9. Resource estimate, not an implementation fact

| Deliverable | Approx implementation LOC | Tests / E2E LOC | Complexity / 10 | Benefit / 10 |
|---|---:|---:|---:|---:|
| CLI flags, compatibility, doctor | 180–300 | 200–330 | 4 | 8 |
| OCR binary adapter + schema parsing | 250–500 | 250–420 | 6 | 10 |
| Git revision snapshots/privacy gate | 200–420 | 200–380 | 6 | 9 |
| Outcome mapping, JSON/terminal & exits | 180–320 | 210–350 | 5 | 9 |
| Packaging + cross-platform jobs + docs | 80–180 | 200–400 | 6 | 8 |
| **Total** | **890–1,720** | **1,060–1,880** | **6** | **9** |

**Not in scope** and **not counted:** an OCR-powered staged-only / outgoing materializer, Git hook, SaaS/managed parity, automatic model onboarding or OCR library fork/rewrite. These can each be proposed separately after actual E2E. 1.9k–3.6k total implementation and test LOC is a provisional range; accept an objectively necessary deviation only with evidence, not feature creep.

## 10. Failure modes and handoff

- If the pinned native OCR binary cannot prove selected-file coverage from JSON, stop `complete` reporting and leave `partial`/`skipped` with an actionable message; do not guess or silently switch engines.
- If a required local model is unavailable, return `failed`/usage without altering repo or fetching a provider. No SaaS or hidden credential transfer.
- If output size, time, or filesystem snapshot changes, return bounded `failed`/`stale`; do not treat timeout or cancellation as successful no-findings.
- If CI or native smoke cannot be executed, keep Draft and record exactly which gate lacks evidence. Never merge based on code inspection alone.
- If `main` changes while the PR is open, rebase or merge main with a new exact-head CI; don't override someone else's work.

### Follow-ups (separate decisions, **not** scope of this PR)

1. Optional `review-router hook install pre-push`: exact stdin local/remote refs, `core.hooksPath`, safe coexistence with Husky/Lefthook and real bare-remote Git push E2E; no default AI blocking.
2. Staged-only/outgoing scopes via isolated target snapshot compatible with every engine; first prove correctness and privacy with real Git fixtures.
3. If useful, share pure OCR-result parsing across hosted/local adapters without weakening hosted acceptance; independently qualify a local OAuth/managed integration rather than inventing it.

## 11. Post-implementation critic rounds (2026-11-09, PR #379)

**Round 6 — actual Go contracts and safety.** Cross-checked against *pinned* upstream `v1.13.1` `internal/model/preview.go`, `internal/agent/preview.go`, `internal/session/manifest.go` and `cmd/opencodereview/review_cmd.go`. Confirmed model-free preview lists `files[].will_review` and `reviewable_count`; real manifest lists disjoint `coverage.{selected,completed,reused,failed,waived}`. An unresolved OCR comment can carry `start_line=0`; do not discard the entire review or fabricate a line: retain as file-level finding, report `partial`. Unknown model identity and native warnings also forbid `complete`. These changes are tracked in the implementation, with unit tests.

**Round 7 — platform/integration critic.** Initial three-platform CLI workflow and main CI rejected the first implementation (Node Buffer generic variance; control-character regex lint). Fixed on-branch; also normalized Git-root filesystem paths on Windows and used relative-path containment for opted-in untracked files. Added real-Git stale/privacy tests plus native fake OCR malformed/warning/changed-worktree E2E. Added `npm pack --dry-run` inclusion verification; this is **not** a complete installed-package consumer run. Reuse the main CI's already-required pinned native OCR build for a separate **real binary, model-free preview** qualification rather than building OCR twice.

**Round 8 — API and scope critic.** Preserved legacy explicit `--dry-run`, introduced no engine registry/framework and no hosted adapter bypass, kept engine selection opt-in. Added typed status for cancellation (`130`) versus runtime failure (`3`) versus invalid configuration (`4`). Never claim the local OCR reported provider/model string is independent provider-wire attestation. The native local process inherits user permissions and may use configured rules/tools; it is **not** an OS sandbox. To avoid unjustified assurances, the user documentation explicitly limits the privacy guarantee to the opt-in gate, with a warning about the configured model and local session persistence.

**Round 9 — release gate:** Final merge requires all exact-head CI checks (Linux, macOS, Windows, existing main CI, native pinned preview) to finish green, additional review of actual outputs and PR feedback, and an explicitly authorized real OCR provider review when suitable credentials are present. No such live-model evidence has been claimed. A fake Go executable is a deterministic contract test, not a live-model qualification. Keep Draft until the required evidence is available and conflicts are resolved.

**Round 10 — engine neutrality and actual consumer usability (2026-11-11):** Rechecked the implementation against the original goal: machine JSON was implemented for both engines internally but the CLI still refused legacy JSON. Removed this redundant restriction and added a cross-engine use-case regression, preserving the legacy unqualified `partial` status. Found that the limit for explicitly included untracked files also blocked unrelated tracked-only review in repositories with over 2,000 untracked paths; constrain that cap to the opt-in case. Strengthened the npm test from dry-run archive inventory to a real tarball installation and consumer `help`/`version` smoke (not yet counted as PASS until current CI finishes). All changes stay within local CLI/tests/docs, no model/hosted contracts altered.

### Out-of-scope reaffirmed after implementation

No automatic pre-push hook, staged-only/outgoing snapshot engine, cloud Gateway changes, SaaS changes, default-engine flip, auto-fix, GitHub write paths, local model installer, MCP server, arbitrary engine plug-in registry or repository-wide dependency upgrades. Add those as separate tasks only when justified by real use, not as part of PR #379.
