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
