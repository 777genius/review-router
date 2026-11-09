import { buildReviewHotspots } from '../../../src/review-risk/application/build-review-hotspots';

const files = [
  { filename: 'src/ui.tsx', status: 'modified' as const, additions: 300, deletions: 1 },
  { filename: 'src/auth.ts', status: 'modified' as const, additions: 2, deletions: 0 },
  { filename: 'src/utils.ts', status: 'modified' as const, additions: 4, deletions: 0 },
];

describe('Risk-Aware Review Lite: evidence adapters', () => {
  it('counts distinct changed-file direct imports with graph disabled', () => {
    const result = buildReviewHotspots({
      files, findings: [],
      contexts: [
        { file: 'src/ui.tsx', downstreamConsumers: ['./auth', 'react', './auth'] },
        { file: 'src/utils.ts', downstreamConsumers: ['./auth'] },
      ],
    });
    expect(result).toEqual([
      { path: 'src/auth.ts', reason: 'shared-code', priority: 'attention', relatedFiles: 2 },
    ]);
  });

  it('supports normalized graph context without calling heuristic getDependents', () => {
    const result = buildReviewHotspots({
      files, findings: [], contextsAreResolved: true,
      contexts: [
        { file: 'src/ui.tsx', downstreamConsumers: ['src/auth', 'react'] },
        { file: 'src/utils.ts', downstreamConsumers: ['src/auth', 'src/auth'] },
      ],
    });
    expect(result[0]).toMatchObject({ path: 'src/auth.ts', relatedFiles: 2 });
  });

  it('does not accept ambiguous extension-less matches or package imports', () => {
    const result = buildReviewHotspots({
      files: [
        { filename: 'src/auth.ts', status: 'modified', additions: 1, deletions: 0 },
        { filename: 'src/auth.tsx', status: 'modified', additions: 1, deletions: 0 },
        { filename: 'src/consumer.ts', status: 'modified', additions: 1, deletions: 0 },
        { filename: 'src/nested/auth.ts', status: 'modified', additions: 1, deletions: 0 },
      ],
      findings: [], contextsAreResolved: true,
      contexts: [{
        file: 'src/consumer.ts',
        downstreamConsumers: ['./auth', './nested/auth', '@org/auth', 'react'],
      }],
    });
    expect(result).toEqual([
      { path: 'src/nested/auth.ts', reason: 'shared-code', priority: 'attention', relatedFiles: 1 },
    ]);
  });

  it('rejects suffix coincidences, escaping imports, and irrelevant aliases', () => {
    expect(buildReviewHotspots({
      files: [
        { filename: 'src/auth.ts', status: 'modified', additions: 1, deletions: 0 },
        { filename: 'nested/src/auth.ts', status: 'modified', additions: 1, deletions: 0 },
        { filename: 'src/client.ts', status: 'modified', additions: 1, deletions: 0 },
      ],
      findings: [],
      contexts: [{
        file: 'src/client.ts',
        downstreamConsumers: ['../../src/auth', './authz', '@org/auth'],
      }],
    })).toEqual([]);
  });

  it('surfaces missing coverage first and reuses sensitive-file priority', () => {
    const result = buildReviewHotspots({
      files: [
        ...files,
        { filename: 'src/auth/session.ts', status: 'modified', additions: 2, deletions: 0 },
      ],
      findings: [],
      coverage: { files: [
        { path: 'src/ui.tsx', status: 'unreviewed' },
        { path: 'src/auth/session.ts', status: 'unreviewed' },
      ] },
      contexts: [{ file: 'src/ui.tsx', downstreamConsumers: ['./auth'] }],
    });
    expect(result.map((x) => x.path)).toEqual([
      'src/auth/session.ts', 'src/ui.tsx', 'src/auth.ts',
    ]);
    expect(result[0].priority).toBe('unknown');
  });

  it('keeps critical findings from a partially reviewed file', () => {
    expect(buildReviewHotspots({
      files,
      findings: [{ file: 'src/auth.ts', line: 33, severity: 'critical' }],
      coverage: { files: [{ path: 'src/auth.ts', status: 'metadata-only' }] },
    })[0]).toMatchObject({
      path: 'src/auth.ts', line: 33, reason: 'critical-finding', priority: 'attention',
    });
  });

  it('ignores removed files, findings outside the revision, and absent evidence', () => {
    expect(buildReviewHotspots({
      files: [
        { filename: 'deleted.ts', status: 'removed', additions: 0, deletions: 2 },
        files[0],
      ],
      findings: [
        { file: 'deleted.ts', line: 1, severity: 'critical' },
        { file: 'other.ts', line: 4, severity: 'critical' },
        { file: 'src/ui.tsx', line: 11, severity: 'major' },
      ],
    })).toEqual([
      { path: 'src/ui.tsx', line: 11, reason: 'major-finding', priority: 'attention' },
    ]);
    expect(buildReviewHotspots({ files, findings: [] })).toEqual([]);
  });

  it('never expands import matching above the PR context budget', () => {
    const many = Array.from({ length: 130 }, (_, i) => ({
      filename: 'src/f-' + i + '.ts',
      status: 'modified' as const,
      additions: 1, deletions: 0,
    }));
    expect(buildReviewHotspots({
      files: many, findings: [],
      contexts: [{ file: 'src/f-0.ts', downstreamConsumers: ['./f-1'] }],
    })).toEqual([]);
  });
});
