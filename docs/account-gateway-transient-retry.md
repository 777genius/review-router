# Account-gateway re-dispatch safety

A POST may have reached application admission and paid inference even when its
socket closes before response headers arrive. A proxy can also return a bare
502/504 after dispatch. Absence of `x-reviewrouter-request-ref` is not positive
evidence that the request was never dispatched.

## Existing pre-request saturation wait

The transport retries the same dispatch ticket only after a fully drained HTTP503
response with no request reference, JSON content type, and the exact closed
envelope `{"error":{"code":"relay_saturated","effect":"not_dispatched"}}`.
The existing 128-wait/120-second budget and cancellation bounds apply. Direct
OpenRouter never interprets this Gateway-only response or retries inference.

## Attested native non-entry successor

The frozen producer profile `model-dispatch-policy.native-retry.v1` permits one
fresh successor for an eligible V2 finding-discovery request on its original
account-gateway route. That route must carry both the capacity128 discriminator
and `retryPolicy:"native-rejection-once.v1"`. Neither V2 nor capacity128 alone
enables this permission. The profile's other transports retain their ordinary
capacity128 limits without retry permission. Lifecycle verification, PR
descriptions and V4 multi-reviewer routes remain outside this policy.

After a fully drained non-success response with the original request reference,
the Action asks RR to acknowledge
`{state:"not_dispatched",proof:"native_rejection_after_forward"}` using its receipt
token. The HTTP status, headers and error body do not authorize a retry. RR must
have independently established native non-entry and physical closure for that
exact original request. The Action requires a matching original claim, native
reference, finding-discovery role and the exact closed proof
`nativeRetryProof:{kind:"native_rejection_after_forward",reason:"admission_storage_conflict"}`.
A lost acknowledgement requires exact matching durable readback.

Only after that acknowledgement does the Action wait once for 1000 milliseconds
with the original abort signal. The original ticket remains active throughout
the wait, so another model request cannot interleave. A short remaining window,
cancellation, expired original deadline or changed lease authority prevents the
successor. Native settlement and its lost-acknowledgement readback use the same
original signal; the retry cannot replace it.

The successor has a fresh dispatch identity, the immediately following ordinal
and a valid native request reference distinct from the original. It retains the
captured original request bytes, route, work slot, attempt, lease, fence and
authorization/deadline, using the current token for that same live lease. Both
requests consume the existing request budget. Earlier completed turns are not
replayed. A successor cannot create another successor; its failure, including a
local pre-forward failure, fences further local claims. A successfully completed
successor permits the next ordinary turn under the unchanged admission rules.

Socket errors, unproved proxy responses, started-stream failures, truncated
responses and aborts remain terminal. Missing, foreign, expired or ambiguous
proof cannot authorize another POST. No authority renewal, orchestration-attempt
increase or provider failover is introduced.

The prior request-stage and ref-less edge retry policy remains superseded:
there was no idempotency guarantee on those POSTs. Diagnostic fields stay closed
and exclude tokens, raw bodies and model content.

The real-TLS suite counts accepted requests before deliberately losing headers,
preserves the closed503 wait, and exercises the attested successor separately.
Its paid-turn case retains the earlier output once, sends the second logical
request under distinct root/child identities, and checks its exact byte body.
Negative cases retain the prior paid turn without another provider request when
proof is unavailable or the original deadline expires.
