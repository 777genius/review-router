import {
  FindingOccurrenceState,
  ProjectionCoverageState,
  type FindingOccurrence,
  type ReviewCoverageFact,
} from './review-projection';
import type { ReviewComparisonBaseline } from './comparison-baseline';

export interface ReviewPresentation {
  readonly variant: 'first' | 'update';
  readonly state: 'complete' | 'incomplete';
  readonly severity: {
    readonly critical: number;
    readonly major: number;
    readonly minor: number;
    readonly info: number;
  };
  readonly coverage?: { readonly reviewed: number; readonly total: number };
  readonly changes?: {
    readonly new: number;
    readonly resolved: number;
    readonly open: number;
    readonly unverified: number;
  };
}

/** Counts unique lineages after conservative history/lifecycle projection. */
export function deriveReviewPresentation(input: {
  readonly reviewedHeadSha: string;
  readonly baseline?: ReviewComparisonBaseline | null;
  readonly coverage: ReviewCoverageFact;
  readonly incomplete: boolean;
  readonly occurrences: readonly FindingOccurrence[];
}): ReviewPresentation {
  const baseline =
    input.baseline?.sourceReviewedHeadSha !== input.reviewedHeadSha
      ? input.baseline
      : null;
  const prior = new Map(
    baseline?.priorLineageHints.map((hint) => [hint.lineageId, hint])
  );
  const occurrences = new Map(
    input.occurrences.map((item) => [item.lineageId, item])
  );
  const severity = { critical: 0, major: 0, minor: 0, info: 0 };
  const changes = { new: 0, resolved: 0, open: 0, unverified: 0 };
  for (const item of occurrences.values()) {
    if (item.state === FindingOccurrenceState.SuppressedByHuman) continue;
    if (item.state === FindingOccurrenceState.Resolved) {
      if (prior.get(item.lineageId)?.active) changes.resolved++;
      continue;
    }
    severity[item.severity]++;
    changes.open++;
    if (
      !prior.has(item.lineageId) &&
      [
        FindingOccurrenceState.New,
        FindingOccurrenceState.Reconfirmed,
        FindingOccurrenceState.Changed,
      ].includes(item.state)
    )
      changes.new++;
    if (
      [
        FindingOccurrenceState.CarriedUnverified,
        FindingOccurrenceState.Uncertain,
      ].includes(item.state)
    )
      changes.unverified++;
  }
  return Object.freeze({
    variant: baseline ? 'update' : 'first',
    state:
      input.incomplete ||
      input.coverage.state !== ProjectionCoverageState.Complete
        ? 'incomplete'
        : 'complete',
    severity: Object.freeze(severity),
    coverage: Object.freeze({
      reviewed: input.coverage.reviewedFiles,
      total: input.coverage.totalFiles,
    }),
    ...(baseline ? { changes: Object.freeze(changes) } : {}),
  });
}
