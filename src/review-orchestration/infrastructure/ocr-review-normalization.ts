/**
 * OCR result normalization (plan 56, §8.2).
 *
 * Maps native managed comments to existing Finding objects with explicit
 * span verification against the authorized HEAD content: inline anchors and
 * suggested patches are only produced for an unambiguous verified current
 * span. Missing/unknown severity keeps the finding at minor with partial
 * flags; empty content or an invalid path skips only that item. Native
 * thinking is never published. Output bounds fail explicitly instead of
 * silently truncating.
 */

import type { Finding, Severity } from '../../types';
import type { OcrNativeComment } from './ocr-review-outcome-contract';

/**
 * Bounds of the current consumer evidence contract (plan 56, §8.2):
 * payload 512 KiB, 200 findings, path 1024, message 16384 characters,
 * maxTitleLength 512. The payload bound is checked exactly by the adapter
 * after the existing normalizer serializes the observation.
 */
export const OCR_NORMALIZATION_LIMITS = Object.freeze({
  maxPayloadBytes: 512 * 1024,
  maxFindings: 200,
  maxPathChars: 1024,
  maxMessageChars: 16384,
  maxTitleChars: 512,
});

export type OcrSpanUnverifiedReason =
  | 'missing_existing_code'
  | 'invalid_range'
  | 'content_mismatch'
  | 'ambiguous_match'
  | 'outside_diff';

export type OcrSpanVerification =
  | Readonly<{ verified: true; startLine: number; endLine: number }>
  | Readonly<{ verified: false; reason: OcrSpanUnverifiedReason }>;

function normalizeEol(value: string): string[] {
  return value.split(/\r\n|\r|\n/u);
}

/**
 * Verify a native existing_code span against authorized HEAD content.
 * Verified only when the range is valid, the HEAD content of exactly that
 * range equals existing_code, the block occurs unambiguously in the file and
 * every line is a valid current PR diff position. A single matching line
 * number does not prove the span.
 */
export function verifyOcrSpan(input: {
  readonly comment: Pick<
    OcrNativeComment,
    'existingCode' | 'startLine' | 'endLine'
  >;
  readonly headContent: string;
  readonly diffPositions?: ReadonlyMap<number, number>;
}): OcrSpanVerification {
  const { existingCode, startLine, endLine } = input.comment;
  if (existingCode === null) return { verified: false, reason: 'missing_existing_code' };
  if (startLine === null || endLine === null || endLine < startLine) {
    return { verified: false, reason: 'invalid_range' };
  }
  const fileLines = normalizeEol(input.headContent);
  if (startLine < 1 || endLine > fileLines.length) {
    return { verified: false, reason: 'invalid_range' };
  }
  const blockLines = normalizeEol(existingCode.replace(/\s+$/u, ''));
  const headBlock = fileLines.slice(startLine - 1, endLine);
  if (
    blockLines.length !== headBlock.length ||
    blockLines.some((line, index) => line !== headBlock[index])
  ) {
    return { verified: false, reason: 'content_mismatch' };
  }
  // The matched block must occur exactly once in the file (unambiguous).
  let occurrences = 0;
  for (let index = 0; index + blockLines.length <= fileLines.length; index++) {
    let matches = true;
    for (let offset = 0; offset < blockLines.length; offset++) {
      if (fileLines[index + offset] !== blockLines[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) occurrences++;
    if (occurrences > 1) break;
  }
  if (occurrences !== 1) return { verified: false, reason: 'ambiguous_match' };
  if (input.diffPositions) {
    for (let line = startLine; line <= endLine; line++) {
      if (!input.diffPositions.has(line)) {
        return { verified: false, reason: 'outside_diff' };
      }
    }
  }
  return { verified: true, startLine, endLine };
}

export type OcrFindingSkipReason = 'invalid_native_finding';

export type OcrNormalizationDiagnostics = Readonly<{
  /** Per-item skips: kept out of findings with provider_warning flags. */
  skipped: readonly { readonly index: number; readonly reason: OcrFindingSkipReason }[];
  /** Bounded local diagnostic codes for partial quality flags. */
  reasons: readonly string[];
  /** True when at least one reason requires partial quality flags (§8.2). */
  partialFlagsRequired: boolean;
}>;

export type OcrNormalizedFindings = Readonly<{
  findings: readonly Finding[];
  diagnostics: OcrNormalizationDiagnostics;
}>;

export class OcrOutputTooLargeError extends Error {
  constructor(readonly bound: string) {
    super(`ocr_review_output_too_large: ${bound}`);
    this.name = 'OcrOutputTooLargeError';
  }
}

const SEVERITY_MAP: Readonly<Record<string, Severity>> = {
  critical: 'critical',
  high: 'major',
  medium: 'minor',
  low: 'minor',
};

/** Safe repository-relative path, or null when unusable (§8.2). */
export function normalizeOcrRepoPath(raw: string): string | null {
  const path = raw.replace(/^\.\//u, '');
  if (
    path.length === 0 ||
    path.length > OCR_NORMALIZATION_LIMITS.maxPathChars ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.startsWith('/') ||
    path.split('/').some((segment) => segment === '..' || segment === '')
  ) {
    return null;
  }
  return path;
}

function plainTitleLine(content: string): string {
  const firstLine =
    content
      .split(/\r\n|\r|\n/u)
      .map((line) => line.replace(/[^\P{Z}\u00a0]/gu, ' ').trim())
      .find((line) => line.length > 0) ?? '';
  return firstLine
    .replace(/[`#>*_~\[\]]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, OCR_NORMALIZATION_LIMITS.maxTitleChars);
}

/**
 * Normalize native managed comments into existing Finding objects.
 * Verified spans keep their exact range and suggestion; everything else is
 * kept in summary/file placement without a current-line anchor and without a
 * committable suggested patch. Invalid items are skipped with reasons; the
 * valid remaining items are preserved.
 */
export function normalizeOcrFindings(input: {
  readonly comments: readonly OcrNativeComment[];
  /** path -> authorized HEAD content of the checked-out snapshot. */
  readonly headFiles: Readonly<{ get(path: string): string | undefined }>;
  /** path -> (new line number -> PR diff position) of the current diff. */
  readonly diffPositions?: ReadonlyMap<string, ReadonlyMap<number, number>>;
}): OcrNormalizedFindings {
  const findings: Finding[] = [];
  const skipped: { index: number; reason: OcrFindingSkipReason }[] = [];
  const reasons = new Set<string>();

  input.comments.forEach((comment, index) => {
    const path = normalizeOcrRepoPath(comment.path);
    const content = comment.content.trim();
    if (path === null || content.length === 0) {
      skipped.push({ index, reason: 'invalid_native_finding' });
      return;
    }
    if (content.length > OCR_NORMALIZATION_LIMITS.maxMessageChars) {
      throw new OcrOutputTooLargeError('message');
    }

    const headContent = input.headFiles.get(path);
    const span =
      headContent !== undefined
        ? verifyOcrSpan({
            comment,
            headContent,
            ...(input.diffPositions
              ? { diffPositions: input.diffPositions.get(path) }
              : {}),
          })
        : ({ verified: false, reason: 'invalid_range' } as const);
    if (!span.verified && span.reason !== 'missing_existing_code') {
      reasons.add('unverified_native_span');
    }

    const mappedSeverity = comment.severity
      ? SEVERITY_MAP[comment.severity]
      : undefined;
    const severity: Severity = mappedSeverity ?? 'minor';
    if (mappedSeverity === undefined) {
      // Explicit conservative adapter fallback (§8.2), never a blocker.
      reasons.add('unclassified_native_severity');
    }

    findings.push({
      file: path,
      ...(span.verified
        ? {
            startLine: span.startLine,
            line: span.startLine,
            endLine: span.endLine,
          }
        : {
            // No current-line anchor for unverified spans: the existing
            // normalizer maps line 0 to null and placement stays file/summary.
            line: 0,
          }),
      severity,
      title: plainTitleLine(content),
      message: content,
      category: comment.category ?? 'correctness',
      ...(span.verified && comment.suggestionCode !== null
        ? { suggestion: comment.suggestionCode }
        : {}),
    });
  });

  if (findings.length > OCR_NORMALIZATION_LIMITS.maxFindings) {
    throw new OcrOutputTooLargeError('findings');
  }
  for (const finding of findings) {
    if (finding.file.length > OCR_NORMALIZATION_LIMITS.maxPathChars) {
      throw new OcrOutputTooLargeError('path');
    }
    if (finding.message.length > OCR_NORMALIZATION_LIMITS.maxMessageChars) {
      throw new OcrOutputTooLargeError('message');
    }
  }

  return Object.freeze({
    findings: Object.freeze(findings),
    diagnostics: Object.freeze({
      skipped: Object.freeze(skipped),
      reasons: Object.freeze([...reasons].sort()),
      partialFlagsRequired: reasons.size > 0 || skipped.length > 0,
    }),
  });
}
