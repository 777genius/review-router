/**
 * Plan 56, §8.2 normalization fixtures: verified-span-vs-HEAD before inline
 * placement or suggestion, ambiguous anchors never get inline suggestions,
 * invalid items are skipped with reasons, and output bounds fail explicitly.
 */

import {
  OcrOutputTooLargeError,
  normalizeOcrFindings,
  normalizeOcrRepoPath,
  verifyOcrSpan,
} from '../../../src/review-orchestration/infrastructure/ocr-review-normalization';
import type { OcrNativeComment } from '../../../src/review-orchestration/infrastructure/ocr-review-outcome-contract';

function comment(overrides: Partial<OcrNativeComment> = {}): OcrNativeComment {
  return {
    path: 'calc.ts',
    content: 'Subtraction looks unintended in add().',
    suggestionCode: 'return a + b;',
    existingCode: 'function add(a, b) { return a - b }',
    startLine: 1,
    endLine: 1,
    category: 'correctness',
    severity: 'high',
    ...overrides,
  };
}

function headFiles(map: Record<string, string>) {
  return { get: (path: string) => map[path] };
}

describe('verifyOcrSpan (verified span vs authorized HEAD)', () => {
  const content = [
    'function add(a, b) { return a - b }',
    'function mul(a, b) { return a * b }',
  ].join('\n');

  it('verifies an exact single-line span', () => {
    const span = verifyOcrSpan({
      comment: comment(),
      headContent: content,
    });
    expect(span).toEqual({ verified: true, startLine: 1, endLine: 1 });
  });

  it('verifies an exact multi-line range', () => {
    const span = verifyOcrSpan({
      comment: comment({
        existingCode: 'function add(a, b) { return a - b }\nfunction mul(a, b) { return a * b }',
        startLine: 1,
        endLine: 2,
      }),
      headContent: content,
    });
    expect(span).toEqual({ verified: true, startLine: 1, endLine: 2 });
  });

  it('rejects a colliding identical block as ambiguous', () => {
    const duplicated = `${content}\n${content.split('\n')[0]}`;
    const span = verifyOcrSpan({
      comment: comment(),
      headContent: duplicated,
    });
    expect(span).toEqual({ verified: false, reason: 'ambiguous_match' });
  });

  it('rejects a single matching line number without matching content', () => {
    const span = verifyOcrSpan({
      comment: comment({ existingCode: 'function sub(a, b) { return a - b }' }),
      headContent: content,
    });
    expect(span).toEqual({ verified: false, reason: 'content_mismatch' });
  });

  it('rejects a competing nearby added line outside the diff positions', () => {
    const span = verifyOcrSpan({
      comment: comment(),
      headContent: content,
      // Line 1 exists in HEAD but is not part of the current PR diff.
      diffPositions: new Map([[2, 2]]),
    });
    expect(span).toEqual({ verified: false, reason: 'outside_diff' });
  });

  it('rejects invalid ranges and missing existing code', () => {
    expect(
      verifyOcrSpan({
        comment: comment({ startLine: 0, endLine: 1 }),
        headContent: content,
      })
    ).toEqual({ verified: false, reason: 'invalid_range' });
    expect(
      verifyOcrSpan({
        comment: comment({ startLine: 2, endLine: 1 }),
        headContent: content,
      })
    ).toEqual({ verified: false, reason: 'invalid_range' });
    expect(
      verifyOcrSpan({
        comment: comment({ existingCode: null }),
        headContent: content,
      })
    ).toEqual({ verified: false, reason: 'missing_existing_code' });
  });
});

describe('normalizeOcrFindings (§8.2)', () => {
  const content = 'function add(a, b) { return a - b }';

  it('maps verified spans with line=end, start_line=start and the suggestion', () => {
    const { findings, diagnostics } = normalizeOcrFindings({
      comments: [comment({ severity: 'critical' })],
      headFiles: headFiles({ 'calc.ts': content }),
      diffPositions: new Map([['calc.ts', new Map([[1, 4]])]]),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file: 'calc.ts',
      line: 1,
      startLine: 1,
      endLine: 1,
      severity: 'critical',
      suggestion: 'return a + b;',
    });
    expect(diagnostics.partialFlagsRequired).toBe(false);
    expect(findings[0].title.length).toBeLessThanOrEqual(512);
    expect(findings[0].title).not.toContain('`');
  });

  it.each([
    ['critical', 'critical'],
    ['high', 'major'],
    ['medium', 'minor'],
    ['low', 'minor'],
    ['unknown-severity', 'minor'],
  ])('maps native severity %s to %s', (native, expected) => {
    const { findings, diagnostics } = normalizeOcrFindings({
      comments: [comment({ severity: native })],
      headFiles: headFiles({ 'calc.ts': content }),
    });
    expect(findings[0].severity).toBe(expected);
    if (native === 'unknown-severity') {
      expect(diagnostics.reasons).toContain('unclassified_native_severity');
      expect(diagnostics.partialFlagsRequired).toBe(true);
    }
  });

  it('never anchors or patches an unverified span, even with a suggestion', () => {
    const { findings, diagnostics } = normalizeOcrFindings({
      comments: [
        comment({
          // Verified-looking suggestion with a competing identical block:
          // the span is ambiguous so no inline suggestion may survive.
          existingCode: content,
        }),
      ],
      headFiles: headFiles({ 'calc.ts': `${content}\n${content}` }),
    });
    expect(findings[0].line).toBe(0);
    expect(findings[0].startLine).toBeUndefined();
    expect(findings[0].endLine).toBeUndefined();
    expect(findings[0].suggestion).toBeUndefined();
    expect(diagnostics.reasons).toContain('unverified_native_span');
    expect(diagnostics.partialFlagsRequired).toBe(true);
  });

  it('keeps multi-line verified ranges exact and drops colliding ranges', () => {
    const twoLines = 'line one\nline two';
    const verified = normalizeOcrFindings({
      comments: [
        comment({
          existingCode: twoLines,
          startLine: 1,
          endLine: 2,
          suggestionCode: 'fixed\nlines',
        }),
      ],
      headFiles: headFiles({ 'calc.ts': `${twoLines}\nline three` }),
    });
    expect(verified.findings[0]).toMatchObject({
      startLine: 1,
      line: 1,
      endLine: 2,
      suggestion: 'fixed\nlines',
    });
    const collided = normalizeOcrFindings({
      comments: [
        comment({ existingCode: 'same\nsame', startLine: 1, endLine: 2 }),
      ],
      headFiles: headFiles({ 'calc.ts': 'same\nsame\nsame\nsame' }),
    });
    expect(collided.findings[0].suggestion).toBeUndefined();
    expect(collided.findings[0].line).toBe(0);
    expect(collided.diagnostics.partialFlagsRequired).toBe(true);
  });

  it('skips invalid items with reason and keeps the valid remainder', () => {
    const { findings, diagnostics } = normalizeOcrFindings({
      comments: [
        comment({ path: '/etc/passwd' }),
        comment({ path: 'a/../../b.ts' }),
        comment({ content: '   ' }),
        comment(),
      ],
      headFiles: headFiles({ 'calc.ts': content }),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe('calc.ts');
    expect(diagnostics.skipped).toHaveLength(3);
    expect(
      diagnostics.skipped.every(
        (item) => item.reason === 'invalid_native_finding'
      )
    ).toBe(true);
    expect(diagnostics.partialFlagsRequired).toBe(true);
  });

  it('normalizes repository paths defensively', () => {
    expect(normalizeOcrRepoPath('./src/a.ts')).toBe('src/a.ts');
    expect(normalizeOcrRepoPath('C:\\evil')).toBeNull();
    expect(normalizeOcrRepoPath('a//b')).toBeNull();
    expect(normalizeOcrRepoPath('x'.repeat(1025))).toBeNull();
    expect(normalizeOcrRepoPath('a\0b')).toBeNull();
  });

  it('truncates the title to 512 characters', () => {
    const { findings } = normalizeOcrFindings({
      comments: [comment({ content: `${'T'.repeat(600)}\nbody` })],
      headFiles: headFiles({ 'calc.ts': content }),
    });
    expect(findings[0].title).toHaveLength(512);
    expect(findings[0].message.length).toBe(600 + 1 + 4);
  });

  it('fails explicitly on oversized output instead of truncating', () => {
    expect(() =>
      normalizeOcrFindings({
        comments: Array.from({ length: 201 }, (_, index) =>
          comment({ path: `f${index}.ts` })
        ),
        headFiles: headFiles({ 'calc.ts': content }),
      })
    ).toThrow(new OcrOutputTooLargeError('findings'));
    expect(() =>
      normalizeOcrFindings({
        comments: [comment({ content: 'x'.repeat(16385) })],
        headFiles: headFiles({ 'calc.ts': content }),
      })
    ).toThrow(new OcrOutputTooLargeError('message'));
  });
});
