import { applyAdmittedRuntimeConfig } from '../../../src/control-plane/runtime-config';
import type { GitHubClient } from '../../../src/github/client';
import { ReviewLedger } from '../../../src/github/ledger';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  FreshGitHubLifecycleInventory,
  GitHubReviewRevisionGuard,
} from '../../../src/review-orchestration/infrastructure/github-review-state-adapter';

describe('GitHubReviewRevisionGuard', () => {
  const scope = {
    workspaceId: 'workspace-1',
    repositoryConnectionId: 'connection-1',
    scmRepositoryIdentityId: 'repository-1',
    pullRequestNumber: 420,
  };

  function clientWith(options: { pullsGet: jest.Mock; compare?: jest.Mock }) {
    return {
      owner: 'owner',
      repo: 'repo',
      octokit: {
        rest: {
          pulls: { get: options.pullsGet },
          repos: {
            compareCommitsWithBasehead: options.compare ?? jest.fn(),
          },
        },
      },
    };
  }

  it('normalizes exhausted transient failures without exposing provider text', async () => {
    const error = new Error('request failed', {
      cause: Object.assign(new Error('unsafe socket detail'), {
        code: 'ECONNRESET',
      }),
    });
    const pullsGet = jest.fn().mockRejectedValue(error);
    const client = clientWith({ pullsGet });
    const guard = new GitHubReviewRevisionGuard(client as never, scope);

    await expect(guard.loadCurrentRevision()).rejects.toThrow(
      'review_action_v2_revision_guard_unavailable'
    );
    expect(pullsGet).toHaveBeenCalledTimes(1);
  });

  it('returns the authoritative closed pull request state without changing the revision hash', async () => {
    const baseSha = 'b'.repeat(40);
    const headSha = 'a'.repeat(40);
    const pullsGet = jest.fn().mockResolvedValue({
      data: {
        state: 'closed',
        base: { sha: baseSha },
        head: { sha: headSha },
      },
    });
    const compare = jest.fn().mockResolvedValue({
      data: { merge_base_commit: { sha: 'c'.repeat(40) } },
    });
    const guard = new GitHubReviewRevisionGuard(
      clientWith({ pullsGet, compare }) as never,
      scope
    );

    const revision = await guard.loadCurrentRevision();

    expect(revision).toMatchObject({
      baseSha,
      headSha,
      pullRequestState: 'closed',
    });
    expect(revision.reviewRevisionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(pullsGet).toHaveBeenCalledTimes(2);
  });

  it('normalizes invalid revision facts as a permanent guard failure', async () => {
    const client = clientWith({
      pullsGet: jest.fn().mockResolvedValue({
        data: {
          base: { sha: 'invalid' },
          head: { sha: 'a'.repeat(40) },
        },
      }),
    });
    const guard = new GitHubReviewRevisionGuard(client as never, scope);

    await expect(guard.loadCurrentRevision()).rejects.toThrow(
      'review_action_v2_revision_guard_failed'
    );
  });

  it('normalizes non-retryable GitHub failures without reading deprecated code', async () => {
    const error = Object.assign(new Error('not found'), { status: 404 });
    const deprecatedCodeGetter = jest.fn(() => 404);
    Object.defineProperty(error, 'code', { get: deprecatedCodeGetter });
    const client = clientWith({
      pullsGet: jest.fn().mockRejectedValue(error),
    });
    const guard = new GitHubReviewRevisionGuard(client as never, scope);

    await expect(guard.loadCurrentRevision()).rejects.toThrow(
      'review_action_v2_revision_guard_failed'
    );
    expect(deprecatedCodeGetter).not.toHaveBeenCalled();
  });
});

describe('FreshGitHubLifecycleInventory', () => {
  it('keeps untrusted prompt context outside the portable lifecycle witness', async () => {
    const fixture = JSON.parse(
      readFileSync(
        resolve(
          process.cwd(),
          'src/review-projection/fixtures/review-lifecycle-thread-state.v1.golden.json'
        ),
        'utf8'
      )
    ) as {
      readonly expectedProjectionTarget: Readonly<Record<string, string>>;
    };
    const headSha = 'a'.repeat(40);
    const graphql = jest.fn().mockResolvedValue({
      repository: {
        pullRequest: {
          headRefOid: headSha,
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: 'PRRT_reviewrouter_golden_1',
                isResolved: false,
                viewerCanResolve: true,
                path: 'src/app.ts',
                line: 12,
                comments: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: 'PRRC_1',
                      author: { login: 'Review-Router-AI[bot]' },
                      body: [
                        '<!-- review-router-finding:aaaaaaaaaaaaaaaaaaaaaaaa -->',
                        'Finding',
                      ].join('\n'),
                      createdAt: '2026-08-05T09:00:00.000Z',
                      updatedAt: '2026-08-05T09:05:00.000Z',
                      path: 'src/app.ts',
                      line: 12,
                    },
                    {
                      id: 'PRRC_2',
                      author: { login: 'Human.User' },
                      body: 'Looks fixed.\n',
                      createdAt: '2026-08-05T10:00:00.000Z',
                      updatedAt: '2026-08-05T10:00:00.000Z',
                    },
                  ],
                },
              },
              {
                id: 'PRRT_untrusted_marker',
                isResolved: false,
                viewerCanResolve: true,
                path: 'src/app.ts',
                line: 20,
                comments: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: 'PRRC_untrusted_marker',
                      author: { login: 'review-router-ai' },
                      body: [
                        '<!-- review-router-finding:bbbbbbbbbbbbbbbbbbbbbbbb -->',
                        'Copied finding context',
                      ].join('\n'),
                      createdAt: '2026-08-05T09:00:00.000Z',
                      updatedAt: '2026-08-05T09:00:00.000Z',
                      path: 'src/app.ts',
                      line: 20,
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    const listComments = jest.fn();
    const paginate = jest.fn().mockResolvedValue([
      { id: 1, body: 'Ordinary PR discussion' },
      { id: 2, body: 'Reviewed the latest changes' },
    ]);
    const client = {
      owner: 'owner',
      repo: 'repo',
      octokit: {
        graphql,
        rest: { issues: { listComments } },
        paginate,
      },
    } as unknown as GitHubClient;
    const ledger = new ReviewLedger(client, undefined);
    const adapter = new FreshGitHubLifecycleInventory(client, ledger);

    const inventory = await adapter.loadCurrent({
      scope: {
        scmRepositoryIdentityId: 'repository-1',
        pullRequestNumber: 420,
        baseSha: 'b'.repeat(40),
        reviewedHeadSha: headSha,
        reviewRevisionHash: 'c'.repeat(64),
      },
    });

    expect(inventory.targets).toHaveLength(1);
    expect(inventory.targets[0]).toMatchObject({
      targetId: fixture.expectedProjectionTarget.targetId,
      threadId: fixture.expectedProjectionTarget.threadId,
      trustedMarker: fixture.expectedProjectionTarget.markerFingerprint,
      threadStateHash: fixture.expectedProjectionTarget.threadStateHash,
      disposition: 'human_reply',
    });
    expect(inventory.targets[0]).not.toHaveProperty('parentOwnedByIntegration');
    expect(inventory.targets[0]).not.toHaveProperty('hasHumanReply');
    expect(inventory.commandLedgerWatermark).toBe('0');
    expect(paginate).toHaveBeenCalledWith(listComments, {
      owner: 'owner',
      repo: 'repo',
      issue_number: 420,
      per_page: 100,
    });

    // The actual runner bootstrap uses this same adapter and real keyless ledger.
    const prompt = await adapter.loadForPrompt(420, headSha);
    expect(prompt.inventory).toEqual(inventory);
    expect(prompt.promptTargets).toHaveLength(2);
    expect(prompt.promptTargets[0].targetId).toBe(
      fixture.expectedProjectionTarget.targetId
    );
    expect(
      prompt.promptTargets.find(
        (target) => target.threadId === 'PRRT_untrusted_marker'
      )
    ).toMatchObject({
      trustedAuthor: false,
      reasonCodes: ['untrusted_author'],
      message: 'Copied finding context',
    });

    // Existing history cannot become an empty ledger without its verifier.
    paginate.mockResolvedValue([
      { id: 3, body: '<!-- reviewrouter-ledger:v1 -->' },
    ]);
    await expect(adapter.loadForPrompt(420, headSha)).rejects.toThrow(
      'review_action_v2_command_ledger_unavailable'
    );

    // A failed comment read is unknown, never proof of observed absence.
    const readFailure = new Error('fixture_comment_read_failed');
    paginate.mockRejectedValueOnce(readFailure);
    await expect(adapter.loadForPrompt(420, headSha)).rejects.toBe(readFailure);
  });
});

describe('managed lifecycle observation trust', () => {
  it('observes configured historical and own App threads without granting mutation trust', async () => {
    const keys = [
      'REVIEWROUTER_COMMENT_TOKEN_MODE',
      'REVIEW_ROUTER_COMMENT_TOKEN_STATUS',
      'REVIEW_ROUTER_LIFECYCLE_OBSERVATION_AUTHORS',
    ];
    const saved = keys.map((key) => process.env[key]);
    process.env.REVIEWROUTER_COMMENT_TOKEN_MODE = 'app-oidc';
    delete process.env.REVIEW_ROUTER_COMMENT_TOKEN_STATUS;
    applyAdmittedRuntimeConfig({
      protocolVersion: 1,
      configVersion: 1,
      runtimeEnv: {
        REVIEW_ROUTER_LIFECYCLE_OBSERVATION_AUTHORS: JSON.stringify([
          'github-actions[bot]',
        ]),
      },
    });
    try {
      const headSha = 'a'.repeat(40);
      const thread = (id: string, login: string, viewerDidAuthor: boolean) => ({
        id,
        isResolved: false,
        viewerCanResolve: true,
        path: 'src/app.ts',
        line: 12,
        comments: {
          pageInfo: { hasNextPage: false },
          nodes: [
            {
              id: `${id}_parent`,
              author: { login, __typename: 'Bot' },
              viewerDidAuthor,
              body: '<!-- review-router-finding:aaaaaaaaaaaaaaaaaaaaaaaa --> Finding',
              createdAt: '2026-08-05T09:00:00.000Z',
              updatedAt: '2026-08-05T09:00:00.000Z',
              path: 'src/app.ts',
              line: 12,
            },
          ],
        },
      });
      const graphql = jest.fn().mockResolvedValue({
        repository: {
          pullRequest: {
            headRefOid: headSha,
            reviewThreads: {
              pageInfo: { hasNextPage: false },
              nodes: [
                thread('own', 'reviewrouter-local-777genius', true),
                thread('historical', 'github-actions', false),
                thread('outsider', 'unrelated-bot', false),
              ],
            },
          },
        },
      });
      const client = {
        owner: 'owner',
        repo: 'repo',
        octokit: {
          graphql,
          rest: { issues: { listComments: jest.fn() } },
          paginate: jest.fn().mockResolvedValue([]),
        },
      } as unknown as GitHubClient;
      const adapter = new FreshGitHubLifecycleInventory(
        client,
        new ReviewLedger(client, undefined)
      );
      const { inventory, promptTargets } = await adapter.loadForPrompt(
        420,
        headSha
      );
      expect(inventory.targets.map((target) => target.threadId).sort()).toEqual(
        ['historical', 'own']
      );
      expect(inventory.complete).toBe(true);
      expect(
        inventory.targets.every(
          (target) => target.disposition === 'human_reply'
        )
      ).toBe(true);
      expect(
        promptTargets
          .filter((target) => ['historical', 'own'].includes(target.threadId))
          .every(
            (target) =>
              !target.trustedAuthor &&
              target.reasonCodes?.includes('untrusted_author')
          )
      ).toBe(true);
      expect(graphql.mock.calls[0][0]).toContain('viewerDidAuthor');
    } finally {
      keys.forEach((key, index) => {
        if (saved[index] === undefined) delete process.env[key];
        else process.env[key] = saved[index];
      });
    }
  });
});
