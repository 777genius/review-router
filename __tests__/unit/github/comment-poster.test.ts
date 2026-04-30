import { CommentPoster } from '../../../src/github/comment-poster';
import { GitHubClient } from '../../../src/github/client';
import { InlineComment, FileChange } from '../../../src/types';
import { logger } from '../../../src/utils/logger';

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('CommentPoster', () => {
  let mockClient: jest.Mocked<GitHubClient>;
  let mockOctokit: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockOctokit = {
      rest: {
        issues: {
          createComment: jest.fn().mockResolvedValue({}),
        },
        pulls: {
          createReview: jest.fn().mockResolvedValue({}),
        },
      },
    };

    mockClient = {
      octokit: mockOctokit,
      owner: 'test-owner',
      repo: 'test-repo',
    } as any;
  });

  describe('Normal Mode', () => {
    it('posts summary comment', async () => {
      const poster = new CommentPoster(mockClient, false);
      const body = 'Test summary';

      await poster.postSummary(123, body, false); // Don't update existing

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        issue_number: 123,
        body: expect.stringContaining('Test summary'),
      });
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining('<!-- ai-robot-review-bot -->'),
        })
      );
    });

    it('posts inline comments', async () => {
      const poster = new CommentPoster(mockClient, false);
      const comments: InlineComment[] = [
        {
          path: 'src/test.ts',
          line: 10,
          side: 'RIGHT' as const,
          body: 'Test comment',
        },
      ];
      const files: FileChange[] = [
        {
          filename: 'src/test.ts',
          status: 'modified',
          additions: 5,
          deletions: 2,
          changes: 7,
          patch: '@@ -8,3 +8,4 @@\n line8\n line9\n+line10\n line11',
        },
      ];

      await poster.postInline(123, comments, files);

      const reviewCall = mockOctokit.rest.pulls.createReview.mock.calls[0][0];
      expect(reviewCall.comments[0]).toEqual(
        expect.objectContaining({
          path: 'src/test.ts',
          line: 10,
          side: 'RIGHT',
          body: 'Test comment',
        })
      );
      expect(reviewCall.comments[0]).not.toHaveProperty('position');
      expect(mockOctokit.rest.pulls.createReview).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        pull_number: 123,
        event: 'COMMENT',
        comments: expect.arrayContaining([
          expect.objectContaining({
            path: 'src/test.ts',
            body: 'Test comment',
          }),
        ]),
      });
    });

    it('anchors inline comments to the most relevant nearby added line', async () => {
      const poster = new CommentPoster(mockClient, false);
      const comments: InlineComment[] = [
        {
          path: 'src/users.js',
          line: 9,
          side: 'RIGHT' as const,
          body: '**🔴 Critical - SQL injection**\n\nThe email value is inserted directly into the SQL string.',
        },
      ];
      const files: FileChange[] = [
        {
          filename: 'src/users.js',
          status: 'modified',
          additions: 5,
          deletions: 0,
          changes: 5,
          patch: [
            '@@ -5,3 +5,8 @@',
            '   }',
            '   return id;',
            ' }',
            '+',
            '+export async function findUserByEmail(db, email) {',
            "+  const rows = await db.query(`SELECT * FROM users WHERE email = '${email}' LIMIT 1`);",
            '+  return rows[0] || null;',
            '+}',
          ].join('\n'),
        },
      ];

      await poster.postInline(123, comments, files);

      const reviewCall = mockOctokit.rest.pulls.createReview.mock.calls[0][0];
      expect(reviewCall.comments[0]).toEqual(
        expect.objectContaining({
          path: 'src/users.js',
          line: 10,
        })
      );
    });

    it('splits large comments into chunks', async () => {
      const poster = new CommentPoster(mockClient, false);
      const largeBody = 'x'.repeat(70000); // Exceeds MAX_COMMENT_SIZE

      await poster.postSummary(123, largeBody);

      // Should be called twice (chunked)
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(2);
    });
  });

  describe('Dry Run Mode', () => {
    it('does not post summary comment in dry run mode', async () => {
      const poster = new CommentPoster(mockClient, true);
      const body = 'Test summary';

      await poster.postSummary(123, body);

      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('[DRY RUN] Would post 1 summary comment(s) to PR #123')
      );
    });

    it('does not post inline comments in dry run mode', async () => {
      const poster = new CommentPoster(mockClient, true);
      const comments: InlineComment[] = [
        {
          path: 'src/test.ts',
          line: 10,
          side: 'RIGHT' as const,
          body: 'Test comment',
        },
      ];
      const files: FileChange[] = [
        {
          filename: 'src/test.ts',
          status: 'modified',
          additions: 5,
          deletions: 2,
          changes: 7,
          patch: '@@ -8,3 +8,4 @@\n line8\n line9\n+line10\n line11',
        },
      ];

      await poster.postInline(123, comments, files);

      expect(mockOctokit.rest.pulls.createReview).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('[DRY RUN] Would post')
      );
    });

    it('logs summary preview in dry run mode', async () => {
      const poster = new CommentPoster(mockClient, true);
      const body = 'Test summary with some content';

      await poster.postSummary(123, body);

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('[DRY RUN] Summary comment 1:')
      );
    });

    it('logs inline comments preview in dry run mode', async () => {
      const poster = new CommentPoster(mockClient, true);
      const comments: InlineComment[] = [
        {
          path: 'src/test.ts',
          line: 10,
          side: 'RIGHT' as const,
          body: 'Test inline comment',
        },
      ];
      const files: FileChange[] = [
        {
          filename: 'src/test.ts',
          status: 'modified',
          additions: 5,
          deletions: 2,
          changes: 7,
          patch: '@@ -8,3 +8,4 @@\n line8\n line9\n+line10\n line11',
        },
      ];

      await poster.postInline(123, comments, files);

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('[DRY RUN] Inline comment at src/test.ts')
      );
    });
  });

  describe('Edge Cases', () => {
    it('handles empty inline comments array', async () => {
      const poster = new CommentPoster(mockClient, false);

      await poster.postInline(123, [], []);

      expect(mockOctokit.rest.pulls.createReview).not.toHaveBeenCalled();
    });

    it('skips inline comments without valid diff positions', async () => {
      const poster = new CommentPoster(mockClient, false);
      const comments: InlineComment[] = [
        {
          path: 'src/test.ts',
          line: 999, // Line not in patch
          side: 'RIGHT' as const,
          body: 'Test comment',
        },
      ];
      const files: FileChange[] = [
        {
          filename: 'src/test.ts',
          status: 'modified',
          additions: 5,
          deletions: 2,
          changes: 7,
          patch: '@@ -8,3 +8,4 @@\n line8\n line9\n+line10\n line11',
        },
      ];

      await poster.postInline(123, comments, files);

      expect(mockOctokit.rest.pulls.createReview).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Cannot find diff position')
      );
    });
  });
});
