import { Finding } from '../types';
import {
  getProviderVoteKeys,
  mergeProviderModels,
} from '../utils/provider-votes';

const SEVERITY_RANK = {
  critical: 3,
  major: 2,
  minor: 1,
} as const;

export class Deduplicator {
  dedupe(findings: Finding[]): Finding[] {
    const deduped: Finding[] = [];

    for (const finding of findings) {
      const existingIndex = deduped.findIndex((existing) =>
        isDuplicateFinding(existing, finding)
      );

      if (existingIndex === -1) {
        deduped.push(withProviderVoteKeys(finding));
        continue;
      }

      deduped[existingIndex] = mergeFindings(deduped[existingIndex], finding);
    }

    return deduped;
  }
}

function isDuplicateFinding(left: Finding, right: Finding): boolean {
  if (normalizeFile(left.file) !== normalizeFile(right.file)) return false;
  if (!lineRangesClose(left, right)) return false;

  const leftClass = classifyIssue(left);
  const rightClass = classifyIssue(right);
  const sameClass =
    leftClass !== 'generic' &&
    rightClass !== 'generic' &&
    leftClass === rightClass;

  const titleSimilarity = jaccard(tokenize(left.title), tokenize(right.title));
  if (titleSimilarity >= 0.5) return true;

  const textSimilarity = jaccard(
    tokenize(`${left.title} ${left.message}`),
    tokenize(`${right.title} ${right.message}`)
  );
  const identifiersOverlap = jaccard(
    extractIdentifiers(`${left.title} ${left.message}`),
    extractIdentifiers(`${right.title} ${right.message}`)
  );

  if (sameClass && lineRangesOverlap(left, right)) return true;
  if (sameClass && (textSimilarity >= 0.2 || identifiersOverlap >= 0.25)) {
    return true;
  }

  const sameAnchorLine = getAnchorLine(left) === getAnchorLine(right);
  if (!sameAnchorLine) return false;

  if (textSimilarity >= 0.35) return true;
  return identifiersOverlap >= 0.4 && textSimilarity >= 0.2;
}

function mergeFindings(existing: Finding, incoming: Finding): Finding {
  const providers = new Set(
    [
      ...(existing.providers || []),
      ...(incoming.providers || []),
      existing.provider,
      incoming.provider,
    ].filter(Boolean) as string[]
  );
  const providerVoteKeys = new Set([
    ...getProviderVoteKeys(existing),
    ...getProviderVoteKeys(incoming),
  ]);
  const betterMessage = chooseBetterText(existing.message, incoming.message);
  const betterTitle = chooseBetterTitle(existing.title, incoming.title);

  return {
    ...existing,
    startLine: mergeStartLine(existing, incoming),
    line: Math.max(existing.line, incoming.line),
    endLine: mergeEndLine(existing, incoming),
    severity:
      SEVERITY_RANK[incoming.severity] > SEVERITY_RANK[existing.severity]
        ? incoming.severity
        : existing.severity,
    title: betterTitle,
    message: betterMessage,
    suggestion: existing.suggestion || incoming.suggestion,
    confidence: Math.max(existing.confidence ?? 0, incoming.confidence ?? 0),
    providers: Array.from(providers),
    providerModels: mergeProviderModels(
      existing.providerModels,
      incoming.providerModels
    ),
    providerVoteKeys: Array.from(providerVoteKeys),
  };
}

function withProviderVoteKeys(finding: Finding): Finding {
  return {
    ...finding,
    providerVoteKeys: getProviderVoteKeys(finding),
  };
}

function normalizeFile(file: string): string {
  return file
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .toLowerCase();
}

function getAnchorLine(finding: Finding): number {
  return finding.startLine ?? finding.line;
}

function getEndLine(finding: Finding): number {
  return finding.endLine ?? finding.line;
}

function lineRangesClose(left: Finding, right: Finding): boolean {
  if (lineRangesOverlap(left, right)) return true;

  const leftStart = getAnchorLine(left);
  const leftEnd = getEndLine(left);
  const rightStart = getAnchorLine(right);
  const rightEnd = getEndLine(right);
  const distance =
    leftEnd < rightStart ? rightStart - leftEnd : leftStart - rightEnd;
  return distance <= 2;
}

function lineRangesOverlap(left: Finding, right: Finding): boolean {
  const leftStart = getAnchorLine(left);
  const leftEnd = getEndLine(left);
  const rightStart = getAnchorLine(right);
  const rightEnd = getEndLine(right);
  return leftStart <= rightEnd && rightStart <= leftEnd;
}

function mergeStartLine(left: Finding, right: Finding): number | undefined {
  if (left.startLine === undefined && right.startLine === undefined) {
    return undefined;
  }
  return Math.min(left.startLine ?? left.line, right.startLine ?? right.line);
}

function mergeEndLine(left: Finding, right: Finding): number | undefined {
  if (left.endLine === undefined && right.endLine === undefined) {
    return undefined;
  }
  return Math.max(left.endLine ?? left.line, right.endLine ?? right.line);
}

function chooseBetterTitle(left: string, right: string): string {
  return scoreTitle(right) > scoreTitle(left) ? right : left;
}

function scoreTitle(title: string): number {
  const tokens = tokenize(title);
  const genericPenalty = /(risk|issue|problem|bug)$/i.test(title.trim())
    ? 0.25
    : 0;
  return tokens.size - genericPenalty;
}

function chooseBetterText(left: string, right: string): string {
  const leftScore =
    extractIdentifiers(left).size * 3 + Math.min(left.length, 500);
  const rightScore =
    extractIdentifiers(right).size * 3 + Math.min(right.length, 500);
  return rightScore > leftScore ? right : left;
}

function classifyIssue(finding: Finding): string {
  const text =
    `${finding.category || ''} ${finding.title} ${finding.message}`.toLowerCase();
  if (
    /\b(null|undefined|nil|none)\b/.test(text) &&
    /\b(reference|dereference|guard|check|pointer|value)\b/.test(text)
  ) {
    return 'null_reference';
  }
  if (
    /\b(referenceerror|not defined|undefined identifier|missing import|not imported)\b/.test(
      text
    )
  ) {
    return 'undefined_identifier';
  }
  if (/\b(path traversal|directory traversal|zip slip)\b/.test(text)) {
    return 'path_traversal';
  }
  if (
    /\b(auth|authorization|authentication|permission|access control)\b/.test(
      text
    )
  ) {
    return 'access_control';
  }
  if (/\b(race|concurrency|deadlock|lock)\b/.test(text)) {
    return 'concurrency';
  }
  if (/\b(cache|stale|invalidate|invalidation)\b/.test(text)) {
    return 'stale_cache';
  }
  if (/\b(data loss|corrupt|overwrite|delete|destructive)\b/.test(text)) {
    return 'data_loss';
  }
  return 'generic';
}

function tokenize(value: string): Set<string> {
  const stopWords = new Set([
    'the',
    'and',
    'for',
    'with',
    'this',
    'that',
    'will',
    'when',
    'from',
    'into',
    'risk',
    'issue',
    'bug',
  ]);

  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9_]+/i)
      .filter((token) => token.length >= 3 && !stopWords.has(token))
  );
}

function extractIdentifiers(value: string): Set<string> {
  return new Set(
    value.match(/\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\b/g) || []
  );
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const item of left) {
    if (right.has(item)) intersection++;
  }
  return intersection / new Set([...left, ...right]).size;
}
