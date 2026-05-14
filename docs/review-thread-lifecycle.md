# Review Thread Lifecycle

ReviewRouter can reconcile unresolved inline review threads that it previously
created. The goal is to close old ReviewRouter comments only when the current
review proves the old finding is fixed, while keeping still-valid or uncertain
old findings visible in the latest summary.

This feature is intentionally conservative. It does not close comments because
the code changed, because a fingerprint disappeared, or because a provider did
not mention the issue again.

## Runtime Contract

Review thread lifecycle runs only for unresolved ReviewRouter-owned review
threads loaded through GitHub GraphQL.

The action:

- ignores already resolved review threads;
- ignores markers from untrusted authors for dedupe and auto-resolve;
- sends bounded old-finding revalidation targets in the normal provider review
  prompt;
- accepts provider revalidation only for target IDs that were actually assigned
  to that provider batch;
- does not launch extra provider processes only for lifecycle;
- aggregates provider revalidation answers with strict quorum;
- calls `resolveReviewThread` only after quorum and fresh GitHub guards;
- includes previous still-valid findings in summary counters and merge gating;
- blocks `All Clear` wording while old unresolved threads are uncertain.

## Quorum Policy

Single-provider review plan:

- one valid `resolved` vote may close the thread.

Multi-provider review plan:

- at least two independent provider identities must return valid `resolved`;
- one provider cannot close a thread alone;
- missing, failed, parse-error, invalid, or omitted provider output is
  uncertainty;
- any valid `still_valid` vote blocks closing.

Examples:

```text
A: resolved
B: resolved
=> close

A: resolved
B: uncertain
=> keep open

A: resolved
B: still_valid
=> keep open and count as active previous finding

A: resolved
B: failed
=> keep open in multi-provider mode
```

## Safety Guards

Before auto-resolving a thread, ReviewRouter rechecks GitHub state:

- the PR head SHA must still match the reviewed SHA;
- the review thread must still be unresolved;
- the parent comment fingerprint and timestamp must match the inventory;
- thread comments must not be truncated;
- no human reply may have appeared after the ReviewRouter parent comment;
- the token must have permission to resolve the thread.

If any guard fails, the thread is not resolved. The summary reports the skipped
or failed lifecycle state instead of claiming success.

## Dedupe Rules

Current inline finding dedupe uses trusted unresolved GraphQL review thread
state. Resolved old threads do not suppress new current findings.

This prevents the old failure mode where a resolved historical comment could
hide a newly resurfaced bug.

## Summary And Checks

Lifecycle output is separate from current provider findings:

- `resolvedByLifecycle` is listed only after mutation success or external
  already-resolved confirmation;
- `previousStillValid` counts as active and affects `failOnSeverity`;
- `previousUncertain`, manual attention, mutation skipped, mutation failed,
  lifecycle inventory failure, and lifecycle cap skips block `All Clear`;
- report mode shows would-be resolved threads as skipped, not resolved.

## Configuration

Environment variables:

```yaml
REVIEW_THREAD_LIFECYCLE: resolve # off, report, or resolve
REVIEW_THREAD_LIFECYCLE_MAX_TARGETS: 10
REVIEW_THREAD_LIFECYCLE_RESOLVE_CONFIDENCE: '{"critical":0.9,"major":0.85,"minor":0.8,"unknown":0.9}'
REVIEW_APP_SLUG: review-router-owner # optional, trusts review-router-owner[bot] for lifecycle
```

Config file keys:

```yaml
review_thread_lifecycle: resolve
review_thread_lifecycle_max_targets: 10
review_thread_lifecycle_resolve_confidence:
  critical: 0.9
  major: 0.85
  minor: 0.8
  unknown: 0.9
```

Use `report` mode to validate lifecycle decisions without mutating GitHub
review threads.

When comments are posted through a user-owned GitHub App, pass the App slug as
`REVIEW_APP_SLUG` or the exact bot login as `REVIEW_APP_BOT_LOGIN`. ReviewRouter
only trusts explicit bot identities; it does not trust every `[bot]` author.
In `REVIEWROUTER_COMMENT_TOKEN_MODE=app-oidc`, `github-actions[bot]` is trusted
only when comment posting falls back to `GITHUB_TOKEN`.

## Non-Goals

- No rechecking already resolved threads on every commit.
- No auto-unresolve of previously resolved threads.
- No REST-only fallback for resolved review thread state.
- No auto-close for threads with human discussion.
- No auto-close for `/rr skip` or command-dismissed findings in v1.

## Implementation Notes

The implementation is split across pure decision logic and GitHub side effects:

- `src/github/review-thread-inventory.ts` loads GraphQL inventory and candidates.
- `src/analysis/thread-lifecycle.ts` normalizes votes and applies quorum.
- `src/github/review-thread-resolver.ts` performs guarded mutations.
- `src/output/formatter-v2.ts` renders lifecycle state in the summary.
- `src/github/summary-metadata.ts` prevents stale older runs from replacing
  newer summaries.

The core rule is: provider quorum decides whether a thread is a resolved
candidate, and GitHub guards decide whether the mutation is still safe. The
resolver must not reinterpret provider evidence or weaken quorum.
