import { ReviewThreadResolver } from '../../../src/github/review-thread-resolver';
import { GitHubClient } from '../../../src/github/client';
import { LifecycleThreadRecord } from '../../../src/types';

const record = (): LifecycleThreadRecord => ({
  target: {
    targetId: 'rrt_123',
    threadId: 'thread-123',
    fingerprint: 'a'.repeat(24),
    severity: 'major',
    title: 'Previous Bug',
    message: 'Old bug',
    originalPath: 'src/app.ts',
    currentPath: 'src/app.ts',
    originalLine: 10,
    currentLine: 12,
    parentCommentId: 'comment-123',
    parentCommentUpdatedAt: '2026-05-14T00:00:00Z',
    threadCommentCount: 1,
    viewerCanResolve: true,
    hasHumanReply: false,
    trustedAuthor: true,
  },
  reasonCodes: [],
});

const threadResponse = (overrides: Record<string, unknown> = {}) => ({
  node: {
    id: 'thread-123',
    isResolved: false,
    viewerCanResolve: true,
    comments: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [
        {
          id: 'comment-123',
          author: { login: 'review-router-ai[bot]' },
          body: `<!-- review-router-finding:${'a'.repeat(24)} -->`,
          createdAt: '2026-05-14T00:00:00Z',
          updatedAt: '2026-05-14T00:00:00Z',
        },
      ],
    },
    ...overrides,
  },
});

describe('ReviewThreadResolver', () => {
  it('skips every candidate if the PR head changed before mutation', async () => {
    const graphql = jest.fn().mockResolvedValueOnce({
      repository: {
        pullRequest: {
          headRefOid: 'new-head',
        },
      },
    });
    const resolver = new ReviewThreadResolver({
      owner: 'owner',
      repo: 'repo',
      octokit: { graphql },
    } as unknown as GitHubClient);

    const result = await resolver.resolveGuarded(123, 'old-head', [record()]);

    expect(result.skipped[0].reasonCodes).toContain('head_sha_changed');
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it('stops all lifecycle mutations when the head refresh is rate limited', async () => {
    const rateLimitError = Object.assign(new Error('secondary rate limit'), {
      status: 403,
    });
    const graphql = jest.fn().mockRejectedValueOnce(rateLimitError);
    const resolver = new ReviewThreadResolver({
      owner: 'owner',
      repo: 'repo',
      octokit: { graphql },
    } as unknown as GitHubClient);

    const result = await resolver.resolveGuarded(123, 'head-sha', [record()]);

    expect(result.skipped[0].reasonCodes).toContain('mutation_rate_limited');
    expect(result.warnings[0]).toContain('rate limited');
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it('rechecks the thread and resolves only after mutation succeeds', async () => {
    const graphql = jest
      .fn()
      .mockResolvedValueOnce({
        repository: {
          pullRequest: {
            headRefOid: 'head-sha',
          },
        },
      })
      .mockResolvedValueOnce(threadResponse())
      .mockResolvedValueOnce({
        resolveReviewThread: {
          thread: {
            id: 'thread-123',
            isResolved: true,
          },
        },
      });
    const resolver = new ReviewThreadResolver({
      owner: 'owner',
      repo: 'repo',
      octokit: { graphql },
    } as unknown as GitHubClient);

    const result = await resolver.resolveGuarded(123, 'head-sha', [record()]);

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].resolvedBy).toBe('review-router');
    expect(result.failed).toHaveLength(0);
  });

  it('attempts the mutation even when viewerCanResolve is false', async () => {
    const graphql = jest
      .fn()
      .mockResolvedValueOnce({
        repository: {
          pullRequest: {
            headRefOid: 'head-sha',
          },
        },
      })
      .mockResolvedValueOnce(threadResponse({ viewerCanResolve: false }))
      .mockResolvedValueOnce({
        resolveReviewThread: {
          thread: {
            id: 'thread-123',
            isResolved: true,
          },
        },
      });
    const resolver = new ReviewThreadResolver({
      owner: 'owner',
      repo: 'repo',
      octokit: { graphql },
    } as unknown as GitHubClient);

    const result = await resolver.resolveGuarded(123, 'head-sha', [record()]);

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].resolvedBy).toBe('review-router');
    expect(graphql).toHaveBeenCalledTimes(3);
  });

  it('treats an already resolved thread before mutation as externally resolved', async () => {
    const graphql = jest
      .fn()
      .mockResolvedValueOnce({
        repository: {
          pullRequest: {
            headRefOid: 'head-sha',
          },
        },
      })
      .mockResolvedValueOnce(threadResponse({ isResolved: true }));
    const resolver = new ReviewThreadResolver({
      owner: 'owner',
      repo: 'repo',
      octokit: { graphql },
    } as unknown as GitHubClient);

    const result = await resolver.resolveGuarded(123, 'head-sha', [record()]);

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].resolvedBy).toBe('external');
    expect(result.resolved[0].reasonCodes).toContain('already_resolved');
    expect(graphql).toHaveBeenCalledTimes(2);
  });

  it('moves the candidate to manual attention if a human replied before mutation', async () => {
    const graphql = jest
      .fn()
      .mockResolvedValueOnce({
        repository: {
          pullRequest: {
            headRefOid: 'head-sha',
          },
        },
      })
      .mockResolvedValueOnce(
        threadResponse({
          comments: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: 'comment-123',
                author: { login: 'review-router-ai[bot]' },
                body: `<!-- review-router-finding:${'a'.repeat(24)} -->`,
                createdAt: '2026-05-14T00:00:00Z',
                updatedAt: '2026-05-14T00:00:00Z',
              },
              {
                id: 'human-comment',
                author: { login: 'maintainer' },
                body: 'Please do not auto close this.',
                createdAt: '2026-05-14T00:01:00Z',
                updatedAt: '2026-05-14T00:01:00Z',
              },
            ],
          },
        })
      );
    const resolver = new ReviewThreadResolver({
      owner: 'owner',
      repo: 'repo',
      octokit: { graphql },
    } as unknown as GitHubClient);

    const result = await resolver.resolveGuarded(123, 'head-sha', [record()]);

    expect(result.manualAttention[0].reasonCodes).toContain('human_reply');
    expect(graphql).toHaveBeenCalledTimes(2);
  });

  it('moves the candidate to manual attention if the refreshed parent author is untrusted', async () => {
    const graphql = jest
      .fn()
      .mockResolvedValueOnce({
        repository: {
          pullRequest: {
            headRefOid: 'head-sha',
          },
        },
      })
      .mockResolvedValueOnce(
        threadResponse({
          comments: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: 'comment-123',
                author: { login: 'unknown-bot[bot]' },
                body: `<!-- review-router-finding:${'a'.repeat(24)} -->`,
                createdAt: '2026-05-14T00:00:00Z',
                updatedAt: '2026-05-14T00:00:00Z',
              },
            ],
          },
        })
      );
    const resolver = new ReviewThreadResolver({
      owner: 'owner',
      repo: 'repo',
      octokit: { graphql },
    } as unknown as GitHubClient);

    const result = await resolver.resolveGuarded(123, 'head-sha', [record()]);

    expect(result.manualAttention[0].reasonCodes).toContain('untrusted_author');
    expect(graphql).toHaveBeenCalledTimes(2);
  });

  it('skips mutation when pre-mutation thread comments are paginated', async () => {
    const graphql = jest
      .fn()
      .mockResolvedValueOnce({
        repository: {
          pullRequest: {
            headRefOid: 'head-sha',
          },
        },
      })
      .mockResolvedValueOnce(
        threadResponse({
          comments: {
            pageInfo: { hasNextPage: true, endCursor: 'cursor' },
            nodes: [
              {
                id: 'comment-123',
                author: { login: 'review-router-ai[bot]' },
                body: `<!-- review-router-finding:${'a'.repeat(24)} -->`,
                createdAt: '2026-05-14T00:00:00Z',
                updatedAt: '2026-05-14T00:00:00Z',
              },
            ],
          },
        })
      );
    const resolver = new ReviewThreadResolver({
      owner: 'owner',
      repo: 'repo',
      octokit: { graphql },
    } as unknown as GitHubClient);

    const result = await resolver.resolveGuarded(123, 'head-sha', [record()]);

    expect(result.skipped[0].reasonCodes).toContain('pagination_incomplete');
    expect(graphql).toHaveBeenCalledTimes(2);
  });

  it('reports mutation failure without claiming the thread was resolved', async () => {
    const graphql = jest
      .fn()
      .mockResolvedValueOnce({
        repository: {
          pullRequest: {
            headRefOid: 'head-sha',
          },
        },
      })
      .mockResolvedValueOnce(threadResponse())
      .mockRejectedValueOnce(new Error('mutation failed'));
    const resolver = new ReviewThreadResolver({
      owner: 'owner',
      repo: 'repo',
      octokit: { graphql },
    } as unknown as GitHubClient);

    const result = await resolver.resolveGuarded(123, 'head-sha', [record()]);

    expect(result.resolved).toHaveLength(0);
    expect(result.failed[0].reasonCodes).toContain('mutation_failed');
    expect(result.failed[0].errorMessage).toBe('mutation failed');
  });

  it('stops remaining mutations when GitHub rate limits a resolve call', async () => {
    const rateLimitError = Object.assign(new Error('secondary rate limit'), {
      status: 403,
    });
    const graphql = jest
      .fn()
      .mockResolvedValueOnce({
        repository: {
          pullRequest: {
            headRefOid: 'head-sha',
          },
        },
      })
      .mockResolvedValueOnce(threadResponse())
      .mockRejectedValueOnce(rateLimitError);
    const resolver = new ReviewThreadResolver({
      owner: 'owner',
      repo: 'repo',
      octokit: { graphql },
    } as unknown as GitHubClient);

    const result = await resolver.resolveGuarded(123, 'head-sha', [
      record(),
      { ...record(), target: { ...record().target, targetId: 'rrt_456' } },
    ]);

    expect(result.skipped).toHaveLength(2);
    expect(result.skipped[0].reasonCodes).toContain('mutation_rate_limited');
    expect(result.warnings[0]).toContain('rate limited');
  });
});
