import {
  appendReviewSummaryMetadata,
  shouldSkipSummaryWriteForExisting,
} from '../../../src/github/summary-metadata';

describe('summary metadata write guard', () => {
  it('skips replacing a newer summary for a different reviewed head', () => {
    const existing = appendReviewSummaryMetadata('newer summary', {
      reviewedHeadSha: 'new-head',
      workflowRunId: '200',
      workflowRunAttempt: 1,
      lifecycleMode: 'resolve',
      lifecycleSchemaVersion: 'review-thread-lifecycle-v1',
      summaryGeneratedAt: '2026-05-14T10:00:00Z',
    });

    const result = shouldSkipSummaryWriteForExisting(existing, {
      reviewedHeadSha: 'old-head',
      workflowRunId: '100',
      workflowRunAttempt: 1,
      lifecycleMode: 'resolve',
      lifecycleSchemaVersion: 'review-thread-lifecycle-v1',
      summaryGeneratedAt: '2026-05-14T09:00:00Z',
    });

    expect(result).toEqual({
      shouldSkip: true,
      reason: 'newer_summary_exists',
    });
  });

  it('allows a newer run to replace an older summary from another head', () => {
    const existing = appendReviewSummaryMetadata('older summary', {
      reviewedHeadSha: 'old-head',
      workflowRunId: '100',
      workflowRunAttempt: 1,
      lifecycleMode: 'resolve',
      lifecycleSchemaVersion: 'review-thread-lifecycle-v1',
      summaryGeneratedAt: '2026-05-14T09:00:00Z',
    });

    const result = shouldSkipSummaryWriteForExisting(existing, {
      reviewedHeadSha: 'new-head',
      workflowRunId: '200',
      workflowRunAttempt: 1,
      lifecycleMode: 'resolve',
      lifecycleSchemaVersion: 'review-thread-lifecycle-v1',
      summaryGeneratedAt: '2026-05-14T10:00:00Z',
    });

    expect(result.shouldSkip).toBe(false);
  });
});
