import {
  ReviewThreadInventoryLoader,
  isTrustedReviewThreadAuthor,
  trustedReviewThreadAuthorsFromEnv,
} from '../../../src/github/review-thread-inventory';
import { GitHubClient } from '../../../src/github/client';

const parentBody = [
  '**🟡 Major - Previous Bug**',
  '',
  'Old issue body.',
  '',
  '<!-- review-router-finding:aaaaaaaaaaaaaaaaaaaaaaaa -->',
].join('\n');

describe('ReviewThreadInventoryLoader', () => {
  it('builds a strict trusted author allowlist from configured GitHub App identity', () => {
    const authors = trustedReviewThreadAuthorsFromEnv({
      REVIEW_APP_SLUG: 'review-router-owner',
      REVIEW_THREAD_LIFECYCLE_TRUSTED_AUTHORS:
        'extra-review-bot[bot], invalid login!',
    } as NodeJS.ProcessEnv);

    expect(authors).toEqual(
      expect.arrayContaining([
        'github-actions[bot]',
        'review-router-ai[bot]',
        'review-router-owner[bot]',
        'extra-review-bot[bot]',
      ])
    );
    expect(authors).not.toContain('invalid login!');
    expect(isTrustedReviewThreadAuthor('Review-Router-Owner[bot]', authors)).toBe(
      true
    );
    expect(isTrustedReviewThreadAuthor('Review-Router-Owner', authors)).toBe(
      true
    );
    expect(isTrustedReviewThreadAuthor('review-router-ai')).toBe(true);
  });

  it('trusts github-actions only when it is the expected or fallback comment identity', () => {
    const appAuthors = trustedReviewThreadAuthorsFromEnv({
      REVIEWROUTER_COMMENT_TOKEN_MODE: 'app-oidc',
      REVIEW_ROUTER_COMMENT_TOKEN_STATUS: 'app',
      REVIEW_APP_SLUG: 'review-router-owner',
    } as NodeJS.ProcessEnv);
    expect(appAuthors).toEqual(
      expect.arrayContaining([
        'review-router-ai[bot]',
        'review-router-owner[bot]',
      ])
    );
    expect(appAuthors).not.toContain('github-actions[bot]');

    const fallbackAuthors = trustedReviewThreadAuthorsFromEnv({
      REVIEWROUTER_COMMENT_TOKEN_MODE: 'app-oidc',
      REVIEW_ROUTER_COMMENT_TOKEN_STATUS: 'fallback',
      REVIEW_APP_SLUG: 'review-router-owner',
    } as NodeJS.ProcessEnv);
    expect(fallbackAuthors).toContain('github-actions[bot]');
  });

  it('loads only unresolved trusted ReviewRouter threads as lifecycle candidates', async () => {
    const graphql = jest.fn().mockResolvedValue({
      repository: {
        pullRequest: {
          headRefOid: 'head-sha',
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: 'resolved-thread',
                isResolved: true,
                viewerCanResolve: true,
                path: 'src/app.ts',
                line: 10,
                comments: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: 'resolved-comment',
                      author: { login: 'review-router-ai[bot]' },
                      body: parentBody,
                      createdAt: '2026-05-14T00:00:00Z',
                      updatedAt: '2026-05-14T00:00:00Z',
                      path: 'src/app.ts',
                      line: 10,
                      originalLine: 10,
                      diffHunk: '@@',
                      url: 'https://github.test/resolved',
                    },
                  ],
                },
              },
              {
                id: 'active-thread',
                isResolved: false,
                viewerCanResolve: true,
                path: 'src/app.ts',
                line: 12,
                comments: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: 'active-comment',
                      author: { login: 'review-router-ai[bot]' },
                      body: parentBody,
                      createdAt: '2026-05-14T00:00:00Z',
                      updatedAt: '2026-05-14T00:00:00Z',
                      path: 'src/app.ts',
                      line: 12,
                      originalLine: 10,
                      diffHunk: '@@',
                      url: 'https://github.test/active',
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    const loader = new ReviewThreadInventoryLoader({
      owner: 'owner',
      repo: 'repo',
      octokit: { graphql },
    } as unknown as GitHubClient);

    const inventory = await loader.load(123);

    expect(inventory.failed).toBe(false);
    expect(inventory.headRefOid).toBe('head-sha');
    expect(inventory.candidates).toHaveLength(1);
    expect(inventory.candidates[0]).toMatchObject({
      threadId: 'active-thread',
      fingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      severity: 'major',
      trustedAuthor: true,
      hasHumanReply: false,
    });
    expect(inventory.dedupeComments).toHaveLength(1);
  });

  it('keeps outdated unresolved threads as lifecycle targets but not dedupe refs', async () => {
    const graphql = jest.fn().mockResolvedValue({
      repository: {
        pullRequest: {
          headRefOid: 'head-sha',
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: 'outdated-thread',
                isResolved: false,
                isOutdated: true,
                viewerCanResolve: true,
                path: 'src/app.ts',
                line: null,
                originalLine: 10,
                comments: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: 'outdated-comment',
                      author: { login: 'review-router-ai[bot]' },
                      body: parentBody,
                      createdAt: '2026-05-14T00:00:00Z',
                      updatedAt: '2026-05-14T00:00:00Z',
                      path: 'src/app.ts',
                      line: null,
                      originalLine: 10,
                      diffHunk: '@@',
                      url: 'https://github.test/outdated',
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    const loader = new ReviewThreadInventoryLoader({
      owner: 'owner',
      repo: 'repo',
      octokit: { graphql },
    } as unknown as GitHubClient);

    const inventory = await loader.load(123);

    expect(inventory.candidates).toHaveLength(1);
    expect(inventory.candidates[0]).toMatchObject({
      threadId: 'outdated-thread',
      originalLine: 10,
    });
    expect(inventory.dedupeComments).toHaveLength(0);
  });

  it('fails closed and clears partial candidates when review thread pagination fails', async () => {
    const graphql = jest
      .fn()
      .mockResolvedValueOnce({
        repository: {
          pullRequest: {
            headRefOid: 'head-sha',
            reviewThreads: {
              pageInfo: { hasNextPage: true, endCursor: 'threads-page-2' },
              nodes: [
                {
                  id: 'active-thread',
                  isResolved: false,
                  viewerCanResolve: true,
                  path: 'src/app.ts',
                  line: 12,
                  comments: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        id: 'active-comment',
                        author: { login: 'review-router-ai[bot]' },
                        body: parentBody,
                        createdAt: '2026-05-14T00:00:00Z',
                        updatedAt: '2026-05-14T00:00:00Z',
                        path: 'src/app.ts',
                        line: 12,
                        originalLine: 10,
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      })
      .mockRejectedValueOnce(new Error('thread pagination failed'));
    const loader = new ReviewThreadInventoryLoader({
      owner: 'owner',
      repo: 'repo',
      octokit: { graphql },
    } as unknown as GitHubClient);

    const inventory = await loader.load(123);

    expect(inventory.failed).toBe(true);
    expect(inventory.candidates).toHaveLength(0);
    expect(inventory.manualAttention).toHaveLength(0);
    expect(inventory.dedupeComments).toHaveLength(0);
    expect(inventory.warnings).toContain(
      'review thread lifecycle inventory failed'
    );
  });

  it('fails closed when the review thread connection is missing', async () => {
    const graphql = jest.fn().mockResolvedValue({
      repository: {
        pullRequest: {
          headRefOid: 'head-sha',
          reviewThreads: null,
        },
      },
    });
    const loader = new ReviewThreadInventoryLoader({
      owner: 'owner',
      repo: 'repo',
      octokit: { graphql },
    } as unknown as GitHubClient);

    const inventory = await loader.load(123);

    expect(inventory.failed).toBe(true);
    expect(inventory.candidates).toHaveLength(0);
    expect(inventory.dedupeComments).toHaveLength(0);
  });

  it('fails closed and clears partial candidates when thread pagination cursor is missing', async () => {
    const graphql = jest.fn().mockResolvedValue({
      repository: {
        pullRequest: {
          headRefOid: 'head-sha',
          reviewThreads: {
            pageInfo: { hasNextPage: true, endCursor: null },
            nodes: [
              {
                id: 'active-thread',
                isResolved: false,
                viewerCanResolve: true,
                path: 'src/app.ts',
                line: 12,
                comments: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: 'active-comment',
                      author: { login: 'review-router-ai[bot]' },
                      body: parentBody,
                      createdAt: '2026-05-14T00:00:00Z',
                      updatedAt: '2026-05-14T00:00:00Z',
                      path: 'src/app.ts',
                      line: 12,
                      originalLine: 10,
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    const loader = new ReviewThreadInventoryLoader({
      owner: 'owner',
      repo: 'repo',
      octokit: { graphql },
    } as unknown as GitHubClient);

    const inventory = await loader.load(123);

    expect(inventory.failed).toBe(true);
    expect(inventory.candidates).toHaveLength(0);
    expect(inventory.manualAttention).toHaveLength(0);
    expect(inventory.dedupeComments).toHaveLength(0);
  });

  it('fails closed when an unresolved thread has no comment connection', async () => {
    const graphql = jest.fn().mockResolvedValue({
      repository: {
        pullRequest: {
          headRefOid: 'head-sha',
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: 'malformed-thread',
                isResolved: false,
                viewerCanResolve: true,
                path: 'src/app.ts',
                line: 12,
                comments: null,
              },
            ],
          },
        },
      },
    });
    const loader = new ReviewThreadInventoryLoader({
      owner: 'owner',
      repo: 'repo',
      octokit: { graphql },
    } as unknown as GitHubClient);

    const inventory = await loader.load(123);

    expect(inventory.failed).toBe(true);
    expect(inventory.candidates).toHaveLength(0);
    expect(inventory.dedupeComments).toHaveLength(0);
  });

  it('does not create an auto-resolve candidate from a marker-only old finding', async () => {
    const graphql = jest.fn().mockResolvedValue({
      repository: {
        pullRequest: {
          headRefOid: 'head-sha',
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: 'marker-only-thread',
                isResolved: false,
                viewerCanResolve: true,
                path: 'src/app.ts',
                line: 12,
                comments: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: 'marker-only-comment',
                      author: { login: 'review-router-ai[bot]' },
                      body: '<!-- review-router-finding:aaaaaaaaaaaaaaaaaaaaaaaa -->',
                      createdAt: '2026-05-14T00:00:00Z',
                      updatedAt: '2026-05-14T00:00:00Z',
                      path: 'src/app.ts',
                      line: 12,
                      originalLine: 10,
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    const loader = new ReviewThreadInventoryLoader({
      owner: 'owner',
      repo: 'repo',
      octokit: { graphql },
    } as unknown as GitHubClient);

    const inventory = await loader.load(123);

    expect(inventory.candidates).toHaveLength(0);
    expect(inventory.manualAttention[0].reasonCodes).toContain(
      'missing_old_finding_details'
    );
    expect(inventory.dedupeComments).toHaveLength(1);
  });

  it('does not treat ReviewRouter boilerplate footer as old finding details', async () => {
    const graphql = jest.fn().mockResolvedValue({
      repository: {
        pullRequest: {
          headRefOid: 'head-sha',
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: 'marker-footer-thread',
                isResolved: false,
                viewerCanResolve: true,
                path: 'src/app.ts',
                line: 12,
                comments: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: 'marker-footer-comment',
                      author: { login: 'review-router-ai[bot]' },
                      body: [
                        '<!-- review-router-finding:aaaaaaaaaaaaaaaaaaaaaaaa -->',
                        '',
                        '<sub><!-- review-router-skip-help -->A maintainer/admin can reply `/rr skip` if this finding is a false positive.</sub>',
                        '<sub>Model: codex/gpt-5.5</sub>',
                      ].join('\n'),
                      createdAt: '2026-05-14T00:00:00Z',
                      updatedAt: '2026-05-14T00:00:00Z',
                      path: 'src/app.ts',
                      line: 12,
                      originalLine: 10,
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    const loader = new ReviewThreadInventoryLoader({
      owner: 'owner',
      repo: 'repo',
      octokit: { graphql },
    } as unknown as GitHubClient);

    const inventory = await loader.load(123);

    expect(inventory.candidates).toHaveLength(0);
    expect(inventory.manualAttention[0].reasonCodes).toContain(
      'missing_old_finding_details'
    );
    expect(inventory.dedupeComments).toHaveLength(1);
  });

  it('paginates review threads before building the lifecycle inventory', async () => {
    const graphql = jest
      .fn()
      .mockResolvedValueOnce({
        repository: {
          pullRequest: {
            headRefOid: 'head-sha',
            reviewThreads: {
              pageInfo: { hasNextPage: true, endCursor: 'threads-page-1' },
              nodes: [],
            },
          },
        },
      })
      .mockResolvedValueOnce({
        repository: {
          pullRequest: {
            headRefOid: 'head-sha',
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: 'thread-2',
                  isResolved: false,
                  viewerCanResolve: true,
                  path: 'src/app.ts',
                  line: 12,
                  comments: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        id: 'comment-2',
                        author: { login: 'review-router-ai[bot]' },
                        body: parentBody,
                        createdAt: '2026-05-14T00:00:00Z',
                        updatedAt: '2026-05-14T00:00:00Z',
                        path: 'src/app.ts',
                        line: 12,
                        originalLine: 10,
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      });
    const loader = new ReviewThreadInventoryLoader({
      owner: 'owner',
      repo: 'repo',
      octokit: { graphql },
    } as unknown as GitHubClient);

    const inventory = await loader.load(123);

    expect(graphql).toHaveBeenCalledTimes(2);
    expect(graphql.mock.calls[1][1]).toMatchObject({
      threadsAfter: 'threads-page-1',
    });
    expect(inventory.candidates).toHaveLength(1);
    expect(inventory.candidates[0].threadId).toBe('thread-2');
  });

  it('moves trusted threads with human replies to manual attention', async () => {
    const graphql = jest.fn().mockResolvedValue({
      repository: {
        pullRequest: {
          headRefOid: 'head-sha',
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: 'thread-1',
                isResolved: false,
                viewerCanResolve: true,
                path: 'src/app.ts',
                line: 12,
                comments: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: 'comment-1',
                      author: { login: 'review-router-ai[bot]' },
                      body: parentBody,
                      createdAt: '2026-05-14T00:00:00Z',
                      updatedAt: '2026-05-14T00:00:00Z',
                      path: 'src/app.ts',
                      line: 12,
                    },
                    {
                      id: 'comment-2',
                      author: { login: 'maintainer' },
                      body: 'I am looking at this.',
                      createdAt: '2026-05-14T00:01:00Z',
                      updatedAt: '2026-05-14T00:01:00Z',
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    const loader = new ReviewThreadInventoryLoader({
      owner: 'owner',
      repo: 'repo',
      octokit: { graphql },
    } as unknown as GitHubClient);

    const inventory = await loader.load(123);

    expect(inventory.candidates).toHaveLength(0);
    expect(inventory.manualAttention[0].reasonCodes).toContain('human_reply');
    expect(inventory.dedupeComments).toHaveLength(1);
  });

  it('paginates thread comments before deciding human-reply safety', async () => {
    const graphql = jest
      .fn()
      .mockResolvedValueOnce({
        repository: {
          pullRequest: {
            headRefOid: 'head-sha',
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: 'thread-1',
                  isResolved: false,
                  viewerCanResolve: true,
                  path: 'src/app.ts',
                  line: 12,
                  comments: {
                    pageInfo: { hasNextPage: true, endCursor: 'comments-page-1' },
                    nodes: [
                      {
                        id: 'comment-1',
                        author: { login: 'review-router-ai[bot]' },
                        body: parentBody,
                        createdAt: '2026-05-14T00:00:00Z',
                        updatedAt: '2026-05-14T00:00:00Z',
                        path: 'src/app.ts',
                        line: 12,
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      })
      .mockResolvedValueOnce({
        node: {
          comments: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: 'comment-2',
                author: { login: 'maintainer' },
                body: 'This still needs discussion.',
                createdAt: '2026-05-14T00:01:00Z',
                updatedAt: '2026-05-14T00:01:00Z',
              },
            ],
          },
        },
      });
    const loader = new ReviewThreadInventoryLoader({
      owner: 'owner',
      repo: 'repo',
      octokit: { graphql },
    } as unknown as GitHubClient);

    const inventory = await loader.load(123);

    expect(graphql).toHaveBeenCalledTimes(2);
    expect(inventory.candidates).toHaveLength(0);
    expect(inventory.manualAttention[0].reasonCodes).toContain('human_reply');
    expect(inventory.manualAttention[0].reasonCodes).not.toContain(
      'pagination_incomplete'
    );
  });

  it('does not make a lifecycle candidate when comment pagination is incomplete', async () => {
    const graphql = jest
      .fn()
      .mockResolvedValueOnce({
        repository: {
          pullRequest: {
            headRefOid: 'head-sha',
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: 'thread-1',
                  isResolved: false,
                  viewerCanResolve: true,
                  path: 'src/app.ts',
                  line: 12,
                  comments: {
                    pageInfo: { hasNextPage: true, endCursor: 'comments-page-1' },
                    nodes: [
                      {
                        id: 'comment-1',
                        author: { login: 'review-router-ai[bot]' },
                        body: parentBody,
                        createdAt: '2026-05-14T00:00:00Z',
                        updatedAt: '2026-05-14T00:00:00Z',
                        path: 'src/app.ts',
                        line: 12,
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      })
      .mockRejectedValueOnce(new Error('comments pagination failed'));
    const loader = new ReviewThreadInventoryLoader({
      owner: 'owner',
      repo: 'repo',
      octokit: { graphql },
    } as unknown as GitHubClient);

    const inventory = await loader.load(123);

    expect(inventory.candidates).toHaveLength(0);
    expect(inventory.manualAttention[0].reasonCodes).toContain(
      'pagination_incomplete'
    );
    expect(inventory.warnings[0]).toContain('pagination could not be completed');
  });

  it('does not let untrusted marker comments suppress new current findings', async () => {
    const graphql = jest.fn().mockResolvedValue({
      repository: {
        pullRequest: {
          headRefOid: 'head-sha',
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: 'thread-1',
                isResolved: false,
                viewerCanResolve: true,
                path: 'src/app.ts',
                line: 12,
                comments: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: 'comment-1',
                      author: { login: 'random-user' },
                      body: parentBody,
                      createdAt: '2026-05-14T00:00:00Z',
                      updatedAt: '2026-05-14T00:00:00Z',
                      path: 'src/app.ts',
                      line: 12,
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    const loader = new ReviewThreadInventoryLoader({
      owner: 'owner',
      repo: 'repo',
      octokit: { graphql },
    } as unknown as GitHubClient);

    const inventory = await loader.load(123);

    expect(inventory.candidates).toHaveLength(0);
    expect(inventory.manualAttention[0].reasonCodes).toContain(
      'untrusted_author'
    );
    expect(inventory.dedupeComments).toHaveLength(0);
  });

  it('trusts configured GitHub App bot comments for lifecycle candidates', async () => {
    const graphql = jest.fn().mockResolvedValue({
      repository: {
        pullRequest: {
          headRefOid: 'head-sha',
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: 'thread-1',
                isResolved: false,
                viewerCanResolve: true,
                path: 'src/app.ts',
                line: 12,
                comments: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: 'comment-1',
                      author: { login: 'review-router-owner[bot]' },
                      body: parentBody,
                      createdAt: '2026-05-14T00:00:00Z',
                      updatedAt: '2026-05-14T00:00:00Z',
                      path: 'src/app.ts',
                      line: 12,
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    const loader = new ReviewThreadInventoryLoader(
      {
        owner: 'owner',
        repo: 'repo',
        octokit: { graphql },
      } as unknown as GitHubClient,
      trustedReviewThreadAuthorsFromEnv({
        REVIEW_APP_SLUG: 'review-router-owner',
      } as NodeJS.ProcessEnv)
    );

    const inventory = await loader.load(123);

    expect(inventory.candidates).toHaveLength(1);
    expect(inventory.manualAttention).toHaveLength(0);
    expect(inventory.dedupeComments).toHaveLength(1);
  });
});
