import { FeedbackFilter } from '../../../src/github/feedback';
import { GitHubClient } from '../../../src/github/client';
import { InlineComment } from '../../../src/types';
import { ProviderWeightTracker } from '../../../src/learning/provider-weights';
import { fingerprintFromInlineComment } from '../../../src/github/comment-fingerprint';

// Mock GitHubClient
jest.mock('../../../src/github/client');

type MockOctokit = {
  rest: {
    pulls: {
      listReviewComments: jest.Mock;
    };
    reactions: {
      listForPullRequestReviewComment: jest.Mock;
    };
  };
  paginate: jest.Mock;
};

describe('FeedbackFilter', () => {
  let feedbackFilter: FeedbackFilter;
  let mockClient: jest.Mocked<GitHubClient>;
  let mockOctokit: MockOctokit;

  beforeEach(() => {
    mockOctokit = {
      rest: {
        pulls: {
          listReviewComments: jest.fn(),
        },
        reactions: {
          listForPullRequestReviewComment: jest.fn(),
        },
      },
      paginate: jest.fn(),
    };

    mockClient = {
      octokit: mockOctokit,
      owner: 'test-owner',
      repo: 'test-repo',
    } as unknown as jest.Mocked<GitHubClient>;

    feedbackFilter = new FeedbackFilter(mockClient);
  });

  describe('loadSuppressed', () => {
    it('should return empty set when no comments exist', async () => {
      mockOctokit.paginate.mockResolvedValue([]);

      const suppressed = await feedbackFilter.loadSuppressed(123);

      expect(suppressed.size).toBe(0);
      expect(mockOctokit.paginate).toHaveBeenCalledWith(
        mockOctokit.rest.pulls.listReviewComments,
        {
          owner: 'test-owner',
          repo: 'test-repo',
          pull_number: 123,
          per_page: 100,
        }
      );
    });

    it('should identify suppressed comments with thumbs-down reactions', async () => {
      const mockComments = [
        {
          id: 1,
          path: 'src/file.ts',
          line: 10,
          body: '**Security Issue**\nThis is a finding',
        },
        {
          id: 2,
          path: 'src/other.ts',
          line: 20,
          body: '**Performance Issue**\nAnother finding',
        },
      ];

      mockOctokit.paginate.mockResolvedValue(mockComments);

      // First comment has thumbs-down, second doesn't
      mockOctokit.rest.reactions.listForPullRequestReviewComment
        .mockResolvedValueOnce({
          data: [{ content: '-1' }], // Thumbs down
        })
        .mockResolvedValueOnce({
          data: [{ content: '+1' }], // Thumbs up
        });

      const suppressed = await feedbackFilter.loadSuppressed(123);

      expect(suppressed.size).toBe(1);
      expect(suppressed.has('src/file.ts:10:security issue')).toBe(true);
      expect(suppressed.has('src/other.ts:20:performance issue')).toBe(false);
    });

    it('should handle multiple reactions on same comment', async () => {
      const mockComments = [
        {
          id: 1,
          path: 'src/file.ts',
          line: 10,
          body: '**Issue Title**\nDescription',
        },
      ];

      mockOctokit.paginate.mockResolvedValue(mockComments);
      mockOctokit.rest.reactions.listForPullRequestReviewComment.mockResolvedValue({
        data: [
          { content: '+1' }, // Thumbs up
          { content: '-1' }, // Thumbs down
          { content: 'laugh' }, // Other reaction
        ],
      });

      const suppressed = await feedbackFilter.loadSuppressed(123);

      expect(suppressed.size).toBe(1);
      expect(suppressed.has('src/file.ts:10:issue title')).toBe(true);
    });

    it('should handle errors gracefully when loading reactions', async () => {
      const mockComments = [
        {
          id: 1,
          path: 'src/file.ts',
          line: 10,
          body: '**Issue**\nDescription',
        },
      ];

      mockOctokit.paginate.mockResolvedValue(mockComments);
      mockOctokit.rest.reactions.listForPullRequestReviewComment.mockRejectedValue(
        new Error('API rate limited')
      );

      const suppressed = await feedbackFilter.loadSuppressed(123);

      // Should not throw, should return empty set
      expect(suppressed.size).toBe(0);
    });

    it('should handle errors when loading comments', async () => {
      mockOctokit.paginate.mockRejectedValue(new Error('Network error'));

      const suppressed = await feedbackFilter.loadSuppressed(123);

      // Should not throw, should return empty set
      expect(suppressed.size).toBe(0);
    });

    it('should extract title from bold text in comment body', async () => {
      const mockComments = [
        {
          id: 1,
          path: 'src/file.ts',
          line: 15,
          body: '**Extracted Title**\nMore details here',
        },
      ];

      mockOctokit.paginate.mockResolvedValue(mockComments);
      mockOctokit.rest.reactions.listForPullRequestReviewComment.mockResolvedValue({
        data: [{ content: '-1' }],
      });

      const suppressed = await feedbackFilter.loadSuppressed(123);

      expect(suppressed.has('src/file.ts:15:extracted title')).toBe(true);
    });

    it('should use first line as fallback when no bold text', async () => {
      const mockComments = [
        {
          id: 1,
          path: 'src/file.ts',
          line: 5,
          body: 'Plain text comment\nMore details',
        },
      ];

      mockOctokit.paginate.mockResolvedValue(mockComments);
      mockOctokit.rest.reactions.listForPullRequestReviewComment.mockResolvedValue({
        data: [{ content: '-1' }],
      });

      const suppressed = await feedbackFilter.loadSuppressed(123);

      expect(suppressed.has('src/file.ts:5:plain text comment')).toBe(true);
    });
  });

  describe('loadReviewCommentState', () => {
    it('tracks existing AI Robot Review inline comments without thumbs-down', async () => {
      mockOctokit.paginate.mockResolvedValue([
        {
          id: 1,
          path: 'src/file.ts',
          line: 10,
          body: '**🟡 Major - SQL injection**\n\nUse parameterized queries.',
        },
      ]);
      mockOctokit.rest.reactions.listForPullRequestReviewComment.mockResolvedValue({
        data: [],
      });

      const state = await feedbackFilter.loadReviewCommentState(123);

      expect(state.suppressed.size).toBe(0);
      expect(state.alreadyPosted.has('src/file.ts:10:major')).toBe(true);
      expect(feedbackFilter.shouldPost(
        {
          path: 'src/file.ts',
          line: 10,
          side: 'RIGHT',
          body: '**🟡 Major - SQL injection**\n\nUse parameterized queries.',
        },
        state
      )).toBe(false);
    });

    it('does not treat human review comments as already posted', async () => {
      mockOctokit.paginate.mockResolvedValue([
        {
          id: 1,
          path: 'src/file.ts',
          line: 10,
          body: '**SQL injection**\n\nHuman reviewer comment.',
        },
      ]);
      mockOctokit.rest.reactions.listForPullRequestReviewComment.mockResolvedValue({
        data: [],
      });

      const state = await feedbackFilter.loadReviewCommentState(123);

      expect(state.alreadyPosted.size).toBe(0);
    });

    it('uses hidden inline fingerprint markers for stable duplicate detection', async () => {
      const existingBody =
        '**🟡 Major - SQL injection**\n\nUse parameterized queries.';
      const fingerprint = fingerprintFromInlineComment(
        'src/file.ts',
        10,
        existingBody
      );
      mockOctokit.paginate.mockResolvedValue([
        {
          id: 1,
          path: 'src/file.ts',
          line: 10,
          body: `${existingBody}\n\n<!-- ai-robot-review-inline:${fingerprint} -->`,
        },
      ]);
      mockOctokit.rest.reactions.listForPullRequestReviewComment.mockResolvedValue({
        data: [],
      });

      const state = await feedbackFilter.loadReviewCommentState(123);

      expect(state.alreadyPosted.has(fingerprint)).toBe(true);
      expect(
        feedbackFilter.shouldPost(
          {
            path: 'src/file.ts',
            line: 10,
            side: 'RIGHT',
            body: existingBody,
          },
          state
        )
      ).toBe(false);
    });

    it('blocks duplicates when model rewrites the title for the same severity and line', async () => {
      mockOctokit.paginate.mockResolvedValue([
        {
          id: 1,
          path: 'src/file.ts',
          line: 10,
          body: '**🟡 Major - Unknown plan crashes lookup**\n\nUse a fallback.',
        },
      ]);
      mockOctokit.rest.reactions.listForPullRequestReviewComment.mockResolvedValue({
        data: [],
      });

      const state = await feedbackFilter.loadReviewCommentState(123);

      expect(feedbackFilter.shouldPost(
        {
          path: 'src/file.ts',
          line: 10,
          side: 'RIGHT',
          body: '**🟡 Major - Missing plan crashes billing lookup**\n\nUse a fallback.',
        },
        state
      )).toBe(false);
    });
  });

  describe('shouldPost', () => {
    it('should allow posting when comment is not suppressed', () => {
      const comment: InlineComment = {
        path: 'src/file.ts',
        line: 10,
        side: 'RIGHT',
        body: '**Issue Title**\nDescription',
      };

      const suppressed = new Set<string>();
      const result = feedbackFilter.shouldPost(comment, suppressed);

      expect(result).toBe(true);
    });

    it('should block posting when comment is suppressed', () => {
      const comment: InlineComment = {
        path: 'src/file.ts',
        line: 10,
        side: 'RIGHT',
        body: '**Issue Title**\nDescription',
      };

      const suppressed = new Set<string>(['src/file.ts:10:issue title']);
      const result = feedbackFilter.shouldPost(comment, suppressed);

      expect(result).toBe(false);
    });

    it('should be case-insensitive for file paths and titles', () => {
      const comment: InlineComment = {
        path: 'src/File.TS',
        line: 10,
        side: 'RIGHT',
        body: '**Issue TITLE**\nDescription',
      };

      const suppressed = new Set<string>(['src/file.ts:10:issue title']);
      const result = feedbackFilter.shouldPost(comment, suppressed);

      expect(result).toBe(false);
    });

    it('should differentiate between different line numbers', () => {
      const comment1: InlineComment = {
        path: 'src/file.ts',
        line: 10,
        side: 'RIGHT',
        body: '**Issue**\nDescription',
      };

      const comment2: InlineComment = {
        path: 'src/file.ts',
        line: 20,
        side: 'RIGHT',
        body: '**Issue**\nDescription',
      };

      const suppressed = new Set<string>(['src/file.ts:10:issue']);

      expect(feedbackFilter.shouldPost(comment1, suppressed)).toBe(false);
      expect(feedbackFilter.shouldPost(comment2, suppressed)).toBe(true);
    });

    it('should differentiate between different files', () => {
      const comment1: InlineComment = {
        path: 'src/file1.ts',
        line: 10,
        side: 'RIGHT',
        body: '**Issue**\nDescription',
      };

      const comment2: InlineComment = {
        path: 'src/file2.ts',
        line: 10,
        side: 'RIGHT',
        body: '**Issue**\nDescription',
      };

      const suppressed = new Set<string>(['src/file1.ts:10:issue']);

      expect(feedbackFilter.shouldPost(comment1, suppressed)).toBe(false);
      expect(feedbackFilter.shouldPost(comment2, suppressed)).toBe(true);
    });
  });

  describe('negative feedback recording', () => {
    it('records negative feedback when comment has thumbs-down and provider', async () => {
      const mockWeightTracker = {
        recordFeedback: jest.fn().mockResolvedValue(undefined),
      } as unknown as ProviderWeightTracker;

      const filter = new FeedbackFilter(mockClient, mockWeightTracker);

      // Mock comment with provider attribution and thumbs-down
      mockOctokit.paginate.mockResolvedValue([
        {
          id: 1,
          path: 'test.ts',
          line: 10,
          body: '**Issue Title**\n\n**Provider:** `claude`',
        },
      ]);
      mockOctokit.rest.reactions.listForPullRequestReviewComment.mockResolvedValue({
        data: [{ content: '-1' }],
      });

      await filter.loadSuppressed(123);

      expect(mockWeightTracker.recordFeedback).toHaveBeenCalledWith('claude', '👎');
    });

    it('does not record feedback when no provider in comment', async () => {
      const mockWeightTracker = {
        recordFeedback: jest.fn().mockResolvedValue(undefined),
      } as unknown as ProviderWeightTracker;

      const filter = new FeedbackFilter(mockClient, mockWeightTracker);

      // Mock comment without provider attribution
      mockOctokit.paginate.mockResolvedValue([
        {
          id: 1,
          path: 'test.ts',
          line: 10,
          body: '**Issue Title**\n\nSome description without provider',
        },
      ]);
      mockOctokit.rest.reactions.listForPullRequestReviewComment.mockResolvedValue({
        data: [{ content: '-1' }],
      });

      await filter.loadSuppressed(123);

      expect(mockWeightTracker.recordFeedback).not.toHaveBeenCalled();
    });

    it('works without weight tracker (backward compatible)', async () => {
      const filter = new FeedbackFilter(mockClient);

      mockOctokit.paginate.mockResolvedValue([
        {
          id: 1,
          path: 'test.ts',
          line: 10,
          body: '**Issue Title**\n\n**Provider:** `claude`',
        },
      ]);
      mockOctokit.rest.reactions.listForPullRequestReviewComment.mockResolvedValue({
        data: [{ content: '-1' }],
      });

      // Should not throw, suppression still works
      const suppressed = await filter.loadSuppressed(123);
      expect(suppressed.size).toBe(1);
    });

    it('extracts provider and records feedback for multiple dismissals', async () => {
      const mockWeightTracker = {
        recordFeedback: jest.fn().mockResolvedValue(undefined),
      } as unknown as ProviderWeightTracker;

      const filter = new FeedbackFilter(mockClient, mockWeightTracker);

      // Mock multiple comments with different providers
      mockOctokit.paginate.mockResolvedValue([
        {
          id: 1,
          path: 'test.ts',
          line: 10,
          body: '**Issue 1**\n\n**Provider:** `openai`',
        },
        {
          id: 2,
          path: 'test.ts',
          line: 20,
          body: '**Issue 2**\n\n**Provider:** `anthropic`',
        },
      ]);
      mockOctokit.rest.reactions.listForPullRequestReviewComment
        .mockResolvedValueOnce({
          data: [{ content: '-1' }],
        })
        .mockResolvedValueOnce({
          data: [{ content: '-1' }],
        });

      await filter.loadSuppressed(123);

      expect(mockWeightTracker.recordFeedback).toHaveBeenCalledWith('openai', '👎');
      expect(mockWeightTracker.recordFeedback).toHaveBeenCalledWith('anthropic', '👎');
      expect(mockWeightTracker.recordFeedback).toHaveBeenCalledTimes(2);
    });

    it('does not record feedback when no thumbs-down reaction', async () => {
      const mockWeightTracker = {
        recordFeedback: jest.fn().mockResolvedValue(undefined),
      } as unknown as ProviderWeightTracker;

      const filter = new FeedbackFilter(mockClient, mockWeightTracker);

      mockOctokit.paginate.mockResolvedValue([
        {
          id: 1,
          path: 'test.ts',
          line: 10,
          body: '**Issue Title**\n\n**Provider:** `claude`',
        },
      ]);
      mockOctokit.rest.reactions.listForPullRequestReviewComment.mockResolvedValue({
        data: [{ content: '+1' }], // Thumbs up, not down
      });

      await filter.loadSuppressed(123);

      expect(mockWeightTracker.recordFeedback).not.toHaveBeenCalled();
    });
  });
});
