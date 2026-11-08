import type { FileChange, Finding, ReviewCoverageFile } from '../../types';
import type { CodeGraph } from '../../analysis/context/graph-builder';
import {
  rankReviewHotspots,
  type HotspotCandidate,
  type ReviewHotspot,
} from '../domain/rank-review-hotspots';

export interface ReviewRiskInput {
  readonly files: readonly Pick<
    FileChange,
    'filename' | 'status' | 'additions' | 'deletions'
  >[];
  readonly findings: readonly Pick<Finding, 'file' | 'line' | 'severity'>[];
  readonly coverage?: {
    readonly files: readonly Pick<ReviewCoverageFile, 'path' | 'status'>[];
  };
  /** Already built by the normal review; never trigger new graph work here. */
  readonly graph?: Pick<CodeGraph, 'getDependents'> | null;
}

const maxGraphFiles = 128;

/**
 * Thin read-only adapter: the domain doesn't know about Graph, GitHub, or I/O.
 *
 * The existing graph is only a snapshot of the analyzed change, not a complete
 * repository graph. The caller must not use the counts as a safety guarantee.
 */
export function buildReviewHotspots(input: ReviewRiskInput): ReviewHotspot[] {
  const changedFiles = input.files.filter((file) => file.status !== 'removed');
  const changedPaths = new Set(changedFiles.map((file) => file.filename));
  const graph =
    changedFiles.length <= maxGraphFiles ? input.graph : undefined;
  const coverageByPath = new Map(
    (input.coverage?.files ?? []).map((file) => [file.path, file.status])
  );
  const candidates: HotspotCandidate[] = changedFiles.map((file) => ({
    path: file.filename,
    changedLines: file.additions + file.deletions,
    coverage: coverageByPath.get(file.filename),
    ...(graph
      ? {
          dependents: boundedDependents(
            graph,
            file.filename,
            changedPaths
          ),
        }
      : {}),
  }));

  // Keep the finding's original line and severity. Multiple problems on a
  // path are reduced by the pure domain to the most important signal.
  for (const finding of input.findings) {
    if (!changedPaths.has(finding.file)) continue;
    candidates.push({
      path: finding.file,
      severity: finding.severity,
      line: finding.line,
      coverage: coverageByPath.get(finding.file),
    });
  }

  return rankReviewHotspots(candidates);
}

function boundedDependents(
  graph: Pick<CodeGraph, 'getDependents'>,
  file: string,
  changedPaths: ReadonlySet<string>
): number | undefined {
  try {
    // Distinct *changed* files only. The graph uses heuristic resolution;
    // do not present this as a verified whole-repository impact count.
    return new Set(
      graph
        .getDependents(file)
        .filter((dependent) => dependent !== file && changedPaths.has(dependent))
    ).size;
  } catch {
    // A partial/unavailable graph must not break an otherwise valid review.
    return undefined;
  }
}
