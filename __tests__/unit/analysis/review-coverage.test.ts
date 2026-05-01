import { buildReviewCoverage } from '../../../src/analysis/review-coverage';
import { PRContext, ReviewConfig } from '../../../src/types';

const config = {
  smartDiffCompaction: true,
  diffMaxBytes: 10_000,
  maxFullDiffFileBytes: 200,
  maxFullDiffFileChanges: 20,
  codexAgenticContext: true,
} as ReviewConfig;

function pr(overrides: Partial<PRContext> = {}): PRContext {
  return {
    number: 1,
    title: 'Test PR',
    body: '',
    author: 'octocat',
    draft: false,
    labels: [],
    files: [
      {
        filename: 'src/app.ts',
        status: 'modified',
        additions: 2,
        deletions: 1,
        changes: 3,
      },
      {
        filename: 'db/migrations/001.sql',
        status: 'added',
        additions: 200,
        deletions: 0,
        changes: 200,
      },
      {
        filename: 'assets/logo.png',
        status: 'added',
        additions: 0,
        deletions: 0,
        changes: 0,
      },
    ],
    diff: [
      'diff --git a/src/app.ts b/src/app.ts',
      '@@ -1,2 +1,3 @@',
      ' export function ok() {',
      '+  return true;',
      ' }',
      'diff --git a/db/migrations/001.sql b/db/migrations/001.sql',
      '@@ -0,0 +1,200 @@',
      ...Array.from({ length: 50 }, (_, i) => `+CREATE TABLE t${i}(id int);`),
    ].join('\n'),
    additions: 202,
    deletions: 1,
    baseSha: 'base',
    headSha: 'head',
    ...overrides,
  };
}

describe('buildReviewCoverage', () => {
  it('reports full, compacted, metadata-only, and skipped files', () => {
    const coverage = buildReviewCoverage(pr(), config, {
      totalFiles: 4,
      skippedFiles: [
        {
          filename: 'package-lock.json',
          status: 'modified',
          additions: 10,
          deletions: 10,
          changes: 20,
        },
      ],
    });

    expect(coverage.totalFiles).toBe(4);
    expect(coverage.filesConsidered).toBe(3);
    expect(coverage.fullDiffFiles).toBe(1);
    expect(coverage.compactedFiles).toBe(1);
    expect(coverage.metadataOnlyFiles).toBe(1);
    expect(coverage.skippedFiles).toBe(1);
    expect(coverage.agenticContext).toBe(true);
    expect(coverage.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'src/app.ts', status: 'full' }),
        expect.objectContaining({
          path: 'db/migrations/001.sql',
          status: 'compacted',
          reason: 'migration artifact',
        }),
        expect.objectContaining({
          path: 'assets/logo.png',
          status: 'metadata-only',
        }),
        expect.objectContaining({
          path: 'package-lock.json',
          status: 'skipped',
        }),
      ])
    );
  });

  it('marks files trimmed by the prompt byte budget as metadata-only', () => {
    const coverage = buildReviewCoverage(pr(), { ...config, diffMaxBytes: 120 }, {
      totalFiles: 3,
    });

    expect(coverage.metadataOnlyFiles).toBeGreaterThan(0);
    expect(coverage.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'db/migrations/001.sql',
          status: 'metadata-only',
          reason: 'trimmed by prompt byte budget',
        }),
      ])
    );
  });
});
