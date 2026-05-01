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
  mode?: ReviewCoverage['mode'];
}

export function buildReviewCoverage(
  pr: PRContext,
  config: ReviewConfig,
  options: BuildReviewCoverageOptions = {}
): ReviewCoverage {
  const compacted = compactDiffForPrompt(pr.diff, pr.files, {
    enabled: config.smartDiffCompaction ?? true,
    maxFullFileBytes: config.maxFullDiffFileBytes,
    maxFullFileChanges: config.maxFullDiffFileChanges,
  });
  const trimmedDiff = trimDiff(compacted.diff, config.diffMaxBytes);
  const pathsBeforeTrim = extractDiffDestinationPaths(compacted.diff);
  const pathsAfterTrim = extractDiffDestinationPaths(trimmedDiff);
  const compactedByFile = new Map(
    compacted.summaryOnlyFiles.map(file => [file.filename, file])
  );

  const reviewedFiles: ReviewCoverageFile[] = pr.files.map(file => {
    const compactedFile = compactedByFile.get(file.filename);
    const wasInPromptBeforeTrim = pathsBeforeTrim.has(file.filename);
    const isInPrompt = pathsAfterTrim.has(file.filename);
    const base = {
      path: file.filename,
      additions: file.additions,
      deletions: file.deletions,
    };

    if (!isInPrompt) {
      return {
        ...base,
        status: 'metadata-only' as const,
        reason: wasInPromptBeforeTrim
          ? 'trimmed by prompt byte budget'
          : 'no unified diff patch available',
      };
    }

    if (compactedFile) {
      return {
        ...base,
        status: 'compacted' as const,
        reason: compactedFile.reason,
      };
    }

    return {
      ...base,
      status: 'full' as const,
    };
  });

  const skippedFiles = (options.skippedFiles ?? []).map(file => ({
    path: file.filename,
    status: 'skipped' as const,
    reason: 'trivial or low-signal file excluded before LLM review',
    additions: file.additions,
    deletions: file.deletions,
  }));

  const files = [...reviewedFiles, ...skippedFiles];

  return {
    mode: options.mode ?? 'full',
    totalFiles: options.totalFiles ?? files.length,
    filesConsidered: pr.files.length,
    fullDiffFiles: countByStatus(files, 'full'),
    compactedFiles: countByStatus(files, 'compacted'),
    metadataOnlyFiles: countByStatus(files, 'metadata-only'),
    skippedFiles: countByStatus(files, 'skipped'),
    agenticContext: config.codexAgenticContext ?? false,
    files,
  };
}

function countByStatus(
  files: ReviewCoverageFile[],
  status: ReviewCoverageFile['status']
): number {
  return files.filter(file => file.status === status).length;
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
