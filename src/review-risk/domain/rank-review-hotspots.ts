/**
 * Independent Risk-Aware Review Lite domain.
 *
 * A priority is an attention cue, NEVER a probability of a defect, a safety
 * verdict, or a merge gate. Deliberately unaware of GitHub, AST, LLM and I/O.
 */
export type HotspotSeverity = 'critical' | 'major' | 'minor';
export type HotspotCoverage =
  | 'full'
  | 'compacted'
  | 'metadata-only'
  | 'skipped'
  | 'unreviewed';

export interface HotspotCandidate {
  readonly path: string;
  readonly severity?: HotspotSeverity;
  readonly line?: number;
  readonly changedLines?: number;
  /** Only verified direct dependent files inside the analyzed graph snapshot. */
  readonly dependents?: number;
  readonly coverage?: HotspotCoverage;
}

export type HotspotReason =
  | 'critical-finding'
  | 'major-finding'
  | 'shared-code'
  | 'not-reviewed'
  | 'minor-finding';

export interface ReviewHotspot {
  readonly path: string;
  readonly reason: HotspotReason;
  readonly priority: 'attention' | 'unknown';
  readonly line?: number;
  readonly relatedFiles?: number;
}

interface ScoredHotspot {
  readonly hotspot: ReviewHotspot;
  readonly rank: number;
}

const maxCandidates = 2_000;
const maxDisplayed = 3;

function validDependents(value: number | undefined): number | undefined {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? Math.min(value, 999)
    : undefined;
}

function safeLine(value: number | undefined): number | undefined {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0
    ? value
    : undefined;
}

function score(candidate: HotspotCandidate): ScoredHotspot | undefined {
  const dependents = validDependents(candidate.dependents);
  const line = safeLine(candidate.line);
  let rank: number;
  let reason: HotspotReason;
  let priority: ReviewHotspot['priority'] = 'attention';

  if (candidate.severity === 'critical') {
    rank = 50;
    reason = 'critical-finding';
  } else if (candidate.severity === 'major') {
    rank = 40;
    reason = 'major-finding';
  } else if (dependents !== undefined && dependents > 0) {
    rank = 30 + Math.min(9, dependents);
    reason = 'shared-code';
  } else if (
    candidate.coverage === 'unreviewed' ||
    candidate.coverage === 'metadata-only'
  ) {
    rank = 20;
    reason = 'not-reviewed';
    priority = 'unknown';
  } else if (candidate.severity === 'minor') {
    rank = 10;
    reason = 'minor-finding';
  } else {
    // Absence of findings or graph context must never be labelled "safe".
    return undefined;
  }

  return {
    rank,
    hotspot: {
      path: candidate.path,
      reason,
      priority,
      ...(line === undefined ? {} : { line }),
      ...(dependents === undefined || dependents === 0
        ? {}
        : { relatedFiles: dependents }),
    },
  };
}

/**
 * Show at most three distinct paths. This function does not modify its input,
 * infer risk from raw diff size, or treat unknown evidence as proof of safety.
 */
export function rankReviewHotspots(
  candidates: readonly HotspotCandidate[],
  limit = maxDisplayed
): ReviewHotspot[] {
  const selected = new Map<string, ScoredHotspot>();
  // Reserve the normal candidate budget for efficiency, but always inspect
  // serious findings even when a GitHub PR contains >2,000 changed files.
  // Otherwise file-level candidates can hide critical/major evidence.
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    if (
      index >= maxCandidates &&
      candidate.severity !== 'critical' &&
      candidate.severity !== 'major'
    ) {
      continue;
    }
    const path = candidate.path;
    if (
      typeof path !== 'string' ||
      path.trim().length === 0 ||
      path.length > 1_024
    ) {
      continue;
    }
    const next = score(candidate);
    if (!next) continue;
    const previous = selected.get(path);
    if (
      !previous ||
      next.rank > previous.rank ||
      (next.rank === previous.rank &&
        (next.hotspot.line ?? Number.MAX_SAFE_INTEGER) <
          (previous.hotspot.line ?? Number.MAX_SAFE_INTEGER))
    ) {
      selected.set(path, next);
    }
  }

  const count = Number.isSafeInteger(limit)
    ? Math.max(0, Math.min(limit, maxDisplayed))
    : maxDisplayed;
  return [...selected.values()]
    .sort(
      (left, right) =>
        right.rank - left.rank ||
        (left.hotspot.path < right.hotspot.path
          ? -1
          : left.hotspot.path > right.hotspot.path
            ? 1
            : 0)
    )
    .slice(0, count)
    .map(({ hotspot }) => hotspot);
}
