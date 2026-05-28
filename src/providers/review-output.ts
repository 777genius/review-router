import { Finding, ProviderLifecycleRevalidation } from '../types';

export function buildReviewFindingsSchema(): unknown {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['findings', 'revalidations'],
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'file',
            'startLine',
            'line',
            'endLine',
            'severity',
            'title',
            'message',
            'suggestion',
          ],
          properties: {
            file: { type: 'string' },
            startLine: { type: ['integer', 'null'] },
            line: { type: 'integer' },
            endLine: { type: ['integer', 'null'] },
            severity: {
              type: 'string',
              enum: ['critical', 'major', 'minor'],
            },
            title: { type: 'string' },
            message: { type: 'string' },
            suggestion: { type: ['string', 'null'] },
          },
        },
      },
      revalidations: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'targetId',
            'fingerprint',
            'verdict',
            'confidence',
            'evidence',
            'rationale',
          ],
          properties: {
            targetId: { type: 'string' },
            fingerprint: { type: ['string', 'null'] },
            verdict: {
              type: 'string',
              enum: ['resolved', 'still_valid', 'uncertain'],
            },
            confidence: {
              type: ['number', 'null'],
              minimum: 0,
              maximum: 1,
            },
            evidence: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['path', 'startLine', 'endLine', 'reason'],
                properties: {
                  path: { type: 'string' },
                  startLine: { type: ['integer', 'null'] },
                  endLine: { type: ['integer', 'null'] },
                  reason: { type: 'string' },
                },
              },
            },
            rationale: { type: 'string' },
          },
        },
      },
    },
  };
}

export interface ParsedReviewOutput {
  findings: Finding[];
  revalidations: ProviderLifecycleRevalidation[];
}

export function parseReviewFindingsStrict(
  content: string,
  providerLabel: string
): Finding[] {
  return parseReviewOutputStrict(content, providerLabel).findings;
}

export function parseReviewOutputStrict(
  content: string,
  providerLabel: string
): ParsedReviewOutput {
  const parsed = parseReviewJson(content, providerLabel);
  const findings = Array.isArray(parsed)
    ? parsed
    : (parsed as { findings?: unknown })?.findings;

  if (!Array.isArray(findings)) {
    throw new Error(
      `${providerLabel} returned invalid review JSON: expected an object with a findings array`
    );
  }

  const parsedFindings = findings.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new Error(
        `${providerLabel} returned invalid review JSON: findings[${index}] must be an object`
      );
    }

    const raw = item as Record<string, unknown>;
    const severity = raw.severity;
    const rawStartLine = raw.startLine ?? raw.start_line;
    const rawEndLine = raw.endLine ?? raw.end_line;
    const startLine = Number.isInteger(rawStartLine)
      ? (rawStartLine as number)
      : undefined;
    const endLine = Number.isInteger(rawEndLine)
      ? (rawEndLine as number)
      : undefined;
    const anchorLine = endLine ?? (raw.line as number);

    if (
      typeof raw.file !== 'string' ||
      !raw.file ||
      !Number.isInteger(raw.line) ||
      !['critical', 'major', 'minor'].includes(String(severity)) ||
      typeof raw.title !== 'string' ||
      !raw.title ||
      typeof raw.message !== 'string' ||
      !raw.message
    ) {
      throw new Error(
        `${providerLabel} returned invalid review JSON: findings[${index}] is missing required file, line, severity, title, or message`
      );
    }

    const finding: Finding = {
      file: raw.file,
      line: anchorLine,
      severity: severity as Finding['severity'],
      title: raw.title,
      message: raw.message,
    };

    if (
      startLine !== undefined &&
      endLine !== undefined &&
      startLine < endLine
    ) {
      finding.startLine = startLine;
      finding.endLine = endLine;
    }

    if (typeof raw.suggestion === 'string' && raw.suggestion.trim()) {
      finding.suggestion = raw.suggestion;
    }

    return finding;
  });

  const rawRevalidations = Array.isArray(parsed)
    ? []
    : (parsed as { revalidations?: unknown })?.revalidations;

  return {
    findings: parsedFindings,
    revalidations: parseRevalidationsLenient(rawRevalidations, providerLabel),
  };
}

export function parseReviewOutputLenient(content: string): ParsedReviewOutput {
  try {
    const parsed = parseReviewJson(content, 'provider');
    const findings = Array.isArray(parsed)
      ? (parsed as Finding[])
      : (((parsed as { findings?: unknown })?.findings || []) as Finding[]);
    const rawRevalidations = Array.isArray(parsed)
      ? []
      : (parsed as { revalidations?: unknown })?.revalidations;
    return {
      findings: Array.isArray(findings) ? findings : [],
      revalidations: parseRevalidationsLenient(rawRevalidations, 'provider'),
    };
  } catch {
    return { findings: [], revalidations: [] };
  }
}

function parseReviewJson(content: string, providerLabel: string): unknown {
  const trimmed = content.trim();
  const match = trimmed.match(/```json\s*([\s\S]*?)```/i);
  const source = match?.[1] ?? trimmed;

  try {
    return JSON.parse(source);
  } catch {
    throw new Error(
      `${providerLabel} returned invalid review JSON: response was not valid JSON`
    );
  }
}

function parseRevalidationsLenient(
  value: unknown,
  _providerLabel: string
): ProviderLifecycleRevalidation[] {
  if (!Array.isArray(value)) return [];
  const revalidations: ProviderLifecycleRevalidation[] = [];

  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const targetId =
      typeof raw.targetId === 'string'
        ? raw.targetId
        : typeof raw.target_id === 'string'
          ? raw.target_id
          : '';
    const verdict = String(raw.verdict || '');
    if (
      verdict !== 'resolved' &&
      verdict !== 'still_valid' &&
      verdict !== 'uncertain'
    ) {
      continue;
    }
    const evidence = parseRevalidationEvidence(raw.evidence);

    revalidations.push({
      targetId,
      fingerprint:
        typeof raw.fingerprint === 'string' ? raw.fingerprint : undefined,
      verdict,
      confidence:
        typeof raw.confidence === 'number'
          ? raw.confidence
          : typeof raw.confidence === 'string'
            ? Number(raw.confidence)
            : undefined,
      evidence,
      rationale: typeof raw.rationale === 'string' ? raw.rationale : undefined,
    });
  }

  return revalidations;
}

function parseRevalidationEvidence(value: unknown): Array<{
  path: string;
  startLine?: number;
  endLine?: number;
  reason: string;
}> {
  const values = Array.isArray(value) ? value : [value];
  const evidence: Array<{
    path: string;
    startLine?: number;
    endLine?: number;
    reason: string;
  }> = [];

  for (const entry of values) {
    if (typeof entry === 'string') {
      evidence.push({ path: '', reason: entry });
      continue;
    }
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const raw = entry as Record<string, unknown>;
    evidence.push({
      path: typeof raw.path === 'string' ? raw.path : '',
      startLine: Number.isInteger(raw.startLine)
        ? (raw.startLine as number)
        : undefined,
      endLine: Number.isInteger(raw.endLine)
        ? (raw.endLine as number)
        : undefined,
      reason: typeof raw.reason === 'string' ? raw.reason : '',
    });
  }

  return evidence;
}
