import { createHash } from 'crypto';
import { ControlPlaneConversationClient } from '../../../src/control-plane/conversations';
import {
  ManagedConversationHandler,
  conversationSource,
} from '../../../src/github/conversation';
import type { GitHubClient } from '../../../src/github/client';

const marker = '<!-- reviewrouter-conversation:v1 processing_id=record-1 -->';
const body = `The bounded adapter uses a timer.\n\n${marker}`;
const bodyDigest = createHash('sha256').update(body).digest('hex');
const payload = {
  action: 'created',
  comment: {
    id: 11,
    updated_at: '2026-10-28T00:00:00Z',
    body: 'Informative human explanation, no command.',
    in_reply_to_id: 10,
    user: { type: 'User', login: 'maintainer' },
  },
  pull_request: { number: 1, head: { repo: { fork: false } } },
};
const result = {
  protocolVersion: 2,
  processingId: 'record-1',
  status: 'ready',
  learning: { status: 'queued', effectIds: ['effect-1'] },
  reply: { body, bodyDigest, marker, parentCommentId: '10' },
};

function fixture(
  options: {
    status?: string;
    comments?: unknown[];
    createError?: boolean;
    badDigest?: boolean;
    replyMode?: 'off' | 'suggest';
  } = {}
) {
  const calls: Array<{ url: string; request: Record<string, unknown> }> = [];
  const fetchImpl = jest.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), request: JSON.parse(String(init?.body)) });
    expect((init?.headers as Record<string, string>).authorization).toBe(
      'Bearer session-only'
    );
    return new Response(
      JSON.stringify({
        ...result,
        status: options.status ?? 'ready',
        ...(options.badDigest
          ? { reply: { ...result.reply, bodyDigest: 'a'.repeat(64) } }
          : {}),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }) as unknown as typeof fetch;
  const conversations = new ControlPlaneConversationClient(
    {
      status: 'applied',
      apiUrl: 'https://api.example',
      sessionToken: 'session-only',
      actionVersion: 'a'.repeat(40),
      configVersion: 1,
    },
    fetchImpl
  );
  const createReplyForReviewComment = options.createError
    ? jest.fn().mockRejectedValue(new Error('lost ACK'))
    : jest.fn().mockResolvedValue({ data: { id: 77 } });
  const listReviewComments = jest.fn();
  const client = {
    owner: 'owner',
    repo: 'repo',
    octokit: {
      paginate: jest.fn().mockResolvedValue(options.comments ?? []),
      rest: { pulls: { listReviewComments, createReplyForReviewComment } },
    },
  } as unknown as GitHubClient;
  return {
    calls,
    client,
    createReplyForReviewComment,
    handler: new ManagedConversationHandler(client, conversations, {
      replyMode: options.replyMode ?? 'suggest',
    }),
  };
}

describe('managed App conversation boundary', () => {
  it('sends only source references and publishes the exact frozen envelope after server learning', async () => {
    const f = fixture();
    await f.handler.execute(payload);
    expect(f.calls[0]).toEqual({
      url: 'https://api.example/api/action/v2/conversations/process',
      request: {
        protocolVersion: 2,
        pullRequestNumber: 1,
        sourceCommentId: '11',
        sourceRevision: '2026-10-28T00:00:00Z',
        eventAction: 'created',
        replyMode: 'suggest',
      },
    });
    expect(JSON.stringify(f.calls)).not.toContain(
      'Informative human explanation'
    );
    expect(f.createReplyForReviewComment).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      pull_number: 1,
      comment_id: 10,
      body,
    });
    expect(f.calls[1].request).toEqual({
      protocolVersion: 2,
      processingId: 'record-1',
      status: 'published',
      commentId: '77',
      bodyDigest,
    });
  });
  it.each(['silent', 'context_incomplete', 'published', 'output_unavailable'])(
    'executes learning even without a publishable reply (%s)',
    async (status) => {
      const f = fixture({ status });
      await f.handler.execute(payload);
      expect(f.calls).toHaveLength(1);
      expect(f.createReplyForReviewComment).not.toHaveBeenCalled();
    }
  );
  it('forwards reply-off as a restrictive server policy while still processing learning', async () => {
    const f = fixture({ replyMode: 'off' });
    await f.handler.execute(payload);
    expect(f.calls[0]?.request.replyMode).toBe('off');
    expect(f.calls).toHaveLength(1);
    expect(f.createReplyForReviewComment).not.toHaveBeenCalled();
  });

  it('reconciles a lost create receipt by marker without a second publication', async () => {
    const first = fixture({ createError: true });
    await first.handler.execute(payload);
    expect(first.calls[1].request.status).toBe('unknown');
    const retry = fixture({
      status: 'unknown',
      comments: [{ id: 77, body, in_reply_to_id: 10, user: { type: 'Bot' } }],
    });
    await retry.handler.execute(payload);
    expect(retry.createReplyForReviewComment).not.toHaveBeenCalled();
    expect(retry.calls[1].request).toMatchObject({
      status: 'published',
      commentId: '77',
      bodyDigest,
    });
  });
  it('does not recreate unknown output or accept a human marker forgery', async () => {
    for (const comments of [
      [],
      [{ id: 77, body, in_reply_to_id: 10, user: { type: 'User' } }],
    ]) {
      const f = fixture({ status: 'unknown', comments });
      await f.handler.execute(payload);
      expect(f.createReplyForReviewComment).not.toHaveBeenCalled();
      expect(f.calls[1].request.status).toBe('unknown');
    }
  });
  it('rejects altered frozen output before any GitHub publication', async () => {
    const f = fixture({ badDigest: true });
    await expect(f.handler.execute(payload)).rejects.toThrow(
      'conversation_response_invalid'
    );
    expect(f.createReplyForReviewComment).not.toHaveBeenCalled();
  });
  it('forwards edited and deleted source events independently of body/reply settings', () => {
    expect(
      conversationSource({ ...payload, action: 'edited' })?.eventAction
    ).toBe('edited');
    expect(
      conversationSource({
        ...payload,
        action: 'deleted',
        comment: { ...payload.comment, body: '' },
      })?.eventAction
    ).toBe('deleted');
    expect(
      conversationSource({
        ...payload,
        comment: {
          ...payload.comment,
          user: { type: 'Bot', login: 'router[bot]' },
        },
      })
    ).toBeNull();
    expect(
      conversationSource({
        ...payload,
        pull_request: { number: 1, head: { repo: { fork: true } } },
      })
    ).toBeNull();
  });
});
