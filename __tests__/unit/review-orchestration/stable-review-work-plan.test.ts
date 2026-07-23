import { createStableReviewWorkPlan } from '../../../src/review-orchestration/domain';
import { canonicalizeReviewWorkSlots } from '../../../src/review-orchestration/application';
import {
  ReviewExecutionProviderKind,
  ReviewTaskKind,
} from '../../../src/review-orchestration/application';

describe('createStableReviewWorkPlan', () => {
  it('creates the same bounded provider-by-batch slots regardless of input order', () => {
    const first = createStableReviewWorkPlan(input());
    const reversed = createStableReviewWorkPlan({
      ...input(),
      providers: [...input().providers].reverse(),
      batches: [...input().batches].reverse(),
    });

    expect(reversed).toEqual(first);
    expect(first.assignments).toHaveLength(4);
    expect(first.workSlotsCanonicalJson).toBe(
      canonicalizeReviewWorkSlots(
        first.assignments.map((assignment) => assignment.workSlot)
      )
    );
    expect(
      first.assignments.map((assignment) => assignment.workSlot.workSlotId)
    ).toEqual(
      [...first.assignments]
        .map((assignment) => assignment.workSlot.workSlotId)
        .sort()
    );
  });

  it('rejects plans beyond the authorized slot ceiling', () => {
    expect(() =>
      createStableReviewWorkPlan({ ...input(), maxWorkSlots: 3 })
    ).toThrow('review_work_plan_slot_limit_exceeded');
  });

  it('rejects duplicate provider vote lanes', () => {
    const fixture = input();
    expect(() =>
      createStableReviewWorkPlan({
        ...fixture,
        providers: [
          fixture.providers[0],
          { ...fixture.providers[1], providerVoteIdentityHash: 'a'.repeat(64) },
        ],
      })
    ).toThrow('review_work_plan_vote_lane_duplicate');
  });
});

function input() {
  return {
    reviewRevisionHash: '1'.repeat(64),
    compatibilityKey: '2'.repeat(64),
    providers: [
      {
        providerName: 'codex/gpt-5.3-codex',
        providerKind: ReviewExecutionProviderKind.Codex,
        providerVoteIdentityHash: 'a'.repeat(64),
        required: true,
        attemptBudget: 2,
        retryPolicyVersion: 'retry-v1',
      },
      {
        providerName: 'claude/sonnet',
        providerKind: ReviewExecutionProviderKind.ClaudeCode,
        providerVoteIdentityHash: 'b'.repeat(64),
        required: false,
        attemptBudget: 1,
        retryPolicyVersion: 'retry-v1',
      },
    ],
    batches: [
      {
        batchId: 'batch-2',
        taskKind: ReviewTaskKind.FindingDiscovery,
        required: true,
      },
      {
        batchId: 'batch-1',
        taskKind: ReviewTaskKind.FindingDiscovery,
        required: true,
      },
    ],
    maxWorkSlots: 8,
    maxAttemptsPerSlot: 3,
  };
}
