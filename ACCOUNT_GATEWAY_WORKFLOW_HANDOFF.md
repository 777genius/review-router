# Account gateway workflow source handoff — P78, 2026-10-05

Source guard candidate only, account V, NO FAST. Full D-min/D-final/S/E/F/G remain required; H sharing is deferred. No release or deployment acceptance.

## Authority and scope

The supplied source identity is `cfbac4d73b249619d3669f37aa0674dd55180213` from `.spike-inputs/manifest.json`. Exact launch source must be pinned by primary after integration and qualification. Local Git cannot verify commit/ancestry or produce a trustworthy diff: the linked `.git` points at a missing `p79-action-source/.git/worktrees/p78-workflow-entry`. No Git metadata repair, staging, commit or push was performed.

Contract53 is the sole normative authority. Its observed SHA256 is unchanged: `66a2393e7a55f76df1a78281af44379d0b455a0770d82f34e587dcca284157b0`. The current `ACCOUNT_GATEWAY_ACTION_HANDOFF.md` records primary qualification of the preceding SCM/cancellation remediation: pinned types/build/release metadata and 84 nearest tests passed, with three SCM probes RED/GREEN. Those are supplied prerequisite receipts, not independently rerun or broader gateway acceptance here.

Changed source: the two owned reusable workflows, `src/main.ts` runtime-preflight wiring/output only, and `src/control-plane/provider-cli-plan.ts`. Nearest changes are confined to existing provider-cli-plan and reusable-workflow tests, retaining existing assertions except the embedded script's updated TypeScript import assertion. Runtime-config source/tests, public `action.yml`, admission, relay, checkout, cancellation, kernel/SDK/native, Accounts/Models, dependencies and generated bundles were not edited. SaaS server/renderer implementation and primary source reviews remain separate.

## Entry and authenticated config contract

`codex_session_mode=account-gateway` is an exact declarative entry hint. It never authorizes a run or selects an account/provider policy. The wrapper excludes it from `repository-secret-review` and calls the existing execution reusable workflow through a separate `review-account-gateway` job with no `secrets` mapping, read-only contents/PR permissions and OIDC `id-token: write`. Its static JSON is always `{}`. Hosted binding inputs retain their existing reserved meaning; nonempty binding ID/nonzero version are rejected outside hosted-pool execution.

Gateway preparation requires the T0 lane and `REVIEWROUTER_RUNTIME_CONFIG_MODE=oidc`; static config fails. Only gateway receives `REVIEWROUTER_STATIC_CONFIG_FALLBACK=false`, both in job env and the prepared env. Direct shared-workflow gateway calls reject nonempty static runtime JSON. Other modes retain their previous fallback setting and static settings behavior.

Before gateway runtime-preflight fetches config, it requires OIDC/fallback-false and removes any preexisting `REVIEW_AUTH_MODE`. This makes a missing server mode deny even if a caller had claimed gateway mode. The real existing OIDC session/config application must return `status=applied` and set the exact `REVIEW_AUTH_MODE=codex-account-gateway`. Missing/unknown/skipped/fallback config, a different server auth mode, or enabled fallback denies before provider CLI installation or gateway/rotating/legacy invocation. Gateway server config on a non-gateway workflow entry also denies; it cannot silently route through repository credentials.

Successful gateway runtime-preflight emits string outputs:

| Output                   | Value     |
| ------------------------ | --------- |
| `runtime_config_status`  | `applied` |
| `account_gateway_needed` | `true`    |
| `codex_cli_needed`       | `true`    |
| `codex_oauth_needed`     | `false`   |
| `claude_cli_needed`      | `false`   |

The gateway plan ignores stale provider/model/fallback hints for tooling. Successful ordinary preflight emits `account_gateway_needed=false` and retains its existing tooling plan. Denied gateway preflight throws before emitting eligibility outputs. These outputs authorize no backend capability: the actual gateway runtime still obtains authenticated server admission and checkout capability.

## Executable step and trust boundary

`Run ReviewRouter T0 account gateway` executes `node .reviewrouter-runtime/dist/index.js`. It requires the exact gateway hint, T0 lane, `can_run=true`, preflight `runtime_config_status=applied`, and `account_gateway_needed=true`. Its complete step env is:

| Env                             | Source                                             |
| ------------------------------- | -------------------------------------------------- |
| `REVIEW_ROUTER_MODE`            | `account-gateway`                                  |
| `REVIEWROUTER_ACTION_V2_MODE`   | `t0`                                               |
| `INPUT_API_URL`                 | workflow API/server URL                            |
| `INPUT_CONTROL_PLANE_URL`       | control-plane URL input                            |
| `INPUT_PROVIDER_INSTANCE_ID`    | repository provider selector input                 |
| `INPUT_WORKFLOW_SCHEMA_VERSION` | explicit schema selector input                     |
| `INPUT_MAX_CHANGED_LINES`       | existing changed-line limit input                  |
| `PR_NUMBER`                     | PR event number, otherwise explicit PR input       |
| `REVIEW_HEAD_SHA`               | PR event head, otherwise explicit exact-head input |

Inherited nonsecret settings carry server/control-plane URL, OIDC audience `reviewrouter`, config mode/fallback, immutable action version and the existing execution deadline. GitHub supplies its ephemeral OIDC request env separately to each process. Config preflight's request-env erasure stays in that process and does not erase the later gateway process's OIDC inputs. No upstream/management/execution/native/facade/master key, `CODEX_AUTH_JSON`, `INPUT_AUTH_JSON`, `CODEX_CONFIG_TOML`, OpenAI/OpenRouter key, Claude token, ledger key or SCM mutation token is passed by the gateway wrapper/step.

Caller `runtime_ref` remains a validated compatibility hint. T0 checkout authority is the actual reusable workflow `job.workflow_repository=777genius/review-router` and immutable 40-hex `job.workflow_sha`. Runtime goes into `.reviewrouter-runtime` with persisted checkout credentials disabled. No gateway path first checks out PR code into the workspace/runtime location: the existing gateway runtime obtains server checkout capability and materializes the authorized exact head in isolation. It retains its own server admission, selector/head checks, resource cleanup and App publication; none of those implementations was replaced here.

Gateway eligibility admits PR and PR-target events, plus explicit workflow dispatch with PR/head selected by inputs; the actual server decides authorization. PR-target does not select an untrusted PR checkout or elevate job permissions. Fork PRs can reach authenticated server policy only on gateway mode; repository-secret and hosted-pool fork handling remain unchanged. `merge_group` produces the existing finite non-provider skip/check message and never runs config preflight, CLI install or a review provider. Other gateway event names fail locally. Backend rejection of wrong explicit provider/schema selectors is required; this patch forwards the selectors and makes no client-side grant or substituted schema.

## Compatibility and regression boundaries

- Empty mode retains repository-owned T0 rotating execution and its current secret inputs. Legacy standalone OpenAI/OpenRouter BYOK and legacy Codex OAuth retain their prior plans, restoration and execution paths. Gateway cannot reach those paths. G retirement is later.
- The hosted-pool wrapper job, binding validation, isolated `.reviewrouter-pr` checkout and `action-dist/index.cjs` execution are retained. Its preflight exclusion is retained. No unrelated public wrapper caller is redirected and no duplicate launcher is added.
- Gateway repositories that still return rotating/BYOK/no auth mode now fail deliberately. Config outages cannot use static provider credentials. A configured gateway repository with a caller missing the gateway hint fails deliberately. The renderer lane must later emit the exact mode with the saved server binding policy.
- Gateway callers cannot customize static runtime JSON: the wrapper supplies `{}`, and direct gateway execution rejects nonempty JSON. Gateway account/provider/model/limits decisions stay on the server. Valid non-gateway static semantics are retained.
- Gateway tooling requires Codex CLI without OAuth restoration or Claude installation, even when old model/provider hints remain. The existing pinned `@openai/codex@0.147.0` install and gateway's runtime binary qualification remain; no version/dependency change was made.
- The existing preparation script is now embedded TypeScript. Pinned Node major 24 setup moves before preparation so it never relies on runner-default Node supporting TypeScript stdin. This adds Node setup to skipped contexts, but no provider/config/App call to merge queues or blocked legacy forks. Primary must typecheck the extracted `.mts` script in addition to project types; stripping is not typechecking.
- Exact gateway mode with surrounding whitespace denies before execution. Existing non-gateway trimming is retained. Workflow repository/SHA authority and server fork/event/head/attempt decisions remain mandatory, regardless of caller hints.

## Evidence and remaining qualification

Local Node is v24.21.0. The actual parsed preparation script executed successfully across 16 local cases: gateway fork/PR-target/dispatch, finite merge-group skip, legacy/rotating fork handling, static/legacy/unrelated-event gateway denial, static-auth claim denial, invalid source repository/SHA, whitespace gateway denial, standalone BYOK/rotating same-repository compatibility, and hosted same-repository/fork cases. Evaluating the actual parsed checkout/execution predicates with gateway inputs selected only the trusted runtime checkout and excluded rotating, legacy and hosted execution. Parsed wrapper/step checks confirmed exact mode forwarding, no gateway secret mapping and the nine-key step env above.

Native execution of the current provider-plan source passed: caller auth claim erasure/missing server mode denial, applied gateway tooling, four wrong auth modes, unknown/skipped/fallback config, static/fallback denial, entry-mode mismatch and four ordinary standalone auth plans. These are local policy/script observations, not real project agent/smoke, provider/App or GitHub workflow acceptance. No credential fixtures or external provider/App calls were used.

**NOT_RUN:** full meaningful TypeScript checking, nearest Jest suites and formatter. `npm run typecheck`, the targeted three-suite Jest command, and `tsc --noEmit` were attempted; npm/tsc/Jest and installed dependencies are unavailable in this isolated workspace. Native stripping checks cannot replace those gates. No dependency install or generated `dist` build was attempted. The retained reusable-workflow tracked-bundle assertion also requires a functioning Git checkout at primary.

Primary must pin integrated source, run full project types, extract the embedded preparation script as `.mts` and typecheck its Node/process/env/filesystem contracts, run the provider-cli-plan/runtime-config/reusable-workflow suites, format/lint/full CI, build the public runtime and check genuine release metadata. Then apply the whole-blob export guard and independent exact-source `gpt-6.1-sol/xhigh/default` review. The writer lane remains requested `gpt-6.1-sol/high/default`, V only, NO FAST.

Remaining real CI qualification includes the saved-policy renderer/server wiring; no-key runtime and tool environment; real allowed/denied forks/events/dispatches and exact head/attempt mismatch; wrong provider/schema selector denial; config absence/wrong auth mode without downgrade; real tools, final answer, parser and App-authored advisory/inline publication; cancellation/renewal/status/close and measured cleanup/retention/long-OIDC behavior. Missing final answer cannot be counted as success. Full D-min/D-final/S/E/F/G remain required, H deferred. Source patch is left for Project Integration apply/commit/push; no release was performed.

## Continuation audit — 2026-10-05

The nearest retained reusable-workflow test now reads the actual preparation env output and asserts forced gateway fallback false. It also evaluates the current parsed checkout predicates for exact gateway/T0 inputs, proves that only the trusted runtime checkout is selected, and checks Node setup precedes preparation. This executes the simple checkout-expression subset locally; it does not substitute for GitHub's full workflow parser or authorization policy. A native TypeScript execution of these same current-source observations passed. Meaningful checking of the new Node helper was attempted with strict `tsc --noEmit`, NodeNext and Node types; the compiler is still absent. Project types/Jest remain NOT_RUN, and installed dependencies remain unavailable.

The completion audit found a specific unresolved selector qualification gap. The current gateway runtime accepts the parsed `providerInstanceId` and `workflowSchemaVersion` in its input type, but does not transmit those fields to authorization. `ReviewActionV2ControlPlaneAdapter.authorize` sends OIDC plus supported protocols. The current generated `review_run_authorize` request schema permits only `protocolVersion`, `schemaDigest`, `requestId`, `oidcToken`, and `supportedProtocols`, with additional properties forbidden; client transport adds no selector headers. Workflow env forwarding alone therefore does not prove the required backend denial of an explicit wrong provider/schema selector.

The server lane must demonstrate that its authenticated registration/pinned-workflow validation checks the actual explicit selectors, including denial cases. If it does not, a separately owned contract/runtime/server companion change is required; adding unrecognized fields or a client-only substitute would violate the current schema and this packet's ownership. Admission, runtime gateway, generated SDK/schema and backend files were inspected for this audit but not edited. No backend/provider/App request was made. The full goal remains unproven until this gate and the already listed primary qualification gates have authoritative evidence.

The next continuation revalidated the primary build/qualification dependency. There are still no installed dependencies or npm/tsc/gh executables. The current public `dist/index.js` retains its old `runRuntimePreflight`, which calls `resolveProviderCliPlan` and emits only config-status/Codex/Claude tooling outputs; it does not emit `account_gateway_needed`. Consequently the new gateway step cannot be selected with this current generated artifact. This is an observed executable gap, not a build result. Primary must regenerate and qualify the runtime from the integrated, pinned source; the worker is explicitly prohibited from generating dist. The source patch and retained tests remain in place. The repeated external primary-build/qualification dependency now prevents further authorized completion; no additional runtime/admission/SDK changes or provider/App/real CI calls were attempted.

## Primary qualification at the exact candidate
- Node 24.21.0 / pinned TypeScript 5.9.3: full source/test typecheck PASS.
- Embedded workflow preparation: extracted actual TypeScript, strict NodeNext typecheck PASS after explicit environment/value narrowing.
- Nearest existing suites: 41 PASS, 0 FAIL, 0 SKIP; workflow suite repeated after the type fix PASS.
- Production build PASS. Final tracked Action artifacts rebuilt with the standard nonminified script and preserve-symlinks for the existing pinned qualification dependency link; unchanged context-gateway artifact and metadata match parent exactly.
- No provider/App/GitHub OIDC end-to-end execution yet. Explicit provider/schema selector transmission still needs its paired server/Action companion before D-min acceptance.
