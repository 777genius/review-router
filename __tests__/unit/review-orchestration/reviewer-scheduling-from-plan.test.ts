import { reviewerSchedulingFromPlan } from '../../../src/review-orchestration/infrastructure/production-t0-review-runner';
import type { ReviewReviewerPlan } from '../../../src/control-plane/generated/review-action-v2/review-reviewer-plan';

const plan = {
  primaryReviewerId: 'a',
  maxParallelReviewers: 1,
  inlineMinAgreement: 1,
  reviewers: [],
  concurrencyGroups: [{ concurrencyGroupId: 'group', maxParallel: 1 }],
};

describe('reviewer scheduling from an admitted plan', () => {
  it('carries the ordered fallback mode only from a version 2 plan', () => {
    expect(
      reviewerSchedulingFromPlan({
        ...plan,
        planVersion: 2,
        providerMode: 'fallback',
      } as ReviewReviewerPlan)
    ).toEqual({
      providerMode: 'fallback',
      maxParallelReviewers: 1,
      reviewers: [],
      concurrencyGroups: [{ id: 'group', maxParallel: 1 }],
    });
    expect(
      reviewerSchedulingFromPlan({
        ...plan,
        planVersion: 1,
      } as ReviewReviewerPlan)
    ).not.toHaveProperty('providerMode');
  });
});
