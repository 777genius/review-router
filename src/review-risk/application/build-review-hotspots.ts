import * as path from 'path';
import type {
  FileChange,
  Finding,
  ReviewCoverageFile,
  UnchangedContext,
} from '../../types';
import {
  classifyFileRisk,
  FileRiskTier,
} from '../../review-execution/domain/file-risk-priority';
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
  /** Graph-backed context contains normalized paths rather than raw specifiers. */
  readonly contextsAreResolved?: boolean;
}

const maxContextFiles = 128;

/**
 * Presentation-only adapter: AST and context imports are incomplete snapshots,
 * not a whole-repository blast radius. Missing evidence is never low risk.
 */
export function buildReviewHotspots(input: ReviewRiskInput): ReviewHotspot[] {
  const changedFiles = input.files.filter((file) => file.status !== 'removed');
  const changedPaths = new Set(changedFiles.map((file) => file.filename));
  const importDependents =
    changedFiles.length <= maxContextFiles
      ? existingImportDependents(
          changedPaths,
          input.contexts,
          input.contextsAreResolved === true
        )
      : new Map<string, number>();
  const coverageByPath = new Map(
    (input.coverage?.files ?? []).map((file) => [file.path, file.status])
  );
  const candidates: HotspotCandidate[] = changedFiles.map((file) => ({
    path: file.filename,
    changedLines: file.additions + file.deletions,
    coverage: coverageByPath.get(file.filename),
    sensitiveArea: classifyFileRisk(file.filename) !== FileRiskTier.Normal,
    ...(importDependents.has(file.filename)
      ? { dependents: importDependents.get(file.filename) }
      : {}),
  }));

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

/**
 * ContextRetriever contains only imports recovered from changed patch lines
 * (or the already-built patch-only graph). Exact changed paths only; no suffix
 * or basename matching and no claim of complete transitive dependencies.
 */
function existingImportDependents(
  changedPaths: ReadonlySet<string>,
  contexts: ReviewRiskInput['contexts'],
  areResolved: boolean
): Map<string, number> {
  if (!contexts?.length) return new Map();
  const byModule = new Map<string, string[]>();
  for (const file of changedPaths) {
    if (!safeRepositoryPath(file)) continue;
    const key = stripSourceExtension(file);
    const existing = byModule.get(key) ?? [];
    existing.push(file);
    byModule.set(key, existing);
  }
  const references = new Map<string, Set<string>>();
  for (const context of contexts.slice(0, maxContextFiles)) {
    if (!changedPaths.has(context.file) || !safeRepositoryPath(context.file)) {
      continue;
    }
    for (const specifier of context.downstreamConsumers.slice(0, 16)) {
      if (
        typeof specifier !== 'string' ||
        specifier.length > 512 ||
        specifier.includes('\\') ||
        specifier.includes('\0')
      ) {
        continue;
      }
      const isRelative = /^\.\.?\//.test(specifier);
      // Graph-normalized paths can lack './', but unrelated package names
      // must not become repository dependencies.
      if (!isRelative && (!areResolved || !specifier.includes('/') || specifier.startsWith('@'))) {
        continue;
      }
      const resolved = path.posix.normalize(
        isRelative
          ? path.posix.join(path.posix.dirname(context.file), specifier)
          : specifier
      );
      if (!safeRepositoryPath(resolved)) continue;
      const matches = byModule.get(stripSourceExtension(resolved));
      if (matches?.length !== 1 || matches[0] === context.file) continue;
      const target = matches[0];
      const importers = references.get(target) ?? new Set<string>();
      importers.add(context.file);
      references.set(target, importers);
    }
  }
  return new Map(
    [...references].map(([file, importers]) => [file, importers.size])
  );
}

function safeRepositoryPath(file: string): boolean {
  return (
    file.length > 0 &&
    file !== '..' &&
    !file.startsWith('../') &&
    !path.posix.isAbsolute(file) &&
    !file.includes('\\') &&
    !file.includes('\0') &&
    !file.split('/').includes('..')
  );
}

function stripSourceExtension(modulePath: string): string {
  return modulePath.replace(/\.(?:tsx?|jsx?|mjs|cjs)$/, '');
}
