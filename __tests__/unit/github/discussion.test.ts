import { createHash } from 'crypto';
import { GitHubClient } from '../../../src/github/client';
import { ReviewDiscussionHandler } from '../../../src/github/discussion';
import { DiscussionResponder } from '../../../src/discussion/types';

const parentBody = [
  '**🟡 Major - SQL injection**',
  '',
  'This query interpolates user input.',
  '',
  '<!-- review-router-inline:1234567890abcdef -->',
].join('\n');

function makeClient(comments: any[]) {
  const listReviewComments = jest.fn();
  const octokit = {
    rest: {
      pulls: {
        listReviewComments,
        createReplyForReviewComment: jest.fn().mockResolvedValue({}),
        updateReviewComment: jest.fn().mockResolvedValue({}),
      },
    },
    paginate: jest.fn((method: jest.Mock) => {
      if (method === listReviewComments) {
        return Promise.resolve(comments);
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

function makePayload(body = 'This is handled by validation elsewhere.') {
  return {
    comment: {
      id: 11,
      in_reply_to_id: 10,
      body,
      user: { login: 'maintainer', type: 'User' },
    },
    pull_request: {
      number: 123,
      head: { sha: 'abc', repo: { fork: false } },
      user: { login: 'author' },
    },
    repository: { full_name: 'test-owner/test-repo' },
  };
}

function makeHandler(client: GitHubClient, responder?: DiscussionResponder) {
  return new ReviewDiscussionHandler(client, responder, {
    mode: 'suggest',
    maxPerPr: 20,
    maxPerThread: 5,
  });
}

describe('ReviewDiscussionHandler', () => {
  it('preflights a human reply to a ReviewRouter inline finding', async () => {
    const { client } = makeClient([
      { id: 10, path: 'src/users.ts', line: 10, body: parentBody },
      {
        id: 11,
        in_reply_to_id: 10,
        body: 'This is handled by validation elsewhere.',
        user: { login: 'maintainer', type: 'User' },
      },
    ]);

    const result = await makeHandler(client).preflight(makePayload());

    expect(result).toEqual({
      shouldRun: true,
      needsDiscussion: true,
      reason: 'needs AI discussion response',
    });
  });

  it('does not run discussion for unrelated review replies', async () => {
    const { client } = makeClient([
      { id: 10, path: 'src/users.ts', line: 10, body: 'Human review comment' },
    ]);

    const result = await makeHandler(client).preflight(makePayload());

    expect(result.shouldRun).toBe(false);
    expect(result.reason).toBe('parent is not a ReviewRouter finding');
  });

  it('posts a discussion reply and suggests /rr skip without changing the ledger', async () => {
    const { client, octokit } = makeClient([
      {
        id: 10,
        path: 'src/users.ts',
        line: 10,
        diff_hunk: '@@ -1 +1 @@',
        body: parentBody,
      },
      {
        id: 11,
        in_reply_to_id: 10,
        body: 'This is a false positive because the ORM escapes it.',
        user: { login: 'maintainer', type: 'User' },
      },
    ]);
    const responder: DiscussionResponder = {
      respond: jest.fn().mockResolvedValue({
        intent: 'dismiss_request',
        confidence: 0.92,
        agreesWithUser: true,
        answer:
          'That explanation is plausible if the ORM parameterizes this path.',
        suggestedAction: 'suggest_rr_skip',
      }),
    };

    await makeHandler(client, responder).execute(
      makePayload('This is a false positive because the ORM escapes it.')
    );

    expect(octokit.rest.pulls.createReplyForReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'test-owner',
        repo: 'test-repo',
        pull_number: 123,
        comment_id: 10,
        body: expect.stringContaining('maintainer agrees'),
      })
    );
    const body =
      octokit.rest.pulls.createReplyForReviewComment.mock.calls[0][0].body;
    expect(body).toContain('reviewrouter-discussion:v1');
    expect(body).toContain('/rr skip');
    expect(octokit.rest.pulls.updateReviewComment).not.toHaveBeenCalled();
  });

  it('updates the previous bot reply when a human edits the same comment', async () => {
    const oldBody = 'old disagreement';
    const newBody = 'updated disagreement';
    const { client, octokit } = makeClient([
      { id: 10, path: 'src/users.ts', line: 10, body: parentBody },
      {
        id: 11,
        in_reply_to_id: 10,
        body: newBody,
        user: { login: 'maintainer', type: 'User' },
      },
      {
        id: 12,
        in_reply_to_id: 10,
        body: `<!-- reviewrouter-discussion:v1 user_comment_id=11 body_sha=${sha(oldBody)} -->\n\nold answer`,
        user: { login: 'review-router[bot]', type: 'Bot' },
      },
    ]);
    const responder: DiscussionResponder = {
      respond: jest.fn().mockResolvedValue({
        intent: 'disagreement',
        confidence: 0.8,
        agreesWithUser: false,
        answer: 'The risk still applies on this path.',
        suggestedAction: 'none',
      }),
    };

    await makeHandler(client, responder).execute(makePayload(newBody));

    expect(octokit.rest.pulls.updateReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({
        comment_id: 12,
        body: expect.stringContaining(sha(newBody)),
      })
    );
    expect(
      octokit.rest.pulls.createReplyForReviewComment
    ).not.toHaveBeenCalled();
  });

  it('updates an existing bot reply even when the thread reply limit is reached', async () => {
    const oldBody = 'old disagreement';
    const newBody = 'updated disagreement';
    const comments = [
      { id: 10, path: 'src/users.ts', line: 10, body: parentBody },
      {
        id: 11,
        in_reply_to_id: 10,
        body: newBody,
        user: { login: 'maintainer', type: 'User' },
      },
      {
        id: 12,
        in_reply_to_id: 10,
        body: `<!-- reviewrouter-discussion:v1 user_comment_id=11 body_sha=${sha(oldBody)} -->\n\nold answer`,
        user: { login: 'review-router[bot]', type: 'Bot' },
      },
      ...[13, 14, 15, 16].map((id) => ({
        id,
        in_reply_to_id: 10,
        body: `<!-- reviewrouter-discussion:v1 user_comment_id=${id + 100} body_sha=${sha(`body-${id}`)} -->\n\nanswer ${id}`,
        user: { login: 'review-router[bot]', type: 'Bot' },
      })),
    ];
    const { client, octokit } = makeClient(comments);
    const responder: DiscussionResponder = {
      respond: jest.fn().mockResolvedValue({
        intent: 'disagreement',
        confidence: 0.8,
        agreesWithUser: false,
        answer: 'The risk still applies on this path.',
        suggestedAction: 'none',
      }),
    };

    await makeHandler(client, responder).execute(makePayload(newBody));

    expect(octokit.rest.pulls.updateReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({
        comment_id: 12,
        body: expect.stringContaining(sha(newBody)),
      })
    );
    expect(
      octokit.rest.pulls.createReplyForReviewComment
    ).not.toHaveBeenCalled();
  });

  it('posts a safe fallback reply when the AI responder fails', async () => {
    const { client, octokit } = makeClient([
      { id: 10, path: 'src/users.ts', line: 10, body: parentBody },
      {
        id: 11,
        in_reply_to_id: 10,
        body: 'Can you explain this?',
        user: { login: 'maintainer', type: 'User' },
      },
    ]);
    const responder: DiscussionResponder = {
      respond: jest
        .fn()
        .mockRejectedValue(new Error('sk-secret-value-123456789')),
    };

    await makeHandler(client, responder).execute(
      makePayload('Can you explain this?')
    );

    const body =
      octokit.rest.pulls.createReplyForReviewComment.mock.calls[0][0].body;
    expect(body).toContain('I could not evaluate this reply automatically');
    expect(body).toContain('sk-***');
    expect(body).not.toContain('sk-secret-value');
  });

  it('suppresses duplicate processing for the same edited comment body', async () => {
    const body = 'same body';
    const { client } = makeClient([
      { id: 10, path: 'src/users.ts', line: 10, body: parentBody },
      {
        id: 11,
        in_reply_to_id: 10,
        body,
        user: { login: 'maintainer', type: 'User' },
      },
      {
        id: 12,
        in_reply_to_id: 10,
        body: `<!-- reviewrouter-discussion:v1 user_comment_id=11 body_sha=${sha(body)} -->\n\nexisting answer`,
        user: { login: 'review-router[bot]', type: 'Bot' },
      },
    ]);

    const result = await makeHandler(client).preflight(makePayload(body));

    expect(result.shouldRun).toBe(false);
    expect(result.reason).toBe('discussion reply already exists for this body');
  });
});

function sha(body: string): string {
  return createHash('sha256').update(body.trim()).digest('hex');
}
