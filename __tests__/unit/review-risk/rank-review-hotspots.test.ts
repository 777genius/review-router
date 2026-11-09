import { rankReviewHotspots } from '../../../src/review-risk/domain/rank-review-hotspots';

describe('Risk-Aware Review Lite: pure, deterministic prioritization', () => {
  it('prioritizes a verified shared dependency over a much larger isolated change', () => {
    const result = rankReviewHotspots([
      { path: 'src/ui.tsx', changedLines: 320, dependents: 0 },
      { path: 'src/auth.ts', changedLines: 3, dependents: 4 },
    ]);
    expect(result).toEqual([
      {
        path: 'src/auth.ts',
        reason: 'shared-code',
        priority: 'attention',
        relatedFiles: 4,
      },
    ]);
  });

  it('keeps critical and major findings above other signals; never modifies severity', () => {
    const source = [
      { path: 'src/core.ts', severity: 'major' as const, line: 13, dependents: 8 },
      { path: 'src/payments.ts', severity: 'critical' as const, line: 8 },
      { path: 'src/edge.ts', severity: 'minor' as const, line: 2 },
    ];
    const before = JSON.stringify(source);
    const ranked = rankReviewHotspots(source);
    expect(ranked.map((item) => item.path)).toEqual([
      'src/payments.ts',
      'src/core.ts',
      'src/edge.ts',
    ]);
    expect(ranked[0]).toMatchObject({
      reason: 'critical-finding',
      priority: 'attention',
      line: 8,
    });
    expect(JSON.stringify(source)).toBe(before);
  });

  it('reports missing coverage as unknown instead of calling it safe', () => {
    expect(
      rankReviewHotspots([
        { path: 'src/not-reviewed.ts', coverage: 'unreviewed' },
        { path: 'src/unknown.ts' },
      ])
    ).toEqual([
      {
        path: 'src/not-reviewed.ts',
        reason: 'not-reviewed',
        priority: 'unknown',
      },
    ]);
    expect(rankReviewHotspots([{ path: 'src/unknown.ts' }])).toEqual([]);
  });

  it('deduplicates files, produces stable ties and bounds visible output', () => {
    const input = [
      { path: 'z.ts', severity: 'major' as const, line: 3 },
      { path: 'a.ts', severity: 'major' as const, line: 11 },
      { path: 'z.ts', severity: 'critical' as const, line: 7 },
      { path: 'b.ts', severity: 'major' as const, line: 12 },
      { path: 'c.ts', severity: 'major' as const, line: 13 },
    ];
    const ranked = rankReviewHotspots(input);
    expect(ranked.map((item) => item.path)).toEqual(['z.ts', 'a.ts', 'b.ts']);
    expect(ranked[0].line).toBe(7);
    expect(ranked).toHaveLength(3);
  });

  it('retains a critical finding after more than 2,000 changed-file candidates', () => {
    const normal = Array.from({ length: 2_100 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      changedLines: 2,
    }));
    expect(
      rankReviewHotspots([
        ...normal,
        { path: 'src/critical.ts', severity: 'critical', line: 7 },
      ])
    ).toEqual([
      {
        path: 'src/critical.ts',
        priority: 'attention',
        reason: 'critical-finding',
        line: 7,
      },
    ]);
  });

  it('prioritizes gaps in security-sensitive paths before speculative imports', () => {
    const ranked = rankReviewHotspots([
      { path: 'src/ordinary.ts', dependents: 8 },
      { path: 'src/normal.ts', coverage: 'unreviewed' },
      { path: 'src/auth/tokens.ts', coverage: 'unreviewed', sensitiveArea: true },
    ]);
    expect(ranked.map((x) => x.path)).toEqual([
      'src/auth/tokens.ts', 'src/normal.ts', 'src/ordinary.ts',
    ]);
    expect(ranked[0].priority).toBe('unknown');
  });

  it('never trusts nonfinite dependents or malformed line numbers', () => {
    const [result] = rankReviewHotspots([
      { path: 'src/one.ts', dependents: Number.POSITIVE_INFINITY, severity: 'minor', line: -1 },
    ]);
    expect(result.reason).toBe('minor-finding');
    expect(result.line).toBeUndefined();
    expect(result.relatedFiles).toBeUndefined();
  });
});
