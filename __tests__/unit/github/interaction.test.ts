import fs from 'fs';
import os from 'os';
import path from 'path';
import { GitHubClient } from '../../../src/github/client';
import { ReviewLedger } from '../../../src/github/ledger';
import { ReviewInteractionHandler } from '../../../src/github/interaction';

function writeEvent(payload: unknown): string {
  const file = path.join(
    os.tmpdir(),
    `review-router-event-${Date.now()}-${Math.random()}.json`
  );
  fs.writeFileSync(file, JSON.stringify(payload));
  return file;
}

function makeClient() {
  const listReviewComments = jest.fn();
  const listComments = jest.fn();
  const octokit = {
    rest: {
      pulls: { listReviewComments },
      issues: {
        listComments,
        createComment: jest.fn().mockResolvedValue({}),
        updateComment: jest.fn().mockResolvedValue({}),
      },
      repos: {
        getCollaboratorPermissionLevel: jest.fn(),
      },
      actions: {
        listWorkflowRunsForRepo: jest.fn(),
        getWorkflowRun: jest.fn(),
        reRunWorkflowFailedJobs: jest.fn().mockResolvedValue({}),
      },
    },
    graphql: jest.fn((query: string) => {
      if (query.includes('reviewThreads')) {
        return Promise.resolve({
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  {
                    id: 'PRRT_thread_1',
                    isResolved: false,
                    comments: { nodes: [{ databaseId: 10 }] },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        });
      }
      return Promise.resolve({
        resolveReviewThread: {
          thread: { id: 'PRRT_thread_1', isResolved: true },
        },
      });
    }) as jest.Mock,
    paginate: jest.fn((method: jest.Mock) => {
      if (method === listReviewComments) {
        return Promise.resolve([
          {
            id: 10,
            path: 'src/file.ts',
            line: 10,
            body: '**🟡 Major - SQL injection**\n\nUse parameterized queries.',
          },
        ]);
      }
      if (method === listComments) {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    }),
  };
  const client = {
    octokit,
    owner: 'test-owner',
    repo: 'test-repo',
  } as unknown as GitHubClient;
  return { client, octokit };
}

describe('ReviewInteractionHandler', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('records /rr skip from maintainer and reruns the failed review job', async () => {
    const { client, octokit } = makeClient();
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: {
        id: 11,
        in_reply_to_id: 10,
        body: '/rr skip validated elsewhere',
        user: { login: 'maintainer' },
      },
      pull_request: {
        number: 123,
        head: { sha: 'abc', repo: { fork: false } },
        user: { login: 'author' },
      },
    });
    octokit.rest.repos.getCollaboratorPermissionLevel.mockResolvedValue({
      data: { permission: 'write', role_name: 'maintain' },
    });
    octokit.rest.actions.listWorkflowRunsForRepo.mockResolvedValue({
      data: {
        workflow_runs: [
          {
            id: 456,
            path: '.github/workflows/review-router.yml',
            head_sha: 'abc',
            conclusion: 'failure',
            pull_requests: [{ number: 123 }],
          },
        ],
      },
    });

    const ledger = new ReviewLedger(client, 'test-secret');
    await new ReviewInteractionHandler(client, ledger).execute();

    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 123,
        body: expect.stringContaining('reviewrouter-ledger:v1'),
      })
    );
    expect(octokit.rest.actions.reRunWorkflowFailedJobs).toHaveBeenCalledWith(
      expect.objectContaining({ run_id: 456 })
    );
    expect(octokit.graphql).toHaveBeenCalledWith(
      expect.stringContaining('resolveReviewThread'),
      { threadId: 'PRRT_thread_1' }
    );
  });

  it('uses the workflow token client for rerunning checks when comments use an App token', async () => {
    const { client: commentClient, octokit: commentOctokit } = makeClient();
    const { client: actionsClient, octokit: actionsOctokit } = makeClient();
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: {
        id: 11,
        in_reply_to_id: 10,
        body: '/rr skip validated by maintainer',
        user: { login: 'maintainer' },
      },
      pull_request: {
        number: 123,
        head: { sha: 'abc', repo: { fork: false } },
        user: { login: 'author' },
      },
    });
    actionsOctokit.rest.repos.getCollaboratorPermissionLevel.mockResolvedValue({
      data: { permission: 'write', role_name: 'maintain' },
    });
    actionsOctokit.rest.actions.listWorkflowRunsForRepo.mockResolvedValue({
      data: {
        workflow_runs: [
          {
            id: 456,
            path: '.github/workflows/review-router.yml',
            head_sha: 'abc',
            conclusion: 'failure',
            pull_requests: [{ number: 123 }],
          },
        ],
      },
    });
    commentOctokit.rest.actions.listWorkflowRunsForRepo.mockRejectedValue(
      Object.assign(new Error('App token must not rerun workflows'), {
        status: 403,
      })
    );

    const ledger = new ReviewLedger(commentClient, 'test-secret');
    await new ReviewInteractionHandler(
      commentClient,
      ledger,
      undefined,
      actionsClient
    ).execute();

    expect(
      actionsOctokit.rest.actions.reRunWorkflowFailedJobs
    ).toHaveBeenCalledWith(expect.objectContaining({ run_id: 456 }));
    expect(actionsOctokit.graphql).toHaveBeenCalledWith(
      expect.stringContaining('resolveReviewThread'),
      { threadId: 'PRRT_thread_1' }
    );
    expect(commentOctokit.graphql).not.toHaveBeenCalled();
    expect(
      commentOctokit.rest.actions.reRunWorkflowFailedJobs
    ).not.toHaveBeenCalled();
    expect(commentOctokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 123,
        body: expect.stringContaining('reviewrouter-ledger:v1'),
      })
    );
  });

  it('records /rr skip without requiring a reason', async () => {
    const { client, octokit } = makeClient();
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: {
        id: 11,
        in_reply_to_id: 10,
        body: '/rr skip',
        user: { login: 'maintainer' },
      },
      pull_request: {
        number: 123,
        head: { sha: 'abc', repo: { fork: false } },
        user: { login: 'author' },
      },
    });
    octokit.rest.repos.getCollaboratorPermissionLevel.mockResolvedValue({
      data: { permission: 'write', role_name: 'maintain' },
    });
    octokit.rest.actions.listWorkflowRunsForRepo.mockResolvedValue({
      data: {
        workflow_runs: [
          {
            id: 456,
            path: '.github/workflows/review-router.yml',
            head_sha: 'abc',
            conclusion: 'failure',
            pull_requests: [{ number: 123 }],
          },
        ],
      },
    });

    const ledger = new ReviewLedger(client, 'test-secret');
    await new ReviewInteractionHandler(client, ledger).execute();

    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 123,
        body: expect.stringContaining('reviewrouter-ledger:v1'),
      })
    );
    expect(octokit.rest.actions.reRunWorkflowFailedJobs).toHaveBeenCalledWith(
      expect.objectContaining({ run_id: 456 })
    );
  });

  it('waits for an active review rerun and reruns again if it still fails', async () => {
    const { client, octokit } = makeClient();
    process.env.REVIEW_ROUTER_RERUN_WAIT_SECONDS = '1';
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: {
        id: 11,
        in_reply_to_id: 10,
        body: '/rr skip',
        user: { login: 'maintainer' },
      },
      pull_request: {
        number: 123,
        head: { sha: 'abc', repo: { fork: false } },
        user: { login: 'author' },
      },
    });
    octokit.rest.repos.getCollaboratorPermissionLevel.mockResolvedValue({
      data: { permission: 'write', role_name: 'maintain' },
    });
    octokit.rest.actions.listWorkflowRunsForRepo.mockResolvedValue({
      data: {
        workflow_runs: [
          {
            id: 456,
            path: '.github/workflows/review-router.yml',
            head_sha: 'abc',
            status: 'in_progress',
            conclusion: null,
            updated_at: '2026-05-01T17:46:44Z',
            pull_requests: [{ number: 123 }],
          },
        ],
      },
    });
    octokit.rest.actions.getWorkflowRun.mockResolvedValue({
      data: {
        id: 456,
        status: 'completed',
        conclusion: 'failure',
      },
    });

    const ledger = new ReviewLedger(client, 'test-secret');
    await new ReviewInteractionHandler(client, ledger).execute();

    expect(octokit.rest.actions.getWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({ run_id: 456 })
    );
    expect(octokit.rest.actions.reRunWorkflowFailedJobs).toHaveBeenCalledWith(
      expect.objectContaining({ run_id: 456 })
    );
  });

  it('unresolves the conversation for /rr unskip', async () => {
    const { client, octokit } = makeClient();
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: {
        id: 11,
        in_reply_to_id: 10,
        body: '/rr unskip',
        user: { login: 'maintainer' },
      },
      pull_request: {
        number: 123,
        head: { sha: 'abc', repo: { fork: false } },
        user: { login: 'author' },
      },
    });
    octokit.graphql.mockImplementation((query: string) => {
      if (query.includes('reviewThreads')) {
        return Promise.resolve({
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  {
                    id: 'PRRT_thread_1',
                    isResolved: true,
                    comments: { nodes: [{ databaseId: 10 }] },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        });
      }
      return Promise.resolve({
        unresolveReviewThread: {
          thread: { id: 'PRRT_thread_1', isResolved: false },
        },
      });
    });
    octokit.rest.repos.getCollaboratorPermissionLevel.mockResolvedValue({
      data: { permission: 'write', role_name: 'maintain' },
    });
    octokit.rest.actions.listWorkflowRunsForRepo.mockResolvedValue({
      data: {
        workflow_runs: [
          {
            id: 456,
            path: '.github/workflows/review-router.yml',
            head_sha: 'abc',
            conclusion: 'failure',
            pull_requests: [{ number: 123 }],
          },
        ],
      },
    });

    const ledger = new ReviewLedger(client, 'test-secret');
    await new ReviewInteractionHandler(client, ledger).execute();

    expect(octokit.graphql).toHaveBeenCalledWith(
      expect.stringContaining('unresolveReviewThread'),
      { threadId: 'PRRT_thread_1' }
    );
  });

  it('rejects blocking skips from PR authors without maintain/admin permission by default', async () => {
    const { client, octokit } = makeClient();
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: {
        id: 11,
        in_reply_to_id: 10,
        body: '/rr skip',
        user: { login: 'author' },
      },
      pull_request: {
        number: 123,
        head: { sha: 'abc', repo: { fork: false } },
        user: { login: 'Author' },
      },
    });
    octokit.rest.repos.getCollaboratorPermissionLevel.mockResolvedValue({
      data: { permission: 'write', role_name: 'write' },
    });

    const ledger = new ReviewLedger(client, 'test-secret');
    await new ReviewInteractionHandler(client, ledger).execute();

    expect(octokit.rest.actions.reRunWorkflowFailedJobs).not.toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 123,
        body: expect.stringContaining(
          'PR authors without maintain/admin permission cannot override blocking ReviewRouter findings by default'
        ),
      })
    );
  });

  it('allows blocking skips from PR authors with admin permission', async () => {
    const { client, octokit } = makeClient();
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: {
        id: 11,
        in_reply_to_id: 10,
        body: '/rr skip owner verified',
        user: { login: 'owner' },
      },
      pull_request: {
        number: 123,
        head: { sha: 'abc', repo: { fork: false } },
        user: { login: 'Owner' },
      },
    });
    octokit.rest.repos.getCollaboratorPermissionLevel.mockResolvedValue({
      data: { permission: 'admin', role_name: 'admin' },
    });
    octokit.rest.actions.listWorkflowRunsForRepo.mockResolvedValue({
      data: {
        workflow_runs: [
          {
            id: 456,
            path: '.github/workflows/review-router.yml',
            head_sha: 'abc',
            conclusion: 'failure',
            pull_requests: [{ number: 123 }],
          },
        ],
      },
    });

    const ledger = new ReviewLedger(client, 'test-secret');
    await new ReviewInteractionHandler(client, ledger).execute();

    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 123,
        body: expect.stringContaining('reviewrouter-ledger:v1'),
      })
    );
    expect(octokit.rest.actions.reRunWorkflowFailedJobs).toHaveBeenCalledWith(
      expect.objectContaining({ run_id: 456 })
    );
  });

  it('does not rerun when the ledger key is missing', async () => {
    const { client, octokit } = makeClient();
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: {
        id: 11,
        in_reply_to_id: 10,
        body: '/rr skip validated elsewhere',
        user: { login: 'maintainer' },
      },
      pull_request: {
        number: 123,
        head: { sha: 'abc', repo: { fork: false } },
        user: { login: 'author' },
      },
    });
    octokit.rest.repos.getCollaboratorPermissionLevel.mockResolvedValue({
      data: { permission: 'write', role_name: 'maintain' },
    });

    const ledger = new ReviewLedger(client, undefined);
    await new ReviewInteractionHandler(client, ledger).execute();

    expect(octokit.rest.actions.reRunWorkflowFailedJobs).not.toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 123,
        body: expect.stringContaining('Could not record `/rr skip`'),
      })
    );
  });
});
