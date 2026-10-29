import { createHash, createHmac } from 'crypto';
import type { GitHubClient } from '../../../src/github/client';
import {
  canonicalJson,
  ReviewLedger,
  ReviewLedgerPayload,
} from '../../../src/github/ledger';
import {
  FreshGitHubLifecycleInventory,
  toRevalidationTargets,
} from '../../../src/review-orchestration/infrastructure/github-review-state-adapter';
import { ReviewThreadInventoryLoader } from '../../../src/github/review-thread-inventory';

const headSha = 'a'.repeat(40);
const createdAt = '2026-10-20T09:00:00Z';
const fingerprint = (name: string): string =>
  createHash('sha256').update(name).digest('hex').slice(0, 24);
const body = (name: string): string =>
  `**Major - ${name}**\n\nThe original failure condition.\n\n<!-- review-router-finding:${fingerprint(name)} -->`;
function thread(
  name: string,
  options: {
    updatedAt?: string | null;
    author?: string;
    humanReply?: boolean;
    resolved?: boolean;
  } = {}
) {
  return {
    id: name,
    isResolved: options.resolved ?? false,
    viewerCanResolve: true,
    path: 'src/outside-diff.ts',
    line: 7,
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: `parent-${name}`,
          databaseId: 100,
          author: { login: options.author ?? 'review-router-ai[bot]' },
          body: body(name),
          createdAt,
          updatedAt:
            options.updatedAt === undefined ? createdAt : options.updatedAt,
          publishedAt: null,
          lastEditedAt: null,
          path: 'src/outside-diff.ts',
          originalLine: 5,
          line: 7,
        },
        ...(options.humanReply
          ? [
              {
                id: `reply-${name}`,
                author: { login: 'human-reviewer' },
                body: 'Please keep this thread open.',
                createdAt: '2026-10-20T10:00:00Z',
                updatedAt: '2026-10-20T10:00:00Z',
              },
            ]
          : []),
      ],
    },
  };
}
function clientFor(
  nodes: readonly unknown[],
  ledgerPayload?: ReviewLedgerPayload
): GitHubClient {
  const secret = 'fixture-ledger-key';
  const encoded = ledgerPayload
    ? Buffer.from(canonicalJson(ledgerPayload)).toString('base64url')
    : '';
  const signature = ledgerPayload
    ? createHmac('sha256', secret)
        .update(canonicalJson(ledgerPayload))
        .digest('hex')
    : '';
  return {
    owner: 'owner',
    repo: 'repo',
    octokit: {
      graphql: async () => ({
        repository: {
          pullRequest: {
            headRefOid: headSha,
            reviewThreads: { pageInfo: { hasNextPage: false }, nodes },
          },
        },
      }),
      rest: { issues: { listComments: () => undefined } },
      paginate: async () =>
        ledgerPayload
          ? [
              {
                id: 1,
                body: `<!-- reviewrouter-ledger:v1 payload=${encoded} signature=${signature} -->`,
              },
            ]
          : [],
    },
  } as unknown as GitHubClient;
}

// A regression here could send an edited, discussed or command-dismissed old claim to inference.
it('maps native parent witnesses and signed command suppression without trusting missing edit evidence', async () => {
  const payload: ReviewLedgerPayload = {
    version: 1,
    repo: 'owner/repo',
    pr: 42,
    entries: [
      {
        action: 'skip',
        fingerprint: fingerprint('skipped'),
        severity: 'major',
        actor: 'maintainer',
        actorRole: 'admin',
        parentCommentId: 999,
        commandCommentId: 1000,
        createdAt: '2026-10-20T10:00:00Z',
      },
    ],
  };
  const client = clientFor(
    [
      thread('clean'),
      thread('edited', { updatedAt: '2026-10-20T09:05:00Z' }),
      thread('unknown-edit', { updatedAt: null }),
      thread('discussed', { humanReply: true }),
      thread('skipped'),
      thread('untrusted', { author: 'human-author' }),
      thread('closed', { resolved: true }),
    ],
    payload
  );
  const adapter = new FreshGitHubLifecycleInventory(
    client,
    new ReviewLedger(client, 'fixture-ledger-key')
  );
  const loaded = await adapter.loadForPrompt(42, headSha);
  const targets = new Map(
    loaded.revalidationTargets.map((target) => [target.threadId, target])
  );
  expect(targets.size).toBe(6);
  expect(targets.has('closed')).toBe(false);
  expect(targets.get('clean')).toMatchObject({
    parentId: 'parent-clean',
    parentCreatedAt: '2026-10-20T09:00:00.000Z',
    parentUpdatedAt: '2026-10-20T09:00:00.000Z',
    parentBodyHash: createHash('sha256')
      .update(body('clean'), 'utf8')
      .digest('hex'),
    ledgerWatermark: '1000',
    originalPath: 'src/outside-diff.ts',
    currentPath: 'src/outside-diff.ts',
    trusted: true,
    parentEdited: false,
    markerAmbiguous: false,
    hasHumanReply: false,
    commandDismissed: false,
  });
  expect(targets.get('clean')!.claimHash).toMatch(/^[a-f0-9]{64}$/);
  expect(targets.get('clean')!.commentStateHash).toMatch(/^[a-f0-9]{64}$/);
  expect(targets.get('edited')!.parentEdited).toBe(true);
  expect(targets.get('unknown-edit')!.parentEdited).toBe(true);
  expect(targets.get('discussed')!.hasHumanReply).toBe(true);
  expect(targets.get('skipped')!.commandDismissed).toBe(true);
  expect(targets.get('untrusted')!.trusted).toBe(false);
});

// Detects losing replies from the witness or binding a cleaned claim to the raw parent hash.
it('binds full thread comments independently of the raw parent and clean claim', async () => {
  const snapshots = [];
  for (const humanReply of [false, true]) {
    const client = clientFor([thread('same-parent', { humanReply })]);
    const loaded = await new FreshGitHubLifecycleInventory(
      client,
      new ReviewLedger(client, undefined)
    ).loadForPrompt(42, headSha);
    snapshots.push(loaded.revalidationTargets[0]!);
  }
  expect(snapshots[0]!.parentBodyHash).toBe(snapshots[1]!.parentBodyHash);
  expect(snapshots[0]!.claimHash).toBe(snapshots[1]!.claimHash);
  expect(snapshots[0]!.commentStateHash).not.toBe(
    snapshots[1]!.commentStateHash
  );
  const client = clientFor([thread('same-parent')]);
  const raw = await new ReviewThreadInventoryLoader(client).load(42);
  const oldFixture = {
    ...raw,
    candidates: raw.candidates.map(
      ({
        parentCommentCreatedAt: _created,
        parentCommentBodyHash: _body,
        claimHash: _claim,
        parentCommentEdited: _edited,
        findingMarkerAmbiguous: _marker,
        ...legacy
      }) => legacy
    ),
  };
  const legacyMapped = toRevalidationTargets(oldFixture, '0');
  expect(legacyMapped[0]).toMatchObject({
    trusted: false,
    parentEdited: true,
    markerAmbiguous: true,
  });
});
