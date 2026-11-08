import * as path from 'path';
import type {
  FileChange,
  Finding,
  ReviewCoverageFile,
  UnchangedContext,
} from '../../types';
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
  /** Import hints already produced by normal static analysis, no new I/O. */
  readonly contexts?: readonly Pick<
    UnchangedContext,
    'file' | 'downstreamConsumers'
  >[];
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
  const importDependents =
    changedFiles.length <= maxGraphFiles
      ? existingImportDependents(changedPaths, input.contexts)
      : new Map<string, number>();
  const coverageByPath = new Map(
    (input.coverage?.files ?? []).map((file) => [file.path, file.status])
  );
  const candidates: HotspotCandidate[] = changedFiles.map((file) => {
    const fromGraph = graph
      ? boundedDependents(graph, file.filename, changedPaths)
      : undefined;
    const fromImports = importDependents.get(file.filename);
    const dependents =
      fromGraph === undefined && fromImports === undefined
        ? undefined
        : Math.max(fromGraph ?? 0, fromImports ?? 0);
    return {
      path: file.filename,
      changedLines: file.additions + file.deletions,
      coverage: coverageByPath.get(file.filename),
      ...(dependents === undefined ? {} : { dependents }),
    };
  });

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

/**
 * Bounded, conservative fallback for default installations with graph off.
 * ContextRetriever already extracts added import specifiers from the PR diff;
 * only an unambiguous relative import to another *changed* file counts.
 * These are possible references, not an audited full-repository call graph.
 */
function existingImportDependents(
  changedPaths: ReadonlySet<string>,
  contexts: ReviewRiskInput['contexts']
): Map<string, number> {
  if (!contexts?.length) return new Map();
  const byModule = new Map<string, string[]>();
  for (const file of changedPaths) {
    if (file.includes('\\') || file.startsWith('/') || file.includes('\0'))
      continue;
    const key = stripSourceExtension(file);
    const existing = byModule.get(key) ?? [];
    existing.push(file);
    byModule.set(key, existing);
  }

  const references = new Map<string, Set<string>>();
  for (const context of contexts.slice(0, maxGraphFiles)) {
    if (!changedPaths.has(context.file)) continue;
    for (const specifier of context.downstreamConsumers.slice(0, 16)) {
      if (specifier.length > 512 || !/^\.\.?\//.test(specifier)) continue;
      if (specifier.includes('\\') || specifier.includes('\0')) continue;
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(context.file), specifier)
      );
      if (
        resolved.startsWith('../') ||
        resolved === '..' ||
        path.posix.isAbsolute(resolved)
      ) continue;
      const matches = byModule.get(stripSourceExtension(resolved));
      if (matches?.length !== 1 || matches[0] === context.file) continue;
      const target = matches[0];
      const importers = references.get(target) ?? new Set<string>();
      importers.add(context.file);
      references.set(target, importers);
    }
  }
  return new Map([...references].map(([file, importers]) => [file, importers.size]));
}

function stripSourceExtension(modulePath: string): string {
  return modulePath.replace(/\.(?:tsx?|jsx?|mjs|cjs)$/, '');
}
