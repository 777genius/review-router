# Partial incremental cache snapshots

## Context

When LLM batch coverage is incomplete (failed or deferred batches), the review
still publishes a report — since the per-file coverage manifest work it even
publishes exactly which paths lack coverage — but the incremental cache gate
(`src/core/orchestrator.ts`) refuses to persist any snapshot. A re-run therefore
re-reviews every file from scratch even though findings for covered files are
already known and were published.

## Decision

Persist the snapshot even when coverage is incomplete, marked as partial:

- `IncrementalCacheData` gains `coverageComplete` (default `true` when absent,
  keeping legacy snapshots compatible) and `unreviewedPaths` — the paths with
  no LLM coverage at `lastReviewedCommit`.
- The orchestrator passes the uncovered paths to `saveReview` instead of
  skipping persistence when `llmCoverageComplete` is false.
- A partial snapshot is never eligible for `ReuseCompleted`: an unchanged head
  with a partial snapshot plans a delta review over the still-uncovered paths.
  A newer head plans a delta over changed ∪ previously-uncovered paths.
- A later run that reaches full coverage overwrites the snapshot with a
  complete one, restoring normal `ReuseCompleted` behavior.
- Partial snapshots are persisted only when every gap is named. Any unnamed
  gap (for example GitHub file omissions) keeps today's no-advance behavior,
  even when other gaps are named: a partial snapshot whose gap list is not
  exhaustive could later be finalized without the unnamed files ever being
  reviewed.

## Consequences

- Findings from covered, unchanged files are kept by the existing merge rules,
  so a re-run only spends provider capacity on the actual gaps.
- A file that was never reviewed can never look clean: its path is always part
  of the next review set.
- Legacy snapshots without the marker keep today's semantics (complete).
