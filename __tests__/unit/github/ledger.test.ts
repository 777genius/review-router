import { ReviewLedger } from '../../../src/github/ledger';
import { GitHubClient } from '../../../src/github/client';

function makeClient(
  comments: Array<{ id?: number; body?: string | null }> = []
) {
  const octokit = {
    rest: {
      issues: {
        listComments: jest.fn(),
        createComment: jest.fn().mockResolvedValue({}),
        updateComment: jest.fn().mockResolvedValue({}),
      },
    },
    paginate: jest.fn().mockResolvedValue(comments),
  };
  const client = {
    octokit,
    owner: 'test-owner',
    repo: 'test-repo',
  } as unknown as GitHubClient;
  return { client, octokit };
}

describe('ReviewLedger', () => {
  it('creates a signed ledger comment and can load it back', async () => {
    const { client, octokit } = makeClient([]);
    const ledger = new ReviewLedger(client, 'test-secret');

    await ledger.append(123, {
      action: 'skip',
      fingerprint: 'abc123',
      severity: 'major',
      path: 'src/file.ts',
      line: 10,
      actor: 'maintainer',
      actorRole: 'maintain',
      parentCommentId: 99,
      createdAt: '2026-05-01T00:00:00.000Z',
    });

    const createdBody = octokit.rest.issues.createComment.mock.calls[0][0].body;
    expect(createdBody).toContain('reviewrouter-ledger:v1');
    expect(createdBody).toContain('signature=');

    octokit.paginate.mockResolvedValue([{ id: 1, body: createdBody }]);
    const loaded = await ledger.load(123);

    expect(loaded.valid).toBe(true);
    expect(loaded.payload.entries).toHaveLength(1);
    expect(ledger.activeSkips(loaded.payload)).toHaveLength(1);
  });

  it('rejects edited ledger comments with invalid signatures', async () => {
    const body = [
      '<!-- reviewrouter-ledger:v1',
      `payload=${Buffer.from('{"version":1,"repo":"test-owner/test-repo","pr":123,"entries":[]}', 'utf8').toString('base64url')}`,
      'signature=0000000000000000000000000000000000000000000000000000000000000000',
      '-->',
    ].join('\n');
    const { client } = makeClient([{ id: 1, body }]);
    const ledger = new ReviewLedger(client, 'test-secret');

    const loaded = await ledger.load(123);

    expect(loaded.valid).toBe(false);
    expect(loaded.invalidReason).toContain('signature');
  });

  it('ignores an invalid earlier marker when a valid signed ledger exists', async () => {
    const { client, octokit } = makeClient([]);
    const ledger = new ReviewLedger(client, 'test-secret');
    await ledger.append(123, {
      action: 'skip',
      fingerprint: 'abc123',
      severity: 'major',
      path: 'src/file.ts',
      line: 10,
      actor: 'maintainer',
      actorRole: 'maintain',
      parentCommentId: 99,
      createdAt: '2026-05-01T00:00:00.000Z',
    });
    const validBody = octokit.rest.issues.createComment.mock.calls[0][0].body;
    const invalidBody = [
      '<!-- reviewrouter-ledger:v1',
      `payload=${Buffer.from('{"version":1,"repo":"test-owner/test-repo","pr":123,"entries":[]}', 'utf8').toString('base64url')}`,
      'signature=0000000000000000000000000000000000000000000000000000000000000000',
      '-->',
    ].join('\n');
    octokit.paginate.mockResolvedValue([
      { id: 1, body: invalidBody },
      { id: 2, body: validBody },
    ]);

    const loaded = await ledger.load(123);

    expect(loaded.valid).toBe(true);
    expect(loaded.commentId).toBe(2);
    expect(ledger.activeSkips(loaded.payload)).toHaveLength(1);
  });

  it('does not update a malformed marker comment when appending a new entry', async () => {
    const invalidBody = [
      '<!-- reviewrouter-ledger:v1',
      `payload=${Buffer.from('{"version":1,"repo":"test-owner/test-repo","pr":123,"entries":[]}', 'utf8').toString('base64url')}`,
      'signature=0000000000000000000000000000000000000000000000000000000000000000',
      '-->',
    ].join('\n');
    const { client, octokit } = makeClient([{ id: 1, body: invalidBody }]);
    const ledger = new ReviewLedger(client, 'test-secret');

    await ledger.append(123, {
      action: 'skip',
      fingerprint: 'abc123',
      severity: 'major',
      actor: 'maintainer',
      actorRole: 'maintain',
      parentCommentId: 99,
      createdAt: '2026-05-01T00:00:00.000Z',
    });

    expect(octokit.rest.issues.updateComment).not.toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 123,
        body: expect.stringContaining('reviewrouter-ledger:v1'),
      })
    );
  });

  it('refuses to append when the signing key is missing', async () => {
    const { client, octokit } = makeClient([]);
    const ledger = new ReviewLedger(client, undefined);

    await expect(
      ledger.append(123, {
        action: 'skip',
        fingerprint: 'abc123',
        severity: 'major',
        actor: 'maintainer',
        actorRole: 'maintain',
        parentCommentId: 99,
        createdAt: '2026-05-01T00:00:00.000Z',
      })
    ).rejects.toThrow('REVIEW_ROUTER_LEDGER_KEY');
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it('honors unskip as the latest action for a fingerprint', async () => {
    const { client } = makeClient([]);
    const ledger = new ReviewLedger(client, 'test-secret', true);
    const payload = {
      version: 1 as const,
      repo: 'test-owner/test-repo',
      pr: 123,
      entries: [
        {
          action: 'skip' as const,
          fingerprint: 'abc123',
          severity: 'major' as const,
          actor: 'maintainer',
          actorRole: 'maintain',
          parentCommentId: 1,
          createdAt: '2026-05-01T00:00:00.000Z',
        },
        {
          action: 'unskip' as const,
          fingerprint: 'abc123',
          severity: 'major' as const,
          actor: 'maintainer',
          actorRole: 'maintain',
          parentCommentId: 1,
          createdAt: '2026-05-01T00:01:00.000Z',
        },
      ],
    };

    expect(ledger.activeSkips(payload)).toHaveLength(0);
  });
});
