import { createHash } from 'crypto';
import {
  freezeReviewMemorySnapshot,
  parseReviewMemoryBundle,
  ReviewMemorySession,
  REVIEW_MEMORY_V2,
} from '../../../src/control-plane/review-memory-v2';
import {
  reviewMemoryBinding,
  reviewMemoryBundle,
} from '../../helpers/review-memory-v2-fixture';
import type { PRContext } from '../../../src/types';

const pr: PRContext = {
  number: 7,
  title: 'Bound outgoing calls',
  body: 'RAW BODY MUST NOT BE SENT',
  author: 'author',
  draft: false,
  labels: ['api'],
  files: [],
  diff: 'RAW DIFF MUST NOT BE SENT',
  additions: 0,
  deletions: 0,
  baseSha: reviewMemoryBinding.baseSha,
  headSha: reviewMemoryBinding.headSha,
};
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });

describe('T0 memory companion v2', () => {
  it('labels derived observations as historical without inventing a shared commit', () => {
    const observed = reviewMemoryBundle().items[2];
    const snapshot = freezeReviewMemorySnapshot(
      reviewMemoryBundle({
        items: [
          {
            ...observed,
            temporalStatus: 'historical',
            observedCommitSha: undefined,
            sourceIds: ['source-one', 'source-two'],
          },
        ],
      })
    );
    expect(snapshot.renderedPrompt).toContain('"temporalStatus":"historical"');
    expect(snapshot.renderedPrompt).not.toContain('observedCommitSha');
    expect(snapshot.renderedPrompt).toContain('HISTORICAL CONTEXT');
  });

  it('binds the execution token and exact review revision, reads once and freezes the actual rendered snapshot', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(json(reviewMemoryBundle()))
      .mockImplementation(async () =>
        json({ protocolVersion: 2, eligible: true })
      );
    const session = await ReviewMemorySession.capture({
      apiUrl: 'https://fixture.invalid',
      authorizationToken: 'execution-token',
      binding: reviewMemoryBinding,
      enabled: true,
      pr,
      fetchImpl,
    });
    const snapshot = session.current()!;
    expect(snapshot.hash).toBe(
      createHash('sha256').update(snapshot.hashPreimage).digest('hex')
    );
    expect(Object.isFrozen(snapshot.bundle.items[0])).toBe(true);
    expect(snapshot.renderedPrompt).toContain('APPROVED INTENDED RULES');
    expect(snapshot.renderedPrompt).toContain('EXPLICIT SCOPED EXCEPTIONS');
    expect(snapshot.renderedPrompt).toContain('AT-COMMIT OBSERVATIONS');
    expect(snapshot.renderedPrompt).toContain(
      'Existing code alone does not repeal an intended rule'
    );
    expect(snapshot.renderedPrompt).not.toContain(
      'Current code, explicit reviewer requests'
    );
    expect(await session.isEligible(snapshot.hash)).toBe(true);
    expect(await session.isEligible(snapshot.hash)).toBe(true);
    expect(session.current()).toBe(snapshot);
    expect(
      fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/bundle'))
    ).toHaveLength(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe(
      'https://fixture.invalid/api/action/v2/memory/bundle'
    );
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      cache: 'no-store',
      headers: { authorization: 'Bearer execution-token' },
    });
    expect(JSON.parse(String(init.body))).toEqual({
      protocolVersion: 2,
      ...reviewMemoryBinding,
      safeRetrievalQuery: 'Bound outgoing calls api',
    });
    expect(String(init.body)).not.toContain('RAW');
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1].body))).toMatchObject({
      bundleId: snapshot.bundle.bundleId,
      eligibilityEpoch: '17',
      providerGeneration: snapshot.bundle.providerGeneration,
    });
  });

  it.each([
    'disabled',
    'outage',
    'wrong binding',
    'legacy response',
    'oversized',
    'expired',
  ])('continues without memory for %s', async (failure) => {
    const value =
      failure === 'wrong binding'
        ? reviewMemoryBundle({ headSha: 'd'.repeat(40) })
        : failure === 'legacy response'
          ? { protocolVersion: 1, memoryVersion: 1, items: [] }
          : failure === 'expired'
            ? reviewMemoryBundle({ expiresAt: '2000-01-01T00:00:00.000Z' })
            : reviewMemoryBundle();
    const fetchImpl = jest.fn().mockImplementation(async () => {
      if (failure === 'outage') throw new Error('secret provider diagnostic');
      if (failure === 'oversized')
        return new Response('x', {
          headers: {
            'content-type': 'application/json',
            'content-length': String(REVIEW_MEMORY_V2.responseMaxBytes + 1),
          },
        });
      return json(value);
    });
    const warn = jest.fn();
    const session = await ReviewMemorySession.capture({
      apiUrl: 'https://fixture.invalid',
      authorizationToken: 'token',
      binding: reviewMemoryBinding,
      enabled: failure !== 'disabled',
      pr,
      fetchImpl,
      warn,
    });
    expect(session.current()).toBeNull();
    expect(await session.isEligible(null)).toBe(true);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
    if (failure === 'disabled') expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('bounds a transport that ignores cancellation and cancels its signal', async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl = jest.fn().mockImplementation((_url, init) => {
      signal = init.signal;
      return new Promise(() => {});
    });
    const session = await ReviewMemorySession.capture({
      apiUrl: 'https://fixture.invalid',
      authorizationToken: 'token',
      binding: reviewMemoryBinding,
      enabled: true,
      timeoutMs: 15,
      pr,
      fetchImpl,
    });
    expect(session.current()).toBeNull();
    expect(signal?.aborted).toBe(true);
  });

  it('preserves parent review cancellation instead of silently continuing the review', async () => {
    const abort = new AbortController();
    const fetchImpl = jest.fn().mockImplementation(() => {
      abort.abort(new Error('review_cancelled'));
      return new Promise(() => {});
    });
    await expect(
      ReviewMemorySession.capture({
        apiUrl: 'https://fixture.invalid',
        authorizationToken: 'token',
        binding: reviewMemoryBinding,
        enabled: true,
        pr,
        signal: abort.signal,
        fetchImpl,
      })
    ).rejects.toThrow('review_cancelled');
  });

  it.each([false, 'unavailable'])(
    'permanently drops revoked/unavailable admission (%s), without refetching text',
    async (eligible) => {
      const fetchImpl = jest
        .fn()
        .mockResolvedValueOnce(json(reviewMemoryBundle()))
        .mockImplementation(async () => {
          if (eligible === 'unavailable')
            throw new Error('private engine failure');
          return json({ protocolVersion: 2, eligible });
        });
      const session = await ReviewMemorySession.capture({
        apiUrl: 'https://fixture.invalid',
        authorizationToken: 'token',
        binding: reviewMemoryBinding,
        enabled: true,
        pr,
        fetchImpl,
      });
      const snapshot = session.current()!;
      expect(await session.isEligible(snapshot.hash)).toBe(false);
      expect(await session.isEligible(snapshot.hash)).toBe(false);
      expect(session.current()).toBeNull();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    }
  );

  it('changes identity when the used text, rule target, policy or provider generation changes', () => {
    const original = freezeReviewMemorySnapshot(reviewMemoryBundle());
    for (const bundle of [
      reviewMemoryBundle({ policyVersion: 'next-policy' }),
      reviewMemoryBundle({ providerGeneration: 'next-generation' }),
      reviewMemoryBundle({
        items: reviewMemoryBundle().items.map((item) =>
          item.id === 'mem_rule'
            ? { ...item, body: 'Changed intended rule.' }
            : item
        ),
      }),
      reviewMemoryBundle({
        items: reviewMemoryBundle().items.map((item) =>
          item.kind === 'exception'
            ? { ...item, exceptionRuleId: 'another-rule' }
            : item
        ),
      }),
    ])
      expect(freezeReviewMemorySnapshot(bundle).hash).not.toBe(original.hash);
  });

  it('rejects incomplete evidence and malformed authority sections rather than accepting a partial bundle', () => {
    for (const item of [
      { ...reviewMemoryBundle().items[0], sourceIds: [] },
      { ...reviewMemoryBundle().items[0], scope: 'user_prefs' },
      { ...reviewMemoryBundle().items[1], exceptionRuleId: undefined },
      { ...reviewMemoryBundle().items[2], observedCommitSha: undefined },
    ])
      expect(() =>
        parseReviewMemoryBundle(
          { ...reviewMemoryBundle(), items: [item] },
          reviewMemoryBinding
        )
      ).toThrow();
  });
});
