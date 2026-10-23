import type {
  ReviewMemoryBinding,
  ReviewMemoryBundle,
} from '../../src/control-plane/review-memory-v2';

/** Paired control-plane/Action wire fixture. No provider or customer data. */
export const reviewMemoryBinding: ReviewMemoryBinding = Object.freeze({
  authorizationId: 'authorization-memory-fixture',
  repositoryConnectionId: 'repository-memory-fixture',
  pullRequestNumber: 7,
  baseSha: 'a'.repeat(40),
  headSha: 'c'.repeat(40),
  reviewRevisionHash: 'e'.repeat(64),
});

export function reviewMemoryBundle(
  overrides: Partial<ReviewMemoryBundle> = {}
): ReviewMemoryBundle {
  return {
    protocolVersion: 2,
    ...reviewMemoryBinding,
    bundleId: 'bundle-memory-fixture',
    policyVersion: 'memory-policy-fixture-v2',
    providerGeneration: 'hindsight-generation-fixture',
    eligibilityEpoch: '17',
    expiresAt: '2099-01-01T00:00:00.000Z',
    degraded: false,
    reason: null,
    items: [
      {
        id: 'mem_rule',
        scope: 'workspace',
        kind: 'rule',
        body: 'All outbound calls require a bounded timeout.',
        revision: '3',
        sourceIds: ['source-rule'],
        statementAt: '2026-10-20T10:00:00.000Z',
        lastVerifiedAt: '2026-10-22T10:00:00.000Z',
      },
      {
        id: 'mem_exception',
        scope: 'repository',
        kind: 'exception',
        body: 'The offline replay harness can disable its timer.',
        revision: '2',
        sourceIds: ['source-exception'],
        statementAt: '2026-10-21T10:00:00.000Z',
        lastVerifiedAt: '2026-10-22T10:00:00.000Z',
        exceptionRuleId: 'mem_rule',
      },
      {
        id: 'mem_observation',
        scope: 'repository',
        kind: 'observation',
        body: 'The adapter used a 30 second timeout at this commit.',
        revision: '1',
        sourceIds: ['source-observation'],
        statementAt: '2026-10-21T11:00:00.000Z',
        lastVerifiedAt: '2026-10-22T10:00:00.000Z',
        observedCommitSha: 'b'.repeat(40),
      },
    ],
    ...overrides,
  };
}
