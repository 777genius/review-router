import { Finding } from '../types';

export function buildReviewFindingsSchema(): unknown {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['findings'],
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
    },
  };
}

export function parseReviewFindingsStrict(
  content: string,
  providerLabel: string
): Finding[] {
  const parsed = parseReviewJson(content, providerLabel);
  const findings = Array.isArray(parsed)
    ? parsed
    : (parsed as { findings?: unknown })?.findings;

  if (!Array.isArray(findings)) {
    throw new Error(
      `${providerLabel} returned invalid review JSON: expected an object with a findings array`
    );
  }

  return findings.map((item, index) => {
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
