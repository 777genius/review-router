import { Octokit } from '@octokit/rest';
import { ProgressTracker } from '../../../src/github/progress-tracker';
import { appendReviewSummaryMetadata } from '../../../src/github/summary-metadata';

describe('ProgressTracker', () => {
  let octokit: Octokit;
  let createCommentMock: jest.Mock;
  let updateCommentMock: jest.Mock;
  let listCommentsMock: jest.Mock;
  let tracker: ProgressTracker;

  const config = {
    owner: 'test-owner',
    repo: 'test-repo',
    prNumber: 123,
    updateStrategy: 'milestone' as const,
  };

  beforeEach(() => {
    createCommentMock = jest.fn();
    updateCommentMock = jest.fn();
    listCommentsMock = jest.fn().mockResolvedValue({ data: [] });

    octokit = {
      rest: {
        issues: {
          createComment: createCommentMock,
          updateComment: updateCommentMock,
          listComments: listCommentsMock,
        },
        pulls: {
          get: jest
            .fn()
            .mockResolvedValue({ data: { head: { sha: 'head-sha' } } }),
        },
      },
    } as any;

    tracker = new ProgressTracker(octokit, config);
  });

  describe('initialization', () => {
    it('should create initial progress comment', async () => {
      const mockComment = { data: { id: 456 } };
      createCommentMock.mockResolvedValue(mockComment as any);

      await tracker.initialize();

      expect(octokit.rest.issues.createComment).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        issue_number: 123,
        body: expect.stringContaining('🤖 ReviewRouter Progress'),
      });
    });

    it('should not reuse an existing finalized ReviewRouter summary', async () => {
      const mockComment = { data: { id: 456 } };
      createCommentMock.mockResolvedValue(mockComment as any);
      listCommentsMock.mockResolvedValue({
        data: [
          { id: 111, body: 'unrelated comment' },
          { id: 999, body: '# ReviewRouter\n\nold summary' },
        ],
      });

      await tracker.initialize();

      expect(createCommentMock).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        issue_number: 123,
        body: expect.stringContaining(
          '<!-- review-router-progress-tracker -->'
        ),
      });
      expect(updateCommentMock).not.toHaveBeenCalled();
    });

    it('should reuse a legacy AI Robot Review progress comment', async () => {
      listCommentsMock.mockResolvedValue({
        data: [
          {
            id: 999,
            body: '## 🤖 AI Robot Review Progress\n\n<!-- ai-robot-review-progress-tracker -->',
          },
        ],
      });

      await tracker.initialize();

      expect(createCommentMock).not.toHaveBeenCalled();
      expect(updateCommentMock).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        comment_id: 999,
        body: expect.stringContaining(
          '<!-- review-router-progress-tracker -->'
        ),
      });
    });

    it('should handle initialization failure gracefully', async () => {
      createCommentMock.mockRejectedValue(new Error('API Error'));

      // Should not throw
      await expect(tracker.initialize()).resolves.not.toThrow();
    });

    it('should not reuse or create progress comments when a newer summary exists', async () => {
      const newerSummary = appendReviewSummaryMetadata(
        '<!-- review-router-progress-tracker -->\n\n# ReviewRouter\nnewer',
        {
          reviewedHeadSha: 'head-sha',
          workflowRunId: '20',
          workflowRunAttempt: 1,
          summaryGeneratedAt: '2026-05-14T00:02:00Z',
        }
      );
      tracker = new ProgressTracker(octokit, {
        ...config,
        summaryMetadata: {
          reviewedHeadSha: 'head-sha',
          workflowRunId: '10',
          workflowRunAttempt: 1,
          summaryGeneratedAt: '2026-05-14T00:01:00Z',
        },
      });
      listCommentsMock.mockResolvedValue({
        data: [
          { id: 111, body: '# ReviewRouter\n\nold summary' },
          { id: 999, body: newerSummary },
        ],
      });

      await tracker.initialize();

      expect(createCommentMock).not.toHaveBeenCalled();
      expect(updateCommentMock).not.toHaveBeenCalled();
    });

    it('should find newer summaries beyond the first issue-comment page during initialization', async () => {
      const newerSummary = appendReviewSummaryMetadata(
        '<!-- review-router-progress-tracker -->\n\n# ReviewRouter\nnewer',
        {
          reviewedHeadSha: 'head-sha',
          workflowRunId: '20',
          workflowRunAttempt: 1,
          summaryGeneratedAt: '2026-05-14T00:02:00Z',
        }
      );
      tracker = new ProgressTracker(octokit, {
        ...config,
        summaryMetadata: {
          reviewedHeadSha: 'head-sha',
          workflowRunId: '10',
          workflowRunAttempt: 1,
          summaryGeneratedAt: '2026-05-14T00:01:00Z',
        },
      });
      listCommentsMock
        .mockResolvedValueOnce({
          data: Array.from({ length: 100 }, (_, index) => ({
            id: index + 1,
            body: 'unrelated',
          })),
        })
        .mockResolvedValueOnce({
          data: [{ id: 101, body: newerSummary }],
        });

      await tracker.initialize();

      expect(listCommentsMock).toHaveBeenCalledTimes(2);
      expect(createCommentMock).not.toHaveBeenCalled();
      expect(updateCommentMock).not.toHaveBeenCalled();
    });
  });

  describe('progress item management', () => {
    beforeEach(async () => {
      createCommentMock.mockResolvedValue({ data: { id: 456 } } as any);
      await tracker.initialize();
    });

    it('should add progress items', () => {
      tracker.addItem('test-item', 'Test Item Label');

      // Items are private, but we can verify through update behavior
      expect(() =>
        tracker.addItem('test-item', 'Test Item Label')
      ).not.toThrow();
    });

    it('should update progress with milestone strategy', async () => {
      tracker.addItem('test-item', 'Test Item');

      // Milestone strategy: only update on completed/failed
      await tracker.updateProgress('test-item', 'in_progress');
      expect(updateCommentMock).not.toHaveBeenCalled();

      await tracker.updateProgress('test-item', 'completed');
      expect(updateCommentMock).toHaveBeenCalledTimes(1);
    });

    it('should include details in progress update', async () => {
      tracker.addItem('test-item', 'Test Item');

      await tracker.updateProgress(
        'test-item',
        'completed',
        'Found 5 findings'
      );

      expect(updateCommentMock).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        comment_id: 456,
        body: expect.stringContaining('Found 5 findings'),
      });
    });

    it('should handle updates for non-existent items', async () => {
      await tracker.updateProgress('non-existent', 'completed');

      // Should not crash or update comment
      expect(updateCommentMock).not.toHaveBeenCalled();
    });
  });

  describe('comment formatting', () => {
    beforeEach(async () => {
      createCommentMock.mockResolvedValue({ data: { id: 456 } } as any);
      await tracker.initialize();
    });

    it('should render a status table without markdown checkboxes', async () => {
      tracker.addItem('item1', 'First Item');
      tracker.addItem('item2', 'Second Item');

      await tracker.updateProgress('item1', 'completed');
      await tracker.updateProgress('item2', 'pending');

      const lastCall = updateCommentMock.mock.calls[0];
      const body = lastCall?.[0]?.body as string;

      expect(body).toContain('| Step | Status | Details |');
      expect(body).toContain('| First Item | ✅ Done |');
      expect(body).toContain('| Second Item | ⏳ Waiting |');
      expect(body).not.toContain('[x]');
      expect(body).not.toContain('[ ]');
    });

    it('should include status emojis', async () => {
      tracker.addItem('completed-item', 'Completed');
      tracker.addItem('failed-item', 'Failed');
      tracker.addItem('in-progress-item', 'In Progress');
      tracker.addItem('pending-item', 'Pending');

      await tracker.updateProgress('completed-item', 'completed');
      await tracker.updateProgress('failed-item', 'failed');

      const lastCall =
        updateCommentMock.mock.calls[updateCommentMock.mock.calls.length - 1];
      const body = lastCall?.[0]?.body as string;

      expect(body).toContain('✅'); // Completed
      expect(body).toContain('❌'); // Failed
      expect(body).toContain('⏳'); // Pending
    });

    it('should show actionable provider auth failures without marking later steps failed', async () => {
      tracker.addItem('llm', 'LLM review');
      tracker.addItem('static', 'Static analysis');
      tracker.setFailure(
        new Error(
          'Codex access token could not be refreshed. Please reseed auth.json'
        )
      );

      await tracker.updateProgress(
        'llm',
        'failed',
        'All batches failed: codex/gpt-5.5'
      );
      await tracker.finalize(false);

      const lastCall =
        updateCommentMock.mock.calls[updateCommentMock.mock.calls.length - 1];
      const body = lastCall?.[0]?.body as string;

      expect(body).toContain(
        '**What failed:** Codex OAuth is stale or expired.'
      );
      expect(body).toContain('Reseed `CODEX_AUTH_JSON`');
      expect(body).toContain(
        '| LLM review | ❌ Failed | All batches failed: codex/gpt-5.5 |'
      );
      expect(body).toContain(
        '| Static analysis | ⏭️ Not run | Skipped after an earlier failure. |'
      );
      expect(body).not.toContain('[]❌');
    });

    it('should keep progress metadata hidden and minimal', async () => {
      tracker.setTotalCost(0.0123);

      tracker.addItem('item1', 'Test');
      await tracker.updateProgress('item1', 'completed');

      const lastCall = updateCommentMock.mock.calls[0];
      const body = lastCall?.[0]?.body as string;

      expect(body).toContain('<!-- review-router-progress-tracker -->');
      expect(body).not.toContain('**Duration**:');
      expect(body).not.toContain('**Cost**:');
      expect(body).not.toContain('**Last updated**:');
    });
  });

  describe('finalization', () => {
    beforeEach(async () => {
      createCommentMock.mockResolvedValue({ data: { id: 456 } } as any);
      await tracker.initialize();
    });

    it('should mark all items as completed on successful finalization', async () => {
      tracker.addItem('item1', 'Test 1');
      tracker.addItem('item2', 'Test 2');

      await tracker.finalize(true);

      const lastCall =
        updateCommentMock.mock.calls[updateCommentMock.mock.calls.length - 1];
      const body = lastCall?.[0]?.body as string;

      expect(body).toContain('✅'); // All items marked as completed on successful finalization
      expect(body).not.toContain('❌'); // No failures
    });

    it('should mark untouched items as not run on failure finalization', async () => {
      tracker.addItem('item1', 'Test 1');
      tracker.addItem('item2', 'Test 2');

      await tracker.finalize(false);

      const lastCall =
        updateCommentMock.mock.calls[updateCommentMock.mock.calls.length - 1];
      const body = lastCall?.[0]?.body as string;

      expect(body).toContain('⏭️ Not run');
      expect(body).not.toContain('❌');
    });

    it('should remove the progress marker when replacing progress with final summary', async () => {
      await expect(
        tracker.replaceWith('# ReviewRouter\n\nfinal summary')
      ).resolves.toBe(true);

      const lastCall =
        updateCommentMock.mock.calls[updateCommentMock.mock.calls.length - 1];
      const body = lastCall?.[0]?.body as string;

      expect(body).toContain('# ReviewRouter');
      expect(body).not.toContain('<!-- review-router-progress-tracker -->');
    });

    it('should skip final replacement when a newer summary appears after initialization', async () => {
      const newerSummary = appendReviewSummaryMetadata(
        '<!-- review-router-progress-tracker -->\n\n# ReviewRouter\nnewer',
        {
          reviewedHeadSha: 'head-sha',
          workflowRunId: '20',
          workflowRunAttempt: 1,
          summaryGeneratedAt: '2026-05-14T00:02:00Z',
        }
      );
      tracker = new ProgressTracker(octokit, {
        ...config,
        summaryMetadata: {
          reviewedHeadSha: 'head-sha',
          workflowRunId: '10',
          workflowRunAttempt: 1,
          summaryGeneratedAt: '2026-05-14T00:01:00Z',
        },
      });
      createCommentMock.mockResolvedValue({ data: { id: 456 } } as any);
      listCommentsMock.mockResolvedValueOnce({ data: [] });
      await tracker.initialize();
      updateCommentMock.mockClear();
      listCommentsMock.mockResolvedValueOnce({
        data: [{ id: 999, body: newerSummary }],
      });

      await expect(
        tracker.replaceWith('# ReviewRouter\n\nfinal summary')
      ).resolves.toBe(false);

      expect(updateCommentMock).not.toHaveBeenCalled();
    });

    it('should skip final replacement when a newer summary appears beyond the first issue-comment page', async () => {
      const newerSummary = appendReviewSummaryMetadata(
        '<!-- review-router-progress-tracker -->\n\n# ReviewRouter\nnewer',
        {
          reviewedHeadSha: 'head-sha',
          workflowRunId: '20',
          workflowRunAttempt: 1,
          summaryGeneratedAt: '2026-05-14T00:02:00Z',
        }
      );
      tracker = new ProgressTracker(octokit, {
        ...config,
        summaryMetadata: {
          reviewedHeadSha: 'head-sha',
          workflowRunId: '10',
          workflowRunAttempt: 1,
          summaryGeneratedAt: '2026-05-14T00:01:00Z',
        },
      });
      createCommentMock.mockResolvedValue({ data: { id: 456 } } as any);
      listCommentsMock.mockResolvedValueOnce({ data: [] });
      await tracker.initialize();
      updateCommentMock.mockClear();
      listCommentsMock
        .mockResolvedValueOnce({
          data: Array.from({ length: 100 }, (_, index) => ({
            id: index + 1,
            body: 'unrelated',
          })),
        })
        .mockResolvedValueOnce({
          data: [{ id: 101, body: newerSummary }],
        });

      await expect(
        tracker.replaceWith('# ReviewRouter\n\nfinal summary')
      ).resolves.toBe(false);

      expect(updateCommentMock).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    beforeEach(async () => {
      createCommentMock.mockResolvedValue({ data: { id: 456 } } as any);
      await tracker.initialize();
    });

    it('should handle update failures gracefully', async () => {
      updateCommentMock.mockRejectedValue(new Error('API Error'));

      tracker.addItem('item1', 'Test');

      // Should not throw even if update fails
      await expect(
        tracker.updateProgress('item1', 'completed')
      ).resolves.not.toThrow();
    });

    it('should handle finalize failures gracefully', async () => {
      updateCommentMock.mockRejectedValue(new Error('API Error'));

      tracker.addItem('item1', 'Test');

      // Should not throw even if finalize fails
      await expect(tracker.finalize(true)).resolves.not.toThrow();
    });

    it('should report replace failures without throwing', async () => {
      updateCommentMock.mockRejectedValue(new Error('API Error'));

      await expect(
        tracker.replaceWith('# ReviewRouter\n\nfinal summary')
      ).resolves.toBe(false);
    });
  });
});
