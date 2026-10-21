# Account-gateway transient re-dispatch (ADR)

## Context

Provider runs on the `ocr/ocr-managed-v2` (account-gateway) path carry a T0
attempt budget of one. A transient failure that never entered the application —
an edge rejection such as `502`/`504` without an `x-reviewrouter-request-ref`
header, or a request-stage socket failure (`ECONNRESET`, `ECONNREFUSED`, …) —
burned that single attempt and produced `work_slot_exhausted` /
`coverage_manifest_missing` → "Review incomplete" (the PR 573 run class).
"Unknown effects are not replayed" (PR 287) already forbids replaying anything
the application may have entered; it says nothing about failures that provably
never reached it.

## Decision

`AccountGatewayModelTransport.responses()` re-dispatches only failures that are
provably before application dispatch, inside one bounded transient budget
(3 retries, delays 1s/2s/4s, shared across both classes and bounded by the
existing 120s wait budget):

- request-stage socket failures with `ECONNABORTED`, `ECONNREFUSED`,
  `ECONNRESET`, `EPIPE`, `ETIMEDOUT`, `ENOTFOUND`, `EAI_AGAIN`, `EHOSTUNREACH`
  or `ENETUNREACH` (never `AbortError`);
- `502`/`504` rejections carrying no `x-reviewrouter-request-ref` header.

The gateway assigns request references at admission, so a request without a
reference is provable non-entry and a re-POST cannot duplicate an unknown
effect.

## Unchanged terminal semantics

Any request reference; any started stream (a mid-stream death stays terminal);
non-attested `503` (unknown/malformed/non-saturated/referenced); truncated or
over-bound denial drainage; caller abort; `4xx`; every other response-stage
unknown effect. The relay-saturated `503` wait loop (128 waits / 120s budget)
is untouched, and the T0 attempt budget remains one at the orchestration layer.

## Consequences

- Worst case: a ref-less failure that followed application entry duplicates one
  inference billed to the same grant. Both dispatches are recorded and the run
  still settles terminally after the budget.
- Every failed dispatch records a closed diagnostic (`upstream_request` /
  `upstream_headers`, `responseReceived`, `httpStatus`, `errorCategory`) and
  nothing raw — no bodies, hosts or tokens.
- The final failed status and body are still forwarded to the consumer
  unchanged after the budget is exhausted.

## Evidence

- `__tests__/integration/account-gateway-transient-retry.test.ts` — red/green
  pair: ref-less `502` and request-stage connect failure recover the stream;
  a referenced rejection and a started stream stay terminal after one attempt.
- `__tests__/integration/account-gateway-terminal-cancellation.test.ts` —
  persistent ref-less `502`/socket failures settle after exactly 1 + 3
  dispatches with one closed diagnostic per attempt; all non-attested `503`,
  abort, saturation and follow-up pins unchanged.
