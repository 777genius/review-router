import { createHash } from 'crypto';
import { ReviewThreadInventoryLoader } from '../../../src/github/review-thread-inventory';
import { GitHubClient } from '../../../src/github/client';
import { FindingSeverity } from '../../../src/review-projection/domain';

const lineageId = `rrl_${'a'.repeat(32)}`;
const prior = {
  lineageId,
  category: 'correctness',
  normalizedFailureModeHash: 'a'.repeat(64),
  severity: FindingSeverity.Major,
  title: 'Original finding',
  message: 'Full body',
  filePath: 'a.ts',
  line: 1,
  firstSeenHeadSha: '1'.repeat(40),
  lastSeenHeadSha: '1'.repeat(40),
  active: true,
};
const parent = {
  id: 'parent',
  author: { login: 'review-router-ai', __typename: 'Bot' },
  body: `Finding\nreviewrouter:finding:v2:${lineageId}`,
  createdAt: '2026-10-22T00:00:00Z',
  updatedAt: '2026-10-22T00:00:00Z',
  path: 'a.ts',
  line: 1,
};
const targetId = `rrt_${createHash('sha256').update(`thread\nparent\n${lineageId}`).digest('hex').slice(0, 16)}`;
const reply = {
  id: 'resolution',
  author: parent.author,
  body: `<!-- reviewrouter-lifecycle-resolution:v1 target_id=${targetId} fingerprint=${lineageId} -->`,
  createdAt: '2026-10-22T01:00:00Z',
  updatedAt: '2026-10-22T01:00:00Z',
};
function loader(comments: unknown[], resolved = true, hasMoreComments = false) {
  const graphql = jest.fn().mockResolvedValue({
    repository: {
      pullRequest: {
        headRefOid: '2'.repeat(40),
        reviewThreads: {
          pageInfo: { hasNextPage: false },
          nodes: [
            {
              id: 'thread',
              isResolved: resolved,
              path: 'a.ts',
              line: 1,
              viewerCanResolve: true,
              comments: {
                pageInfo: { hasNextPage: hasMoreComments },
                nodes: comments,
              },
            },
          ],
        },
      },
    },
  });
  return new ReviewThreadInventoryLoader({
    owner: 'owner',
    repo: 'repo',
    octokit: { graphql },
  } as unknown as GitHubClient);
}
describe('closed baseline observations', () => {
  const receipt = {
    lineageId,
    targetId,
    threadId: 'thread',
    markerFingerprint: lineageId,
    resolvedAt: '2026-10-22T01:00:00.000Z',
  };
  it('joins successful native publication receipts without requiring a fallback reply', async () => {
    const result = await loader([parent]).load(2, [prior], [receipt]);
    expect(result.resolvedObservations).toEqual([
      { lineageId, trustedMarker: lineageId, confirmed: true },
    ]);
    expect(result.candidates).toEqual([]);
    for (const invalid of [
      { ...receipt, targetId: 'other' },
      { ...receipt, threadId: 'other' },
      { ...receipt, markerFingerprint: 'b'.repeat(24) },
      { ...receipt, resolvedAt: '2026-10-21T00:00:00.000Z' },
    ]) {
      expect(
        (await loader([parent]).load(2, [prior], [invalid]))
          .resolvedObservations?.[0].confirmed
      ).toBe(false);
    }
    expect(
      (
        await loader([
          parent,
          {
            ...reply,
            author: { login: 'maintainer', __typename: 'User' },
            body: 'Still broken',
          },
        ]).load(2, [prior], [receipt])
      ).resolvedObservations?.[0].confirmed
    ).toBe(false);
    expect(
      (
        await loader([{ ...parent, updatedAt: '2026-10-22T02:00:00Z' }]).load(
          2,
          [prior],
          [receipt]
        )
      ).resolvedObservations?.[0].confirmed
    ).toBe(false);
  });
  it('observes only exact known trusted lineages and never queues closed threads for execution', async () => {
    const result = await loader([parent, reply]).load(2, [prior]);
    expect(result.resolvedObservations).toEqual([
      { lineageId, trustedMarker: lineageId, confirmed: true },
    ]);
    expect(result.candidates).toEqual([]);
    expect(result.manualAttention).toEqual([]);
    expect(result.dedupeComments).toEqual([]);
    expect(
      (
        await loader([parent, reply]).load(2, [
          { ...prior, lineageId: `rrl_${'b'.repeat(32)}` },
        ])
      ).resolvedObservations
    ).toEqual([]);
  });
  it.each([
    [parent],
    [parent, { ...reply, author: { login: 'untrusted', __typename: 'User' } }],
    [
      parent,
      reply,
      {
        ...reply,
        id: 'human',
        author: { login: 'maintainer', __typename: 'User' },
        body: 'This is still a bug.',
      },
    ],
    [{ ...parent, updatedAt: '2026-10-22T02:00:00Z' }, reply],
  ])(
    'requires real resolution evidence without human interaction or a later parent edit',
    async (...comments) => {
      const result = await loader(comments).load(2, [prior]);
      expect(result.resolvedObservations).toEqual([
        { lineageId, trustedMarker: lineageId, confirmed: false },
      ]);
    }
  );
  it('does not paginate unrelated closed threads for comparison', async () => {
    const result = await loader([parent], true, true).load(2, [
      { ...prior, lineageId: `rrl_${'b'.repeat(32)}` },
    ]);
    expect(result.failed).toBe(false);
    expect(result.resolvedObservations).toEqual([]);
  });
  it('ignores closed markers from untrusted parents', async () => {
    expect(
      (
        await loader([
          { ...parent, author: { login: 'maintainer', __typename: 'User' } },
          reply,
        ]).load(2, [prior])
      ).resolvedObservations
    ).toEqual([]);
  });
});
