# Paired account gateway Action handoff

Supplied Action base: `777genius/review-router@00578a65ab90563a3f4e35ae2366494eb1f757f9`.
Supplied backend source: `d9300bcedafe5f98f926a94496e33cd5faa93ce5`.
Observed frozen contract SHA256: `66a2393e7a55f76df1a78281af44379d0b455a0770d82f34e587dcca284157b0` (matches manifest).
Observed preparation SHA256: `6a0e94d98add7230ee7062fdba56901c20266b32996bdbfa3aaa0d29b719738c`.
Observed relay SHA256: `7d267013ab276efafe48962fc40839ca472f65c52e8a02be9578eb20bdcb35b8`.
Git identity/status could not be independently inspected: the linked `.git` target is unavailable in this sandbox. No git mutations.

Changed paths (only manifest-owned paths):
- `src/providers/codex.ts`
- `src/codex-oauth/action.ts`
- `src/codex-oauth/runtime.ts`
- `src/codex-oauth/account-gateway-runtime.ts`
- `src/review-orchestration/infrastructure/production-t0-review-runner.ts`
- `src/review-orchestration/infrastructure/review-action-v2-control-plane-adapter.ts`
- `src/review-orchestration/infrastructure/account-gateway-model-transport.ts`
- `__tests__/unit/providers/codex-provider.test.ts`
- `__tests__/unit/review-orchestration/production-t0-review-runner.test.ts`
- `ACCOUNT_GATEWAY_ACTION_HANDOFF.md`

Finite source status: consumer implemented; compilation and behavioral execution unverified because the pinned toolchain is absent.
Select `mode: account-gateway` with the existing T0 v2 activation and OIDC configuration. Static/non-T0 selection fails closed.
The existing main dispatch predicate admits this mode; the Action branches before rotating setup-preview, prelease, auth read, refresh, finalize and writeback.
Fresh isolated CODEX_HOME contains only generated transport config, never dummy auth.json. Isolated checkout/prepared CLI/App publication are reused.
Responses use the exact existing `/api/action/v2/account-gateway/responses` route, ordinary JSON bytes and current run authorization.
The optional loopback bridge only forwards POST /responses; another agent can use AccountGatewayModelTransport.responses directly.
No private gateway SDK/control credentials, upstream-key injection, account selector, routing override or protocol conversion.
Only the backend performs LOCAL admission waits. All non-stream statuses (including 202/429), transport failure and cancellation latch inference denial.
Recover is explicit same-operation POST /recover only; GET /requests/:requestRef is readback only. Neither resets inference denial or submits inference.
T0 attempt budget is one; optional provider rereview and CLI request/stream retries are disabled only in gateway mode.
The original investigation app-server/context/tools/parser path also receives the same provider config and local capability.
Gateway exec requires a nonempty final-message file and rejects failed processes even with valid partial JSON.
Exec actualModel remains absent; the existing investigation string DTO uses explicit `unknown`, never the configured model as executed-model proof.
Terminal review/App publication and terminal status/advisory finish before readback and close, including failure and early-return exits.
Close/readback use the adapter's renewed current token. Unknown/404/error never certify no effect or released occupancy; only close operation state is reported.
SIGINT/SIGTERM deny further inference and abort held streams. Existing execution/lease/revision orchestration remains authoritative.

Required backend companion (not present in frozen relay/preparation; legacy checkout requires rotating leaseId):
- Add exactly `POST /api/action/v2/account-gateway/checkout`, JSON `{}`, Bearer = current ReviewActionV2 run token.
- Request/response types: AccountGatewayCheckoutRequest / AccountGatewayCheckoutCapability in account-gateway-runtime.ts.
- 200 response: `{protocolVersion:1, repository, headSha, token, expiresAt, permissions:{contents:"read",pullRequests:"read"}}`.
- Resolve live run authorization, saved repository/approved head/run/attempt and existing fork/event/membership/App policies server-side.
- Mint an existing repository-scoped App read capability with actual issuer expiry; no provider/admin secrets or publication permissions.
- Do not trust caller job headers, repository/head/account fields or fabricated expiry. The request has no such fields.
- Refresh uses this same route and current renewed token. Client requires exact repository/head, read-only permissions and >30 seconds remaining validity.
- Route absence/invalid response is terminal failure and attempted gateway close; never rotating-pool fallback.
Primary must separately select this entry in generated/reusable workflows and supply the server's gateway configuration through existing runtime-config composition.
Workflow/release/generated/backend files are outside this packet's ownership.

Codex pin inspected: `@openai/codex@0.147.0`, upstream tag commit `be6e8eac029b183056b7e4402879f15d2c85f61b`.
[Provider fields](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/model-provider-info/src/lib.rs), [HTTP retry loop](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/codex-client/src/retry.rs), [stream retry handling](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/core/src/responses_retry.rs).
Verified source knobs: request_max_retries=0, stream_max_retries=0, supports_websockets=false, requires_openai_auth=false; zero permits the initial HTTP attempt only.
Local capability uses env_http_headers.Authorization; no env_key. service_tier is explicitly default. Runtime checks exact binary version before inference.

Enforced consumer ceilings (not qualified production settings): request/prompt 16,777,216 B; SSE/final output 1,048,576 B; JSON readback/error 65,536 B.
Headers 16,384 B; stream high-water mark 65,536 B (not a measured total RSS cap); CLI stdout+stderr 8,388,608 B.
Model hop/CLI invocation <=3,600,000 ms; stream/socket idle 60,000 ms; readback/close/checkout each 30,000 ms; local headers 10,000 ms.
Loopback: 256-bit random per-run capability, 127.0.0.1 only, <=4 connections, one inference in flight, one request/socket, keepalive 1,000 ms.
Backend saved profile/model/account/epoch/five limits/run deadline remain authoritative and can be narrower. No client wait budget or deadline extension.
D-final measured memory/cgroup/cleanup SLO/retention/long-OIDC acceptance remain unqualified.

Performed: frozen input digests checked; pinned upstream source inspected; Node 24.21 syntax checks on all nine changed TS files succeeded.
Syntax command: `node --experimental-transform-types --check <each changed .ts>`; this does NOT typecheck contracts or execute behavioral tests.
NOT_RUN: `npm run typecheck`; `npm test -- --runInBand __tests__/unit/providers/codex-provider.test.ts __tests__/unit/review-orchestration/production-t0-review-runner.test.ts`.
Both attempts stopped before execution: npm/tsc/Jest/node_modules absent. No dependencies installed or toolchain rebuilt.
Focused behavioral cases extend existing provider/T0 checks: gateway rereview would be red if two execs occur; failed/empty final would be red if accepted.
Model/env case would be red on an asserted configured model, missing local capability or upstream key entering CLI; attempt policy would be red above one attempt.
Checkout case would be red on missing expiry, changed repo/head or write permissions. No new harness, provider probe or runtime project was executed.
NOT_RUN: actual Codex tools/final/parser/App/no-key CI, allowed/denied forks/events, stream cancellation/renewal/status/close scenarios and D-min/D-final/S/E/F/G qualification.
Primary qualifies these on explicitly disposable GitHub fixtures; H sharing is deferred. Existing explicit non-gateway behavior remains until authorized G retirement.
No product E2E, release, approval, deployment, paid-provider or independent-review acceptance is claimed. Primary identity applies/commits and arranges separate 6.1/xhigh review.

## Primary source-only export correction
The runtime whole-blob guard rejected legacy public synthetic redaction fixtures in the preimage of the existing provider unit file (base Git blob801b17ee30593071c231e5de7595b8af6b738584, independently equal to GitHub tree00578). Runtime also flagged newly added static loopback capability literals. No real credential files were supplied or read.
The unqualified worker changes in both unit files are retained privately on the host with exact SHA256 and excluded from this source-only candidate. Existing committed unit files remain byte-for-byte unchanged. This candidate must still pass the normal whole-blob export guard, meaningful types/build and independent source review.
No unit-result or full E2E acceptance is claimed. The same observable gateway behaviors remain required at the actual process/HTTP/provider/App boundary. Production source scope and full contract53 are unchanged.

## Primary qualification 2026-10-04

Source-only guarded export excludes the two unaccepted unit-test deltas; their original bytes are preserved privately on the producer host. Existing committed tests remain unchanged. Primary reused the optional progress publisher contract and normalizes its absent reporter to null at the terminal helper.

Pinned Node24.21 / TypeScript5.9.3: meaningful full project typecheck exit0, Action main esbuild exit0, changed-source format check exit0 (formatter required a second pass for convergence). The two existing provider/T0 runner Jest suites passed before this mechanical nullable fix; they are baseline regression evidence, not gateway wire/provider qualification. Exact p56 receipts are retained with the isolated qualification fixture.

Backend checkout integration, real process/HTTP refusal and keylessness checks, real MiMo tools/nonempty final/parser/same-head App publication, cancellation and memory/long-run gates remain NOT_RUN. No full product E2E, readiness or release claim.


## P62 finite P58 P1/P2 source correction — 2026-10-04

Supplied paired Action source: `2891a89279db580477c7f4325544838db6df2a2a` (exact289), following supplied original base `00578a65ab90563a3f4e35ae2366494eb1f757f9`. All nine initial owned-path SHA256 values matched the immutable `.spike-inputs/manifest.json`; exact commit/ancestry remains primary-supplied because linked gitdir inspection failed. Existing outside edits were not reverted. Contract53 remains the sole full normative authority, unchanged SHA256 `66a2393e7a55f76df1a78281af44379d0b455a0770d82f34e587dcca284157b0`. The frozen P58 report remains byte-for-byte unchanged, SHA256 `7fe2167d9da059c4d79f46d986625690cde9b8613365bf8269f7c9e0c2f2ee8d`; its original disposition is **CHANGES_REQUIRED**. This candidate addresses its two findings; primary qualification and independent review remain outstanding.

Actual scope: eight existing TypeScript source paths, **400 additions + 100 deletions = 500 source A+D**, plus this existing handoff. All nine changed paths belong to the immutable ownership manifest. No SDK/kernel/backend/UI/workflow/generated bundle, provider implementation, existing test, test hook, corpus or coverage changes. Account-v, noFAST. No source work beyond P58 P1/P2 is requested by this packet.

| Source path | A | D |
| --- | ---: | ---: |
| `src/codex-oauth/account-gateway-runtime.ts` | 75 | 28 |
| `src/codex-oauth/runtime.ts` | 1 | 0 |
| `src/codex-oauth/action.ts` | 81 | 21 |
| `src/codex-oauth/safe-checkout.ts` | 59 | 13 |
| `src/codex-oauth/codex-cli.ts` | 62 | 22 |
| `src/review-orchestration/infrastructure/production-t0-review-runner.ts` | 43 | 6 |
| `src/review-orchestration/application/run-t0-review-orchestration.ts` | 39 | 7 |
| `src/review-orchestration/infrastructure/account-gateway-model-transport.ts` | 40 | 3 |

P1 composition: one run AbortController receives SIGINT/SIGTERM throughout runtime and cleanup. Its signal travels in the existing gateway runner input into T0 dependencies and the existing lease/invocation signal; CodexProvider's existing prepared execution cancellation and investigation recording/app-server cancellation are reused. Cancellation denies inference immediately. Normal OIDC/config/control HTTP attempts, including existing retries, receive native composed AbortSignals and a 30,000 ms deadline. Normal authorization/lease renewal, finalization, App publication and publication polling are stopped at cancellation boundaries. A lease-supervisor failure drains its invocation promise before resource cleanup proceeds. The runner and runtime check cancellation after awaited work, including after the last model response; cancellation bypasses normal terminal completion. Completed status uses the cancellable grant channel and terminal checks. Queued normal/complete CI progress snapshots check the same run signal when their publisher starts. Cancellation terminal reporting uses a separate bounded grant channel and the existing saved OIDC snapshot; it never fabricates pull-request closure.

Bootstrap bounds: checkout capability reads use run cancellation with the existing 30,000 ms HTTP bound. Gateway checkout Git commands kill their owned POSIX process group on cancellation or a 60,000 ms per-command deadline, and wait for actual subprocess close. CLI qualification/install use run cancellation, existing 10,000 ms version probes and 300,000 ms install deadline; gateway npm/CLI preparation kills its owned POSIX group and waits for close before deleting its install root. Cancelled probes do not fall through into installation. Runner Git HEAD/materialization reuse supported execFile cancellation with SIGKILL and 10,000/60,000 ms deadlines; GitHub reads reuse the Octokit request signal/30,000 ms timeout seam. Callers outside gateway mode keep the existing unsignalled paths; shared preparation now attempts failed-install cleanup and waits for subprocess close after timeout.

Cleanup and truthfulness: lease release, investigation turn abort and explicitly failed context seals keep a bounded control channel independent of run cancellation. Safe failure/cancel reporting finishes before gateway readback/close. Gateway readback and close retain their separate 30,000 ms bounds and current renewed authorization; cancellation never aborts that channel. Unknown/error/404 remains unknown, and close only reports its actual operation state. An already entered external effect may apply after local cancellation; no replay, rollback, publication erasure or released occupancy is invented. An authorization request with no accepted response has no known authorization to close. Existing provider termination semantics and already entered GitHub advisory/status operations remain truthful; their final effect and total cleanup SLO require primary observation. Ordinary filesystem calls have no cancellable deadline; unsupported stalled filesystem operations are not claimed cleaned. POSIX group kill cannot certify termination of a deliberately escaped descendant; Windows fallback kills the direct child. D-final remains required for process/memory/retention/cleanup limits.

P2 composition: both public gateway entry and runtime have unconditional nested finally auth scrub, covering activation/input/constructor and authorize/checkout/CLI/config failures. OIDC request URL/token and process/provider auth inputs are cleared with the existing helpers after terminal reporting and attempted cleanup. The existing terminal OIDC snapshot remains available to report early failure. Bridge disposal, CODEX_HOME removal, checkout removal and CLI removal are attempted separately; a failure does not skip later cleanup or final environment scrub. Git workspace/home and failed CLI-install removal preserve the original failure. Removal failure emits an unconfirmed warning; a successful run acquires a cleanup failure exit instead of an erasure claim. An existing primary failure is preserved.

All commands below used cwd `/srv/workers/jobs/review-router/mimo-openrouter-v1/repos/gateway-action-v/workspaces/p62-action-cancellation`.

- Input/preimage verification: inline `python3 - <<'PY'` loaded the immutable manifest, computed SHA256 for each of its nine initial owned paths, compared each expected hash and saved review preimages under the worker artifact directory; all nine MATCH, exit 0. `sha256sum .spike-inputs/*` recorded unchanged Contract53/P58/p56 input digests, exit 0. Final inline Python scope/hash/patch validation rechecks these exact digests and changed-path A/D counts against saved preimages.
- Pinned syntax only: `/opt/nodejs/node-v24.21.0-linux-x64/bin/node --experimental-transform-types --check <path>` issued separately for each of the eight TypeScript paths in the table, every exit 0. Node version `v24.21.0`. These checks do **not** typecheck contracts or execute regression behavior.
- Fulltypes **NOT_RUN**: `npm run typecheck` launcher exit 127 (`npm` absent). Direct `/opt/nodejs/node-v24.21.0-linux-x64/bin/node node_modules/typescript/bin/tsc --noEmit` launcher exit 1 (`MODULE_NOT_FOUND`); compiler and project dependency types absent. No meaningful typechecking result is claimed.
- Action source build **NOT_RUN**: `./node_modules/.bin/esbuild src/main.ts --bundle --platform=node --target=node24 --outfile=/srv/worker-state/jobs/review-router/mimo-openrouter-v1/gateway-action-v/jobs/review-router-mimo-openrouter-v1-v-p62-action-cancellation/tmp/agent/p62-main.js --external:tree-sitter --external:tree-sitter-*` launcher exit 127; esbuild absent. No generated bundle written.
- Format **NOT_RUN**: `/opt/nodejs/node-v24.21.0-linux-x64/bin/node node_modules/prettier/bin/prettier.cjs --check` followed by all eight source paths in the table, launcher exit 1 (`MODULE_NOT_FOUND`); formatter absent. Manual source edits do not establish format PASS.
- Git inspection: `git status --short`, exit 128; linked gitdir unavailable. No git add/commit/push attempted.

The supplied p56 pinned Node24.21/TS5.9.3 fulltypes/build/format PASS receipt applies to the unchanged exact289 preimage, not this candidate. No dependencies installed, new helper scripts/tests written, or provider/project/agent process, live credentials, paid canary, GitHub mutation or deployment exercised. Actual process/HTTP cancellation after the final response and early failure/auth erasure remain **NOT_RUN here**; primary owns their nearest real qualification, generated runtime, backend and UI. Normal whole-blob export guard, pinned meaningful types/build/format and independent 6.1/xhigh source review remain primary handoff gates.

Full D-min, D-final, S, E, F and G remain required; H sharing is deferred. No readiness, workflow integration, release or deployment acceptance. Finite worker output is the manifest-scoped source diff and this handoff; primary applies/commits with iliya owner identity after checks and independent review.

Manifest/preimage/input guard: PASS, exit 0. Scope-guarded patch: `/srv/worker-state/jobs/review-router/mimo-openrouter-v1/gateway-action-v/jobs/review-router-mimo-openrouter-v1-v-p62-action-cancellation/tmp/agent/p62-action-cancellation.patch`; SHA256 and exact path counts are in `/srv/worker-state/jobs/review-router/mimo-openrouter-v1/gateway-action-v/jobs/review-router-mimo-openrouter-v1-v-p62-action-cancellation/tmp/agent/p62-action-cancellation-receipt.json`. This guard checks exported diff ownership and immutable preimages/inputs; the primary whole-blob export guard remains NOT_RUN here.

P70 finite P67 remediation handoff (2026-10-05)
Supplied exact source/runtime candidate: 348527d7e62dd29418b9805c930c0ce56a0fe911; source is the supplied d51 preimage.
Observed: every initial owned source/input digest matched the frozen manifest; linked gitdir unavailable (git status exit 128), so commit/ancestry are supplied.
Contract53 unchanged: 66a2393e7a55f76df1a78281af44379d0b455a0770d82f34e587dcca284157b0. Whole P67 and existing production ports were read.
Scope: seven source files, one 180-line Jest integration/typed compiled-main observer, this handoff; source patch 271 A + 75 D = 346.
Unneeded owned paths unchanged: account-gateway-runtime.ts, runtime.ts, safe-checkout.ts, codex-cli.ts.
No workflow/generated/backend/UI/SDK/kernel/native/platform/dependency/DI/outbox/scheduler or legacy-retirement changes; no release.
GitHub: optional run signal/request timeout reaches both production Octokit adapters, fetch/retry boundaries and each list-to-mutation gate.
Failure/cancellation uses its own 10-second reporting signal; actual GitHub requests are bounded separately from OIDC/session acquisition.
Normal cancelled work cannot begin another mutation or append a completed summary; entered writes are not rolled back or declared absent.
Progress cancellation replaces queued/suppressed completion and drains an ordered cancellation snapshot through the independent publisher.
Gateway Codex abort/timeout/output cap retains the first error, kills its owned group and settles on child close before temporary-file cleanup.
Runner Git materialization (ordinary fetch helpers included) and head inspection use owned group kill and close drain.
Both revision monitors retain/join their promises and wake cancellable existing delays; in-flight bounded revision reads are joined.
Main selects the gateway scrub boundary before activation/handoff validation, after reporting; T0 SCM checks and authorization remain.
New nearest probe: actual localhost HTTP through existing GitHub/Octokit ports; late held lists for active/queued completion and terminal clear.
Assertions: zero normal mutations after abort, cancelled progress and terminal status on the independent channel, no late completed summary.
Owned shell leader/tool and separately owned pipe holder prove public Codex promise/tempfile/resource ordering for abort, timeout and output cap.
The holder is explicitly released/terminated by the test; no escaped-child termination or Windows group certification is claimed.
Compiled src/main.ts executes in a bounded fresh child; the typed observer creates nonsecret sentinels at runtime and observes same-process cleanup.
Expected old-source failures: late list starts normal create/delete; terminal latch suppresses cancelled progress; immediate rejection removes prompt/resource before close; main retains activation-failure auth names.
The tests deliberately allow the normal late list to return, so transport abort alone cannot satisfy the mutation-boundary assertions.
Limits: this nearest probe does not certify the production Octokit timeout wiring, actual orchestration lease release, Git-fetch teardown, monitor drain or whole gateway lifecycle.
Frozen P62 proves only real HTTP normal abort/cleanup and early public-entry scrub (P2 exact289 RED left four keys; GREEN cleared them).
P62 does not prove source-main/CLI/terminal GitHub; its prior exact-d51 type/build/metadata exits 0 are historical, not validation of this patch.
All commands used cwd /srv/workers/jobs/review-router/mimo-openrouter-v1/repos/gateway-action-v/workspaces/p70-lifecycle-fix.
Runtime prefix below: /opt/nodejs/node-v24.21.0-linux-x64/bin/node (Node 24.21.0).
Executed npm run typecheck: launcher exit 127, npm absent. No installation attempted.
Executed node node_modules/typescript/bin/tsc --noEmit: launcher exit 1, MODULE_NOT_FOUND; meaningful contract typecheck NOT_RUN.
Executed node node_modules/jest/bin/jest.js --runInBand __tests__/integration/account-gateway-lifecycle.test.ts: launcher exit 1, MODULE_NOT_FOUND; actual regressions NOT_RUN.
Executed node node_modules/prettier/bin/prettier.cjs --check [the seven changed source paths plus the test]: launcher exit 1, MODULE_NOT_FOUND; format NOT_RUN.
Executed node node_modules/esbuild/bin/esbuild src/main.ts --bundle --platform=node --target=node24 --external:tree-sitter --external:tree-sitter-* --outfile=/tmp/p70-lifecycle-fix-artifacts/main.cjs: launcher exit 1, MODULE_NOT_FOUND; build NOT_RUN.
Full exact command arrays, initial/current hashes and scope counts are retained in p70-lifecycle-fix-receipt.json beside the raw guarded patch.
Source SHA256 src/main.ts: 0a97be3b26412646cf0fa0454650f7890724ab6ce1f54cce1bbdcc72f4b6f66d
Source SHA256 src/providers/codex.ts: 74d74f162e1e6712ad33bf029fb85848be9fe0034cba7d910c77f96e45dcff24
Source SHA256 src/codex-oauth/action.ts: 85cd885e6b37eb62361db8bbf9d83f8ba0fc94c5c736cb71e2dec083960e43a1
Source SHA256 src/codex-oauth/ci-review-progress.ts: c2b8962a5d39fc6204f5203bd357bb9b2ac7f9acca313764976ecf43d7c3c208
Source SHA256 src/codex-oauth/terminal-outcome-publication.ts: 6d5c30687892d6c9e47d23442313668e69841922ca6940ebf67cb8f10f989521
Source SHA256 src/review-orchestration/application/run-t0-review-orchestration.ts: 4a14f77dd63f2d7c20f5c15a2883bf0ffca747b43bb3c0eca5d7e9367797b922
Source SHA256 src/review-orchestration/infrastructure/production-t0-review-runner.ts: 6c311e480e6cd8605d3b3d3f77f8f7e728b2f2ad65cd091e304a0ec4c5634efc
Probe SHA256: c000febd16612eddb75a84863ae2677236999968e515740881e976845df0ddb6
Primary owns hosting RED-old/GREEN-new, full meaningful types/build/format/metadata and independent 6.1/xhigh review; no PASS/E2E acceptance claimed here.
Full D-min/D-final/S/E/F/G remain required, H deferred; Accounts P68 and backend checkout remain separate.
Artifacts: /srv/worker-state/jobs/review-router/mimo-openrouter-v1/gateway-action-v/jobs/review-router-mimo-openrouter-v1-v-p70-lifecycle-fix/tmp/agent/p70-lifecycle-fix-artifacts/{p70-lifecycle-fix.patch,p70-lifecycle-fix-receipt.json}.
Workspace diff remains intact for Project Integration; no git add/commit/push, credential/GitHub/provider/deploy action or other-worker revert.

Primary qualification 2026-10-05: full pinned TypeScript, build and actual release
metadata check PASS. Six nearest real HTTP/owned-process/compiled-main scenarios
PASS, zero skips. Abort/timeout/output-cap wait for child close before prompt/resource
cleanup; late normal lists cannot mutate, independent cancellation publishes, and
source main invalid activation clears same-process auth names. Primary found and
fixed a real bound-argument hook defect: mutate original Octokit request options
instead of passing a clone ignored by the inner hook. Real transport abort and
request deadline are exercised; raw P70 factory with the new test RED, fixed GREEN.
Fixture routing now mutates the bound request object, ESRCH is an exited /proc
process, and native DOMException assertions use their stable names. Initial
failures retained. Source and committed runtime rebuilt together. Independent
current source review pending; no actual provider/App/full workflow or complete
orchestration lease/materializer/monitor lifecycle qualification is claimed.
