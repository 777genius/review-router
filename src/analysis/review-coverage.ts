import {
  FileChange,
  PRContext,
  ReviewConfig,
  ReviewCoverage,
  ReviewCoverageFile,
} from '../types';
import { compactDiffForPrompt, trimDiff } from '../utils/diff';

export interface BuildReviewCoverageOptions {
  totalFiles?: number;
  skippedFiles?: FileChange[];
  unreviewedFiles?: ReadonlyArray<{
    readonly file: FileChange;
    readonly reason: string;
  }>;
  additionalUnreviewedFiles?: number;
  limitations?: readonly string[];
  mode?: ReviewCoverage['mode'];
  reviewedContexts?: readonly PRContext[];
}

export function buildReviewCoverage(
  pr: PRContext,
  config: ReviewConfig,
  options: BuildReviewCoverageOptions = {}
): ReviewCoverage {
  const promptCoverageByPath = classifyPromptCoverage(
    options.reviewedContexts ?? [pr],
    config
  );
  const unreviewedByPath = new Map(
    (options.unreviewedFiles ?? []).map(({ file, reason }) => [
      file.filename,
      reason,
    ])
  );

  const reviewedFiles: ReviewCoverageFile[] = pr.files.map((file) => {
    const promptCoverage = promptCoverageByPath.get(file.filename);
    const base = {
      path: file.filename,
      additions: file.additions,
      deletions: file.deletions,
    };

    const unreviewedReason = unreviewedByPath.get(file.filename);
    if (unreviewedReason) {
      return {
        ...base,
        status: 'unreviewed' as const,
        reason: unreviewedReason,
      };
    }

    if (!promptCoverage || promptCoverage.status === 'metadata-only') {
      return {
        ...base,
        status: 'metadata-only' as const,
        reason:
          promptCoverage?.reason ??
          'no successful LLM prompt included this file',
      };
    }

    if (promptCoverage.status === 'compacted') {
      return {
        ...base,
        status: 'compacted' as const,
        reason: promptCoverage.reason,
      };
    }

    return {
      ...base,
      status: 'full' as const,
    };
  });

  const skippedFiles = (options.skippedFiles ?? []).map((file) => ({
    path: file.filename,
    status: 'skipped' as const,
    reason: 'trivial or low-signal file excluded before LLM review',
    additions: file.additions,
    deletions: file.deletions,
  }));

  const files = [...reviewedFiles, ...skippedFiles];
  const loadedUnreviewedFiles = countByStatus(files, 'unreviewed');
  const additionalUnreviewedFiles = Math.max(
    0,
    options.additionalUnreviewedFiles ?? 0
  );
  const unreviewedFiles = loadedUnreviewedFiles + additionalUnreviewedFiles;
  const limitations = [...(options.limitations ?? [])];

  return {
    mode: options.mode ?? 'full',
    totalFiles: options.totalFiles ?? files.length + additionalUnreviewedFiles,
    filesConsidered: Math.max(0, pr.files.length - loadedUnreviewedFiles),
    fullDiffFiles: countByStatus(files, 'full'),
    compactedFiles: countByStatus(files, 'compacted'),
    metadataOnlyFiles: countByStatus(files, 'metadata-only'),
    skippedFiles: countByStatus(files, 'skipped'),
    unreviewedFiles,
    complete: unreviewedFiles === 0 && limitations.length === 0,
    ...(limitations.length > 0 ? { limitations } : {}),
    agenticContext: config.codexAgenticContext ?? false,
    files,
  };
}

function classifyPromptCoverage(
  contexts: readonly PRContext[],
  config: ReviewConfig
): Map<string, Pick<ReviewCoverageFile, 'status' | 'reason'>> {
  const coverage = new Map<
    string,
    Pick<ReviewCoverageFile, 'status' | 'reason'>
  >();
  const priority: Record<'metadata-only' | 'compacted' | 'full', number> = {
    'metadata-only': 1,
    compacted: 2,
    full: 3,
  };

  for (const context of contexts) {
    const compacted = compactDiffForPrompt(context.diff, context.files, {
      enabled: config.smartDiffCompaction ?? true,
      maxFullFileBytes: config.maxFullDiffFileBytes,
      maxFullFileChanges: config.maxFullDiffFileChanges,
    });
    const trimmedDiff = trimDiff(compacted.diff, config.diffMaxBytes);
    const pathsBeforeTrim = extractDiffDestinationPaths(compacted.diff);
    const pathsAfterTrim = extractDiffDestinationPaths(trimmedDiff);
    const compactedByFile = new Map(
      compacted.summaryOnlyFiles.map((file) => [file.filename, file])
    );

    for (const file of context.files) {
      const compactedFile = compactedByFile.get(file.filename);
      const next = pathsAfterTrim.has(file.filename)
        ? compactedFile
          ? ({
              status: 'compacted' as const,
              reason: compactedFile.reason,
            } satisfies Pick<ReviewCoverageFile, 'status' | 'reason'>)
          : ({ status: 'full' as const } satisfies Pick<
              ReviewCoverageFile,
              'status' | 'reason'
            >)
        : ({
            status: 'metadata-only' as const,
            reason: pathsBeforeTrim.has(file.filename)
              ? 'trimmed by prompt byte budget'
              : 'unified diff patch unavailable',
          } satisfies Pick<ReviewCoverageFile, 'status' | 'reason'>);
      const previous = coverage.get(file.filename);
      if (
        !previous ||
        priority[next.status as keyof typeof priority] >
          priority[previous.status as keyof typeof priority]
      ) {
        coverage.set(file.filename, next);
      }
    }
  }

  return coverage;
}

function countByStatus(
  files: ReviewCoverageFile[],
  status: ReviewCoverageFile['status']
): number {
  return files.filter((file) => file.status === status).length;
}

function extractDiffDestinationPaths(diff: string): Set<string> {
  const paths = new Set<string>();
  const diffGitPattern = /^diff --git\s+a\/(.+?)\s+b\/(.+)$/gm;
  let match: RegExpExecArray | null;

  while ((match = diffGitPattern.exec(diff)) !== null) {
    paths.add(unquoteGitPath(match[2].trim()));
  }

  return paths;
}

function unquoteGitPath(path: string): string {
  if (path.startsWith('"') && path.endsWith('"')) {
    path = path.slice(1, -1);
  }

  return path.replace(/\\([\\"tnr])/g, (_match, char: string) => {
    switch (char) {
      case '\\':
        return '\\';
      case '"':
        return '"';
      case 't':
        return '\t';
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      default:
        return char;
    }
  });
}
