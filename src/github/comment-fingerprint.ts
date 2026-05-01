import { createHash } from 'crypto';

const INLINE_MARKER_RE = /<!--\s*(?:review-router|ai-robot-review)-inline:([a-f0-9]{16})\s*-->/i;
const INLINE_MARKER_RE_GLOBAL = /<!--\s*(?:review-router|ai-robot-review)-inline:([a-f0-9]{16})\s*-->/gi;
const MAX_NEARBY_LINE_DISTANCE = 12;

export interface InlineCommentReference {
  path: string | undefined;
  line: number | null | undefined;
  body: string;
}

export function signatureFromInlineComment(
  path: string | undefined,
  line: number | null | undefined,
  body: string
): string {
  const cleanBody = stripInlineFingerprintMarkers(body);
  const severity = extractSeverity(cleanBody);
  if (severity) {
    return [
      (path || 'unknown').toLowerCase(),
      String(line ?? 0),
      severity,
    ].join(':');
  }

  const titleMatch = cleanBody.match(/\*\*(.+?)\*\*/);
  const title = titleMatch
    ? titleMatch[1]
    : cleanBody.split('\n')[0] || 'unknown';

  return [
    (path || 'unknown').toLowerCase(),
    String(line ?? 0),
    normalizeForSignature(title),
  ].join(':');
}

export function fingerprintFromInlineComment(
  path: string | undefined,
  line: number | null | undefined,
  body: string
): string {
  return createHash('sha256')
    .update(signatureFromInlineComment(path, line, body))
    .digest('hex')
    .slice(0, 16);
}

export function inlineFingerprintMarker(fingerprint: string): string {
  return `<!-- review-router-inline:${fingerprint} -->`;
}

export function extractInlineFingerprint(body?: string | null): string | null {
  const match = body?.match(INLINE_MARKER_RE);
  return match?.[1]?.toLowerCase() ?? null;
}

export function appendInlineFingerprintMarker(
  body: string,
  path: string | undefined,
  line: number | null | undefined
): string {
  if (extractInlineFingerprint(body)) return body;
  return `${body.trimEnd()}\n\n${inlineFingerprintMarker(fingerprintFromInlineComment(path, line, body))}`;
}

export function stripInlineFingerprintMarkers(body: string): string {
  return body.replace(INLINE_MARKER_RE_GLOBAL, '').trim();
}

export function isReviewRouterInlineComment(body?: string | null): boolean {
  if (!body) return false;
  if (extractInlineFingerprint(body)) return true;
  return /^\*\*(?:🔴 Critical|🟡 Major|🔵 Minor)\s+-\s+.+?\*\*/.test(
    body.trim()
  );
}

export const isAiRobotInlineComment = isReviewRouterInlineComment;

export function isLikelySameInlineFinding(
  existing: InlineCommentReference,
  candidate: InlineCommentReference
): boolean {
  const existingPath = (existing.path || '').toLowerCase();
  const candidatePath = (candidate.path || '').toLowerCase();
  if (!existingPath || existingPath !== candidatePath) return false;

  const existingBody = stripInlineFingerprintMarkers(existing.body);
  const candidateBody = stripInlineFingerprintMarkers(candidate.body);
  const existingSeverity = extractSeverity(existingBody);
  const candidateSeverity = extractSeverity(candidateBody);
  if (existingSeverity && candidateSeverity && existingSeverity !== candidateSeverity) {
    return false;
  }

  const existingLine = existing.line ?? 0;
  const candidateLine = candidate.line ?? 0;
  const lineDistance = Math.abs(existingLine - candidateLine);
  const nearbyLine = lineDistance <= MAX_NEARBY_LINE_DISTANCE;

  const existingTitleTokens = tokenize(extractTitle(existingBody));
  const candidateTitleTokens = tokenize(extractTitle(candidateBody));
  const titleSimilarity = diceSimilarity(existingTitleTokens, candidateTitleTokens);

  const existingTokens = tokenize(semanticText(existingBody));
  const candidateTokens = tokenize(semanticText(candidateBody));
  const bodySimilarity = diceSimilarity(existingTokens, candidateTokens);

  const existingCodeTokens = extractCodeTokens(existingBody);
  const candidateCodeTokens = extractCodeTokens(candidateBody);
  const sharedCodeTokens = intersectionSize(existingCodeTokens, candidateCodeTokens);

  if (nearbyLine && titleSimilarity >= 0.45) return true;
  if (nearbyLine && bodySimilarity >= 0.38) return true;
  if (nearbyLine && sharedCodeTokens > 0 && bodySimilarity >= 0.24) return true;

  // Allow larger line shifts only when the model is clearly repeating the same issue.
  return titleSimilarity >= 0.6 && bodySimilarity >= 0.55;
}

function normalizeForSignature(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function extractSeverity(body: string): string | null {
  const match = body.match(/\*\*(?:[^\w*`]*\s*)?(critical|major|minor)\s*-/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function extractTitle(body: string): string {
  const titleMatch = body.match(/\*\*(.+?)\*\*/);
  return titleMatch?.[1] ?? body.split('\n')[0] ?? '';
}

function semanticText(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\*\*Severity:\*\*[\s\S]*?(?:\n\n|$)/gi, ' ')
    .replace(/\*\*Provider:\*\*[\s\S]*?(?:\n\n|$)/gi, ' ')
    .replace(/\*\*Suggestion:\*\*[\s\S]*?(?:\n\n|$)/gi, ' ');
}

function tokenize(value: string): Set<string> {
  const normalized = splitIdentifiers(value)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, ' ');
  const tokens = normalized
    .split(/\s+/)
    .map(token => token.trim())
    .filter(token => token.length >= 3 && !STOPWORDS.has(token));
  return new Set(tokens);
}

function extractCodeTokens(body: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of body.matchAll(/`([^`\n]{2,120})`/g)) {
    for (const token of tokenize(match[1])) {
      tokens.add(token);
    }
  }
  return tokens;
}

function splitIdentifiers(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_./:-]+/g, ' ');
}

function diceSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  return (2 * intersectionSize(a, b)) / (a.size + b.size);
}

function intersectionSize(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const token of a) {
    if (b.has(token)) count += 1;
  }
  return count;
}

const STOPWORDS = new Set([
  'about',
  'after',
  'also',
  'and',
  'are',
  'because',
  'before',
  'branch',
  'but',
  'can',
  'cannot',
  'comment',
  'could',
  'does',
  'every',
  'file',
  'for',
  'from',
  'has',
  'have',
  'into',
  'line',
  'lines',
  'major',
  'minor',
  'must',
  'not',
  'only',
  'return',
  'should',
  'that',
  'the',
  'this',
  'true',
  'use',
  'uses',
  'using',
  'when',
  'where',
  'will',
  'with',
  'would',
]);
