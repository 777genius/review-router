import { Review, Severity } from '../types';
import { isLinkedCurrentFinding } from '../analysis/thread-lifecycle';

const severityRank: Record<Severity, number> = {
  critical: 3,
  major: 2,
  minor: 1,
};

export interface BlockingFindingBreakdown {
  current: number;
  previousStillValid: number;
  total: number;
}

export function getBlockingFindingBreakdown(
  review: Review,
  threshold: Severity | 'off' | undefined
): BlockingFindingBreakdown {
  if (!threshold || threshold === 'off') {
    return { current: 0, previousStillValid: 0, total: 0 };
  }

  const minRank = severityRank[threshold];
  const current = review.findings.filter(
    (finding) => severityRank[finding.severity] >= minRank
  ).length;
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
  if (breakdown.current > 0) {
    parts.push(
      `${breakdown.current} new current ${threshold}+ ${pluralize('finding', breakdown.current)}`
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
  const noNewCurrent =
    breakdown.current === 0
      ? ` No new current ${threshold}+ findings were kept after filtering.`
      : '';

  return (
    `ReviewRouter found ${breakdown.total} blocking ${threshold}+ ${pluralize(
      'finding',
      breakdown.total
    )}: ${detail}.` +
    noNewCurrent +
    ' Review comments were posted before failing this check.'
  );
}

function pluralize(word: string, count: number): string {
  return count === 1 ? word : `${word}s`;
}
