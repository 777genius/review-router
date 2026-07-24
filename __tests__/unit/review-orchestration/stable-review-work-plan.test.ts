import {
  createStableReviewBatchId,
  createStableReviewWorkPlan,
} from '../../../src/review-orchestration/domain';
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
    expect(first.assignments.map((assignment) => assignment.batchId)).toEqual([
      'batch-2',
      'batch-2',
      'batch-1',
      'batch-1',
    ]);
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

  it('changes risk-first scheduling without changing batch or slot identity', () => {
    const first = createStableReviewWorkPlan(input());
    const rescheduled = createStableReviewWorkPlan({
      ...input(),
      batches: input().batches.map((batch) => ({
        ...batch,
        schedulingOrdinal: batch.schedulingOrdinal === 0 ? 1 : 0,
      })),
    });

    expect(rescheduled.planHash).toBe(first.planHash);
    expect(rescheduled.workSlotsCanonicalJson).toBe(
      first.workSlotsCanonicalJson
    );
    expect(
      rescheduled.assignments
        .map((assignment) => assignment.workSlot.workSlotId)
        .sort()
    ).toEqual(
      first.assignments
        .map((assignment) => assignment.workSlot.workSlotId)
        .sort()
    );
    expect(first.assignments[0].batchId).toBe('batch-2');
    expect(rescheduled.assignments[0].batchId).toBe('batch-1');
  });

  it('rejects ambiguous scheduling ordinals', () => {
    const fixture = input();
    expect(() =>
      createStableReviewWorkPlan({
        ...fixture,
        batches: fixture.batches.map((batch) => ({
          ...batch,
          schedulingOrdinal: 0,
        })),
      })
    ).toThrow('review_work_plan_scheduling_ordinal_duplicate');
  });
});

describe('createStableReviewBatchId', () => {
  it('depends on task kind and canonical membership/content, not member order', () => {
    const members = [
      batchMember('src/security.ts', '+secure'),
      batchMember('src/storage.ts', '+persist'),
    ];
    const first = createStableReviewBatchId({
      taskKind: ReviewTaskKind.FindingDiscovery,
      members,
    });
    const permuted = createStableReviewBatchId({
      taskKind: ReviewTaskKind.FindingDiscovery,
      members: [...members].reverse(),
    });
    const changed = createStableReviewBatchId({
      taskKind: ReviewTaskKind.FindingDiscovery,
      members: [
        batchMember('src/security.ts', '+secure'),
        batchMember('src/storage.ts', '+changed'),
      ],
    });
    const otherTask = createStableReviewBatchId({
      taskKind: ReviewTaskKind.LifecycleRevalidation,
      members,
    });

    expect(permuted).toBe(first);
    expect(changed).not.toBe(first);
    expect(otherTask).not.toBe(first);
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
        schedulingOrdinal: 0,
      },
      {
        batchId: 'batch-1',
        taskKind: ReviewTaskKind.FindingDiscovery,
        required: true,
        schedulingOrdinal: 1,
      },
    ],
    maxWorkSlots: 8,
    maxAttemptsPerSlot: 3,
  };
}

function batchMember(filename: string, patch: string) {
  return {
    filename,
    status: 'modified',
    additions: 1,
    deletions: 0,
    changes: 1,
    patch,
  };
}
