import {
  parseReviewFindingsStrict,
  parseReviewOutputLenient,
  parseReviewOutputStrict,
} from '../../../src/providers/review-output';

describe('review-output parsing', () => {
  it('parses findings and lifecycle revalidations from the strict object contract', () => {
    const parsed = parseReviewOutputStrict(
      JSON.stringify({
        findings: [
          {
            file: 'src/app.ts',
            startLine: null,
            line: 10,
            endLine: null,
            severity: 'major',
            title: 'Bug',
            message: 'Breaks at runtime',
            suggestion: null,
          },
        ],
        revalidations: [
          {
            targetId: 'rrt_123',
            fingerprint: 'f'.repeat(24),
            verdict: 'resolved',
            confidence: 0.92,
            evidence: [
              {
                path: 'src/app.ts',
                startLine: 10,
                endLine: 10,
                reason: 'Guard now handles the old null case.',
              },
            ],
            rationale: 'The old failure mode is gone.',
          },
        ],
      }),
      'provider'
    );

    expect(parsed.findings).toHaveLength(1);
    expect(parsed.revalidations).toEqual([
      expect.objectContaining({
        targetId: 'rrt_123',
        verdict: 'resolved',
        confidence: 0.92,
      }),
    ]);
  });

  it('keeps the legacy strict findings-array contract compatible', () => {
    const findings = parseReviewFindingsStrict(
      JSON.stringify([
        {
          file: 'src/app.ts',
          line: 10,
          severity: 'major',
          title: 'Bug',
          message: 'Breaks at runtime',
        },
      ]),
      'provider'
    );

    expect(findings).toHaveLength(1);
    expect(findings[0].title).toBe('Bug');
  });

  it('normalizes snake_case target IDs in lenient providers', () => {
    const parsed = parseReviewOutputLenient(
      JSON.stringify({
        findings: [],
        revalidations: [
          {
            target_id: 'rrt_snake',
            verdict: 'uncertain',
            rationale: 'Not enough context.',
          },
        ],
      })
    );

    expect(parsed.revalidations).toEqual([
      expect.objectContaining({
        targetId: 'rrt_snake',
        verdict: 'uncertain',
      }),
    ]);
  });
});
