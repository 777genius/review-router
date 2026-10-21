# Provider usage producer v1

The Action captures safe facts independently of review acceptance. The direct
OpenRouter v2 runtime records the owning Responses HTTPS attempt. The normal
T0 Codex runner registers a report grant after authorization and passes it to the
CLI relay through supported provider base URL configuration. Approved OAuth uses
`https://chatgpt.com/backend-api/codex`; API-key mode uses
`https://api.openai.com/v1`. Existing explicit MiMo/OpenRouter provider settings
can use the same relay. Admission rules remain authoritative; adding a local
transport does not approve a new workflow or provider mode.

A request receives one stable call ID and source-local revisions. Cache reads
and reasoning are subdivisions of inclusive input/output, not extra totals.
Missing usage is null. A stream with initial counters and no terminal event
remains partial. Failed, aborted, and unknown requests retain their own facts.
The relay forwards original bytes and fixed allowed credentials only; no TLS
interception, prompt persistence, provider logs, or inference retry is added.

## Delivery and recovery

Before delivery, `UsageDelivery` writes and fsyncs the signed bounded safe spool
in a private directory below `RUNNER_TEMP`. The ephemeral Ed25519 private key and
report bearer stay in memory. Grant registration sends the public SPKI PEM under
the current execution bearer. Server response scope owns provider, model, actor,
workspace, repository, invocation, run attempt, source namespace and call prefix.

Reports contain at most 100 facts / 256 KiB per request; the spool ceiling is
4 MiB. Only an ACK with matching event ID, revision, canonical fact SHA256 and
`accepted` or `duplicate` status removes pending facts. Network or telemetry
failure never reruns inference or fails an otherwise successful review.
Overflow or persistence loss sets `provider_usage_status=partial`; an unavailable
grant sets `unavailable`, never zero measured spend.

Cleanup always attempts bounded flush under the independent report-only grant,
even after execution cancellation. Remaining facts upload through the GitHub
artifact client with seven-day retention. The exact artifact name is
`reviewrouter-usage-v1-<invocationId>-<runAttempt>` and its only file is
`report.json`. Direct invocation IDs use `<authorizationId>-provider-api` so the
artifact name contains no forbidden colon. The signed canonical JSON includes
schemaVersion, grantId, producerDigest, workflowIdentity, jobIdentity,
invocationId, runAttempt, facts and ordered eventHashes. The signature field is
excluded from signed bytes. No bearer or private key is in the artifact.

Recovery must use App-owned access to the same approved run, saved grant/public
key, exact signed envelope and replay window. Artifact name or run ownership
alone is insufficient. Runner death before upload remains unknown coverage.
The spool is intentionally retained as recovery evidence; cleanup never deletes
unacknowledged files. A process restart cannot resume its memory-only bearer,
but an already signed uploaded report can be recovered by the control plane.

## Release qualification

This source patch does not register a release, approve a new pin, or deploy.
Follow the RR `review-action-v2-contract-handoff.md` runbook: frozen clean SaaS
SHA, isolated non-main Action branch, expected Action HEAD fence, protocol export,
Action tests and bundle build, then clean Action release SHA. Generate and check
the immutable release manifest outside the Action repository. Only that checked
manifest can be registered for producer release. The server derives the grant's
producer digest and immutable approved workflow/job identity; caller labels do
not confer authority. Update approved immutable workflow pins only after the
source-owned handoff and release gates pass.

Focused verification covers signed artifact secrecy/verification, exact ACK
retry, overflow, cancelled partial usage, failed JSON usage, and real local
HTTP-to-mocked-HTTPS forwarding. It does not prove a deployed producer, GitHub
artifact service operation, or real provider billing. Normal Claude/MiMo and direct Codex/MiMo/OpenRouter coverage uses the fixed-source
`reviewrouter-secrets-runtime.yml` profile, an approved immutable producer,
server-derived ActionSession grants, and the owning transport wrappers. The
next controlled setup refresh selects this profile only after its producer is
registered and the pinned source contains it. Existing mutable legacy workflows
remain ineligible and report telemetry unavailable. No release has been deployed.

The passive transport preserves client-selected native and helper model names,
request bytes, and authentication. The grant model stays the configured identity;
only upstream response metadata can establish an observed model. Anthropic SDK
`/v1/messages/count_tokens` calls pass through with the same transport bounds and
do not emit inference usage facts.
