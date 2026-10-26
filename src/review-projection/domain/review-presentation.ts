import {
  FindingOccurrenceState,
  ProjectionCoverageState,
  type FindingOccurrence,
  type LifecycleVerificationFact,
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
  readonly verification?: {
    readonly confirmedOpen: number;
    readonly fixesVerified: number;
    readonly unverified: number;
  };
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
  readonly lifecycleVerificationFacts?: readonly LifecycleVerificationFact[];
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
  const facts = input.lifecycleVerificationFacts;
  if (
    facts &&
    new Set(facts.map((fact) => fact.targetId)).size !== facts.length
  )
    throw new Error('duplicate lifecycle confirmation target');
  const verification = facts
    ? { confirmedOpen: 0, fixesVerified: 0, unverified: 0 }
    : undefined;
  const replacedLineages = new Set<string>();
  const countedOpen = new Set<string>();
  const countedFixes = new Set<string>();
  const countedUnverified = new Set<string>();
  for (const fact of facts ?? []) {
    const identity = fact.lineageId ?? fact.targetId;
    const occurrence = fact.lineageId
      ? occurrences.get(fact.lineageId)
      : undefined;
    const current =
      occurrence &&
      [
        FindingOccurrenceState.New,
        FindingOccurrenceState.Reconfirmed,
        FindingOccurrenceState.Changed,
      ].includes(occurrence.state);
    if (fact.confirmationState === 'unverified') {
      if (!current && !countedUnverified.has(identity))
        verification!.unverified++;
      countedUnverified.add(identity);
      continue;
    }
    if (fact.confirmationState === 'native_resolved') continue;
    if (
      fact.confirmationState === 'confirmed_open' &&
      !countedOpen.has(identity)
    )
      verification!.confirmedOpen++;
    if (
      fact.confirmationState === 'fix_confirmed_thread_open' &&
      !countedFixes.has(identity)
    )
      verification!.fixesVerified++;
    if (fact.confirmationState === 'fix_confirmed_thread_open')
      countedFixes.add(identity);
    if (current) {
      if (fact.confirmationState === 'confirmed_open')
        countedOpen.add(identity);
      continue;
    }
    if (
      occurrence &&
      !replacedLineages.has(occurrence.lineageId) &&
      [
        FindingOccurrenceState.CarriedUnverified,
        FindingOccurrenceState.Uncertain,
      ].includes(occurrence.state)
    ) {
      severity[occurrence.severity]--;
      changes.open--;
      changes.unverified--;
      replacedLineages.add(occurrence.lineageId);
    }
    if (
      fact.confirmationState === 'confirmed_open' &&
      !countedOpen.has(identity)
    ) {
      countedOpen.add(identity);
      if (fact.severity !== 'unknown') severity[fact.severity]++;
      changes.open++;
    }
  }
  return Object.freeze({
    variant: baseline ? 'update' : 'first',
    state:
      input.incomplete ||
      input.coverage.state !== ProjectionCoverageState.Complete
        ? 'incomplete'
        : 'complete',
    severity: Object.freeze(severity),
    ...(verification ? { verification: Object.freeze(verification) } : {}),
    coverage: Object.freeze({
      reviewed: input.coverage.reviewedFiles,
      total: input.coverage.totalFiles,
    }),
    ...(baseline ? { changes: Object.freeze(changes) } : {}),
  });
}
