import {
  FileRiskTier,
  classifyFileRisk,
  prioritizeFilesByRisk,
} from '../../../src/review-execution/domain/file-risk-priority';
import {
  CreateReviewBatchPlanInput,
  createReviewBatchPlan,
} from '../../../src/review-execution/domain/review-batch-plan';
import { FileChange } from '../../../src/types';

function file(
  filename: string,
  overrides: Partial<FileChange> = {}
): FileChange {
  return {
    filename,
    status: 'modified',
    additions: 1,
    deletions: 0,
    changes: 1,
    patch: `@@ ${filename}`,
    ...overrides,
  };
}

describe('risk-first file planning', () => {
  it('orders risk tiers while preserving input order inside each tier', () => {
    const files = [
      file('src/ui/zebra.ts'),
      file('src/users/UserRepository.ts'),
      file('.github/actions/review/action.yml'),
      file('db/migrations/001_create_schema.sql'),
      file('src/session/store.ts'),
      file('src/ui/alpha.ts'),
      file('src/crypto/tokenSigner.ts'),
    ];

    expect(prioritizeFilesByRisk(files).map((item) => item.filename)).toEqual([
      'src/session/store.ts',
      'src/crypto/tokenSigner.ts',
      'db/migrations/001_create_schema.sql',
      'src/users/UserRepository.ts',
      '.github/actions/review/action.yml',
      'src/ui/zebra.ts',
      'src/ui/alpha.ts',
    ]);
    expect(files[0].filename).toBe('src/ui/zebra.ts');
  });

  it('classifies the required path families into strict tiers', () => {
    expect(classifyFileRisk('src/auth/access-token.ts')).toBe(
      FileRiskTier.Security
    );
    expect(classifyFileRisk('db/schema.ts')).toBe(FileRiskTier.Migration);
    expect(classifyFileRisk('src/storage/blob-store.ts')).toBe(
      FileRiskTier.Persistence
    );
    expect(classifyFileRisk('src/api/contracts.ts')).toBe(
      FileRiskTier.PublicContract
    );
    expect(classifyFileRisk('src/components/button.ts')).toBe(
      FileRiskTier.Normal
    );
  });
});

describe('review batch plan', () => {
  const input: CreateReviewBatchPlanInput = {
    batches: [
      [file('src/auth/session.ts')],
      [file('src/ui/button.ts'), file('src/ui/dialog.ts')],
    ],
    baseSha: 'base-sha',
    headSha: 'head-sha',
    compatibilityKey: 'review-v3',
    providerNames: ['zeta/provider', 'alpha/provider'],
  };

  it('produces stable SHA-256 plan and work keys', () => {
    const first = createReviewBatchPlan(input);
    const reorderedProviders = createReviewBatchPlan({
      ...input,
      providerNames: ['alpha/provider', 'zeta/provider'],
    });

    expect(first.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.planHash).toBe(reorderedProviders.planHash);
    expect(first.providerNames).toEqual(['alpha/provider', 'zeta/provider']);
    expect(first.batches.map((batch) => batch.id)).toEqual(
      reorderedProviders.batches.map((batch) => batch.id)
    );
    expect(first.batches.map((batch) => batch.id)).toHaveLength(2);
    expect(first.batches[0].id).toMatch(/^[a-f0-9]{64}$/);
    expect(first.batches[1].id).toMatch(/^[a-f0-9]{64}$/);
    expect(first.batches[0].id).not.toBe(first.batches[1].id);
  });

  it('changes the plan hash when stale execution inputs change', () => {
    const originalHash = createReviewBatchPlan(input).planHash;
    const staleInputs: CreateReviewBatchPlanInput[] = [
      { ...input, baseSha: 'stale-base' },
      { ...input, headSha: 'stale-head' },
      { ...input, compatibilityKey: 'review-v2' },
      { ...input, providerNames: ['different/provider'] },
      {
        ...input,
        batches: [
          [file('src/auth/session.ts', { patch: '@@ stale patch' })],
          input.batches[1],
        ],
      },
      { ...input, batches: [...input.batches].reverse() },
    ];

    for (const staleInput of staleInputs) {
      expect(createReviewBatchPlan(staleInput).planHash).not.toBe(originalHash);
    }
  });
});
