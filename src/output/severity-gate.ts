import { Review, Severity } from '../types';
import { isLinkedCurrentFinding } from '../analysis/thread-lifecycle';

const severityRank: Record<Severity, number> = {
  critical: 3,
  major: 2,
  minor: 1,
};

export interface BlockingFindingBreakdown {
  current: number;
  fromCurrentReview: number;
  carriedForward: number;
  unclassifiedCurrent: number;
  previousStillValid: number;
  total: number;
}

export function getBlockingFindingBreakdown(
  review: Review,
  threshold: Severity | 'off' | undefined
): BlockingFindingBreakdown {
  if (!threshold || threshold === 'off') {
    return {
      current: 0,
      fromCurrentReview: 0,
      carriedForward: 0,
      unclassifiedCurrent: 0,
      previousStillValid: 0,
      total: 0,
    };
  }

  const minRank = severityRank[threshold];
  const current = review.findings.filter(
    (finding) => severityRank[finding.severity] >= minRank
  ).length;
  const attributedFromCurrentReview = review.findingProvenance
    ? countAtOrAbove(review.findingProvenance.fromCurrentReview, minRank)
    : current;
  const attributedCarriedForward = review.findingProvenance
    ? countAtOrAbove(review.findingProvenance.carriedForward, minRank)
    : 0;
  const fromCurrentReview = Math.min(current, attributedFromCurrentReview);
  const carriedForward = Math.min(
    current - fromCurrentReview,
    attributedCarriedForward
  );
  const unclassifiedCurrent = current - fromCurrentReview - carriedForward;
  const previousStillValid = (
    review.threadLifecycle?.previousStillValid ?? []
  ).filter((record) => {
    if (isLinkedCurrentFinding(record)) return false;
    const severity = record.target.severity;
    return (
      (severity === 'critical' ||
        severity === 'major' ||
        severity === 'minor') &&
      severityRank[severity] >= minRank
    );
  }).length;

  return {
    current,
    fromCurrentReview,
    carriedForward,
    unclassifiedCurrent,
    previousStillValid,
    total: current + previousStillValid,
  };
}

export function formatBlockingFindingFailure(
  review: Review,
  threshold: Severity | 'off' | undefined
): string | undefined {
  if (!threshold || threshold === 'off') return undefined;

  const breakdown = getBlockingFindingBreakdown(review, threshold);
  if (breakdown.total === 0) return undefined;

  const parts: string[] = [];
  if (breakdown.fromCurrentReview > 0) {
    parts.push(
      `${breakdown.fromCurrentReview} ${threshold}+ ${pluralize(
        'finding',
        breakdown.fromCurrentReview
      )} produced by this review`
    );
  }
  if (breakdown.carriedForward > 0) {
    parts.push(
      `${breakdown.carriedForward} carried-forward ${threshold}+ ${pluralize(
        'finding',
        breakdown.carriedForward
      )} from unchanged files`
    );
  }
  if (breakdown.unclassifiedCurrent > 0) {
    parts.push(
      `${breakdown.unclassifiedCurrent} active current ${threshold}+ ${pluralize(
        'finding',
        breakdown.unclassifiedCurrent
      )} with unavailable provenance`
    );
  }
  if (breakdown.previousStillValid > 0) {
    parts.push(
      `${breakdown.previousStillValid} previous unresolved ${threshold}+ ${pluralize(
        'finding',
        breakdown.previousStillValid
      )} still valid`
    );
  }

  const detail = parts.join(' and ');
  const noNewFromCurrentReview =
    breakdown.fromCurrentReview === 0
      ? ` No ${threshold}+ findings were produced by this review.`
      : '';

  return (
    `ReviewRouter found ${breakdown.total} blocking ${threshold}+ ${pluralize(
      'finding',
      breakdown.total
    )}: ${detail}.` +
    noNewFromCurrentReview +
    ' Review comments were posted before failing this check.'
  );
}

function countAtOrAbove(
  counts: Record<Severity, number>,
  minRank: number
): number {
  return (Object.keys(severityRank) as Severity[]).reduce(
    (total, severity) =>
      severityRank[severity] >= minRank ? total + counts[severity] : total,
    0
  );
}

function pluralize(word: string, count: number): string {
  return count === 1 ? word : `${word}s`;
}
