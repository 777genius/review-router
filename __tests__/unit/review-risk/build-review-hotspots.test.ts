import { buildReviewHotspots } from '../../../src/review-risk/application/build-review-hotspots';

const files = [
  { filename: 'src/ui.tsx', status: 'modified' as const, additions: 300, deletions: 1, changes: 301 },
  { filename: 'src/auth.ts', status: 'modified' as const, additions: 2, deletions: 0, changes: 2 },
  { filename: 'src/utils.ts', status: 'modified' as const, additions: 4, deletions: 0, changes: 4 },
];

describe('Risk-Aware Review Lite: adapters', () => {
  it('uses an existing graph only and counts distinct changed dependents', () => {
    const graph = { getDependents: jest.fn((file: string) =>
      file === 'src/auth.ts' ? ['src/ui.tsx', 'src/utils.ts', 'src/utils.ts', '../other.ts'] : []
    ) };
    const result = buildReviewHotspots({ files, findings: [], graph });
    expect(graph.getDependents).toHaveBeenCalledTimes(3);
    expect(result).toEqual([
      {
        path: 'src/auth.ts',
        reason: 'shared-code',
        priority: 'attention',
        relatedFiles: 2,
      },
    ]);
  });

  it('does not build graph or infer safety where no graph exists', () => {
    expect(buildReviewHotspots({ files, findings: [] })).toEqual([]);
  });

  it('retains a serious finding even when the corresponding file was not fully reviewed', () => {
    const result = buildReviewHotspots({
      files,
      findings: [{ file: 'src/auth.ts', line: 33, severity: 'critical' }],
      coverage: {
        files: [{ path: 'src/auth.ts', status: 'metadata-only' }],
      },
    });
    expect(result).toEqual([
      {
        path: 'src/auth.ts',
        line: 33,
        reason: 'critical-finding',
        priority: 'attention',
      },
    ]);
  });

  it('shows missing coverage without inventing findings', () => {
    const result = buildReviewHotspots({
      files,
      findings: [],
      coverage: { files: [{ path: 'src/utils.ts', status: 'unreviewed' }] },
    });
    expect(result).toEqual([
      { path: 'src/utils.ts', reason: 'not-reviewed', priority: 'unknown' },
    ]);
  });

  it('ignores removed files, findings outside the change and graph errors', () => {
    const result = buildReviewHotspots({
      files: [
        { filename: 'deleted.ts', status: 'removed', additions: 0, deletions: 2, changes: 2 },
        files[0],
      ],
      findings: [
        { file: 'deleted.ts', line: 1, severity: 'critical' },
        { file: 'other.ts', line: 4, severity: 'critical' },
        { file: 'src/ui.tsx', line: 11, severity: 'major' },
      ],
      graph: { getDependents: () => { throw new Error('graph unavailable'); } },
    });
    expect(result).toEqual([
      { path: 'src/ui.tsx', line: 11, reason: 'major-finding', priority: 'attention' },
    ]);
  });

  it('does not query the experimental graph for an oversized PR', () => {
    const graph = { getDependents: jest.fn(() => ['src/test.ts']) };
    const many = Array.from({ length: 130 }, (_, i) => ({
      filename: `src/f-${i}.ts`,
      status: 'modified' as const,
      additions: 1,
      deletions: 0,
      changes: 1,
    }));
    buildReviewHotspots({ files: many, findings: [], graph });
    expect(graph.getDependents).not.toHaveBeenCalled();
  });
});
