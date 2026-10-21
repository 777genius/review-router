# Account-gateway re-dispatch safety

A POST may have reached application admission and paid inference even when its
socket closes before response headers arrive. A proxy can also return a bare
502/504 after dispatch. Absence of `x-reviewrouter-request-ref` is not positive
evidence that the request was never dispatched.

The transport retries only a fully drained HTTP503 response with no request
reference, JSON content type, and the exact closed envelope
`{"error":{"code":"relay_saturated","effect":"not_dispatched"}}`. The existing
128-wait/120-second budget and cancellation bounds apply. Direct OpenRouter
never interprets this Gateway-only admission response or retries inference.

All socket errors, bare502/504, referenced responses, started-stream failures,
malformed/truncated denials and aborts remain terminal unknown outcomes. No
transport-error retry, guessed preconnect classification or missing-header
inference authorizes another POST. The orchestration attempt budget is unchanged.

The prior request-stage and ref-less edge retry policy was unsafe and is
superseded by this positive-evidence rule. No idempotency guarantee was present
on those POSTs. Closed diagnostic fields remain available without tokens, raw
bodies or model content.

The existing real-TLS tests count accepted requests before deliberately losing
headers, return an unreferenced proxy504, preserve positive closed503 recovery,
and retain referenced/mid-stream terminal and cancellation checks.
