import { createHash } from 'crypto';

const INLINE_MARKER_RE = /<!--\s*ai-robot-review-inline:([a-f0-9]{16})\s*-->/i;
const INLINE_MARKER_RE_GLOBAL = /<!--\s*ai-robot-review-inline:([a-f0-9]{16})\s*-->/gi;

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
  return `<!-- ai-robot-review-inline:${fingerprint} -->`;
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

export function isAiRobotInlineComment(body?: string | null): boolean {
  if (!body) return false;
  if (extractInlineFingerprint(body)) return true;
  return /^\*\*(?:🔴 Critical|🟡 Major|🔵 Minor)\s+-\s+.+?\*\*/.test(
    body.trim()
  );
}

function normalizeForSignature(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function extractSeverity(body: string): string | null {
  const match = body.match(/\*\*(?:[^\w*`]*\s*)?(critical|major|minor)\s*-/i);
  return match?.[1]?.toLowerCase() ?? null;
}
