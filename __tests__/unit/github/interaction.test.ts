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
        reRunWorkflowFailedJobs: jest.fn().mockResolvedValue({}),
      },
    },
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

  it('rejects blocking skips from PR authors by default', async () => {
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
      data: { permission: 'admin', role_name: 'admin' },
    });

    const ledger = new ReviewLedger(client, 'test-secret');
    await new ReviewInteractionHandler(client, ledger).execute();

    expect(octokit.rest.actions.reRunWorkflowFailedJobs).not.toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 123,
        body: expect.stringContaining('cannot skip this major finding'),
      })
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
