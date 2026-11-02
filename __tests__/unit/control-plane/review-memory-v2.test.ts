import { createHash } from 'crypto';
import {
  freezeReviewMemorySnapshot,
  parseReviewMemoryBundle,
  ReviewMemorySession,
  REVIEW_MEMORY_V2,
  memorySnapshotForTask,
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
  it('preserves each derived historical source commit/time without changing the recorded observation', () => {
    const bundle = reviewMemoryBundle();
    const sourceObservations = [
      {
        entryId: 'auto_source_one',
        observedCommitSha: 'a'.repeat(40),
        statementAt: '2026-01-01T00:00:00Z',
      },
    ];
    const snapshot = freezeReviewMemorySnapshot({
      ...bundle,
      items: [
        {
          ...bundle.items[2],
          temporalStatus: 'historical',
          sourceObservations,
        },
      ],
    });
    expect(snapshot.bundle.items[0]?.sourceObservations).toEqual(
      sourceObservations
    );
    expect(snapshot.renderedPrompt).toContain(
      '"sourceObservations":[{"entryId":"auto_source_one","observedCommitSha":"' +
        'a'.repeat(40) +
        '","statementAt":"2026-01-01T00:00:00Z"}]'
    );
  });

  it('binds server audience/task authority once while preserving historical snapshot identities', () => {
    const legacy = freezeReviewMemorySnapshot(reviewMemoryBundle());
    expect(memorySnapshotForTask(legacy, 'investigation')).toBeNull();
    expect(memorySnapshotForTask(legacy, 'pr_description')).toBeNull();
    const qualified = freezeReviewMemorySnapshot(
      reviewMemoryBundle({
        contextPolicy: {
          audience: 'public',
          repositoryId: 'repository-1',
          allowedTasks: ['review', 'investigation', 'pr_description'],
        },
      })
    );
    expect(qualified.hash).not.toBe(legacy.hash);
    expect(qualified.renderedPrompt).toBe(legacy.renderedPrompt);
    expect(memorySnapshotForTask(qualified, 'investigation')).toBe(qualified);
    expect(memorySnapshotForTask(qualified, 'pr_description')).toBe(qualified);
    expect(JSON.parse(qualified.hashPreimage).contextPolicy).toEqual(
      qualified.bundle.contextPolicy
    );
  });
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

  it('permanently discards a captured snapshot without another retrieval', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(json(reviewMemoryBundle()));
    const session = await ReviewMemorySession.capture({
      apiUrl: 'https://fixture.invalid',
      authorizationToken: 'execution-token',
      binding: reviewMemoryBinding,
      enabled: true,
      pr,
      fetchImpl,
    });
    const hash = session.current()!.hash;
    session.discard();
    expect(session.current()).toBeNull();
    expect(await session.isEligible(hash)).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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
    });
    expect(String(init.body)).not.toContain('RAW');
    expect(String(init.body)).not.toContain(pr.title);
    expect(String(init.body)).not.toContain('safeRetrievalQuery');
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

  it('admits a delayed valid response beyond 500ms and deduplicates concurrent checks without changing the frozen input', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(json(reviewMemoryBundle()))
      .mockImplementation(
        () =>
          new Promise<Response>((resolve) =>
            setTimeout(
              () => resolve(json({ protocolVersion: 2, eligible: true })),
              650
            )
          )
      );
    const warn = jest.fn();
    const session = await ReviewMemorySession.capture({
      apiUrl: 'https://fixture.invalid',
      authorizationToken: 'token',
      binding: reviewMemoryBinding,
      enabled: true,
      pr,
      fetchImpl,
      warn,
    });
    const snapshot = session.current()!;
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    try {
      const first = session.isEligible(snapshot.hash);
      const second = session.isEligible(snapshot.hash);
      let settled = false;
      void first.then(() => {
        settled = true;
      });
      await jest.advanceTimersByTimeAsync(501);
      expect(settled).toBe(false);
      expect(session.current()).toBe(snapshot);
      await jest.advanceTimersByTimeAsync(149);
      await expect(first).resolves.toBe(true);
      await expect(second).resolves.toBe(true);
      expect(session.current()).toBe(snapshot);
      expect(session.current()!.hashPreimage).toBe(snapshot.hashPreimage);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('enforces the two-second admission transport deadline even when fetch ignores cancellation, then never refetches', async () => {
    let transportSignal: AbortSignal | undefined;
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(json(reviewMemoryBundle()))
      .mockImplementation((_url, init: RequestInit) => {
        transportSignal = init.signal ?? undefined;
        return new Promise<Response>(() => {});
      });
    const warn = jest.fn();
    const session = await ReviewMemorySession.capture({
      apiUrl: 'https://fixture.invalid',
      authorizationToken: 'token',
      binding: reviewMemoryBinding,
      enabled: true,
      pr,
      fetchImpl,
      warn,
    });
    const snapshot = session.current()!;
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    try {
      const admission = session.isEligible(snapshot.hash);
      let settled = false;
      void admission.then(() => {
        settled = true;
      });
      await jest.advanceTimersByTimeAsync(1999);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await expect(admission).resolves.toBe(false);
      expect(transportSignal?.aborted).toBe(true);
      expect(session.current()).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        `ReviewRouter memory admission unavailable: ${JSON.stringify({
          cause: 'timeout',
          elapsedMs: 2000,
          snapshotHashPrefix: snapshot.hash.slice(0, 12),
        })}`
      );
      expect(await session.isEligible(snapshot.hash)).toBe(false);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('propagates admission cancellation even when the diagnostic sink throws, without logging the abort reason', async () => {
    const abort = new AbortController();
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(json(reviewMemoryBundle()))
      .mockImplementation(() => {
        abort.abort(new Error('secret-parent-abort'));
        return new Promise<Response>(() => {});
      });
    const warn = jest.fn((_message: string) => {
      throw new Error('secret-sink-error');
    });
    const session = await ReviewMemorySession.capture({
      apiUrl: 'https://fixture.invalid/secret-api-url',
      authorizationToken: 'secret-token',
      binding: reviewMemoryBinding,
      enabled: true,
      pr,
      signal: abort.signal,
      fetchImpl,
      warn,
    });
    const snapshot = session.current()!;
    await expect(session.isEligible(snapshot.hash)).rejects.toThrow(
      'secret-parent-abort'
    );
    expect(session.current()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('"cause":"parent_aborted"');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
  });

  it.each([
    ['server_ineligible', () => json({ protocolVersion: 2, eligible: false })],
    ['http_rejected', () => new Response('secret-response', { status: 503 })],
    [
      'response_content_type_invalid',
      () =>
        new Response('secret-response', {
          headers: { 'content-type': 'text/html' },
        }),
    ],
    [
      'response_body_missing',
      () =>
        new Response(null, { headers: { 'content-type': 'application/json' } }),
    ],
    [
      'response_size_invalid',
      () =>
        new Response('secret-response', {
          headers: {
            'content-type': 'application/json',
            'content-length': String(REVIEW_MEMORY_V2.responseMaxBytes + 1),
          },
        }),
    ],
    [
      'response_size_invalid',
      () =>
        new Response('x'.repeat(REVIEW_MEMORY_V2.responseMaxBytes + 1), {
          headers: { 'content-type': 'application/json' },
        }),
    ],
    [
      'response_json_invalid',
      () =>
        new Response('{"secret-response":', {
          headers: { 'content-type': 'application/json' },
        }),
    ],
    [
      'response_schema_invalid',
      () => json({ protocolVersion: 2, eligible: 'secret-response' }),
    ],
    ['response_schema_invalid', () => json(null)],
    [
      'response_schema_invalid',
      () => json({ protocolVersion: '2', eligible: true }),
    ],
    [
      'transport_failed',
      () => {
        throw Object.assign(new Error('secret-error'), {
          code: 'secret-code',
          cause: new Error('secret-cause'),
        });
      },
    ],
  ] as const)(
    'drops %s admission with only closed diagnostics and no retry',
    async (cause, response) => {
      const fetchImpl = jest
        .fn()
        .mockResolvedValueOnce(json(reviewMemoryBundle()))
        .mockImplementation(response);
      const warn = jest.fn();
      const session = await ReviewMemorySession.capture({
        apiUrl: 'https://fixture.invalid/secret-api-url',
        authorizationToken: 'secret-token',
        binding: reviewMemoryBinding,
        enabled: true,
        pr,
        fetchImpl,
        warn,
      });
      const snapshot = session.current()!;
      expect(await session.isEligible(snapshot.hash)).toBe(false);
      expect(session.current()).toBeNull();
      const prefix = 'ReviewRouter memory admission unavailable: ';
      const diagnostic = JSON.parse(
        String(warn.mock.calls[0]?.[0]).slice(prefix.length)
      );
      expect(diagnostic).toEqual({
        cause,
        elapsedMs: expect.any(Number),
        snapshotHashPrefix: snapshot.hash.slice(0, 12),
      });
      expect(diagnostic.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
      expect(JSON.stringify(warn.mock.calls)).not.toContain(snapshot.hash);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(
        snapshot.bundle.items[0]!.body
      );
      expect(await session.isEligible(snapshot.hash)).toBe(false);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    }
  );

  it('does not let a throwing diagnostic sink change a server denial', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(json(reviewMemoryBundle()))
      .mockResolvedValue(json({ protocolVersion: 2, eligible: false }));
    const session = await ReviewMemorySession.capture({
      apiUrl: 'https://fixture.invalid',
      authorizationToken: 'token',
      binding: reviewMemoryBinding,
      enabled: true,
      pr,
      fetchImpl,
      warn: () => {
        throw new Error('private-sink-error');
      },
    });
    const snapshot = session.current()!;
    expect(await session.isEligible(snapshot.hash)).toBe(false);
    expect(await session.isEligible(snapshot.hash)).toBe(false);
    expect(session.current()).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects a valid admission response if the unchanged frozen snapshot expires while waiting', async () => {
    const bundle = reviewMemoryBundle({
      expiresAt: new Date(Date.now() + 1000).toISOString(),
    });
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(json(bundle))
      .mockImplementation(
        () =>
          new Promise<Response>((resolve) =>
            setTimeout(
              () => resolve(json({ protocolVersion: 2, eligible: true })),
              1500
            )
          )
      );
    const warn = jest.fn();
    const session = await ReviewMemorySession.capture({
      apiUrl: 'https://fixture.invalid',
      authorizationToken: 'token',
      binding: reviewMemoryBinding,
      enabled: true,
      pr,
      fetchImpl,
      warn,
    });
    const snapshot = session.current()!;
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    try {
      const admission = session.isEligible(snapshot.hash);
      await jest.advanceTimersByTimeAsync(1500);
      await expect(admission).resolves.toBe(false);
      expect(session.current()).toBeNull();
      expect(snapshot.bundle.expiresAt).toBe(bundle.expiresAt);
      expect(warn.mock.calls[0]?.[0]).toContain('"cause":"snapshot_expired"');
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('never logs a caller-supplied hash or fetches under a mismatched snapshot', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(json(reviewMemoryBundle()));
    const warn = jest.fn();
    const session = await ReviewMemorySession.capture({
      apiUrl: 'https://fixture.invalid',
      authorizationToken: 'token',
      binding: reviewMemoryBinding,
      enabled: true,
      pr,
      fetchImpl,
      warn,
    });
    const snapshot = session.current()!;
    expect(await session.isEligible('secret-caller-hash')).toBe(false);
    expect(session.current()).toBe(snapshot);
    session.discard();
    expect(await session.isEligible('secret-caller-hash')).toBe(false);
    expect(warn.mock.calls[0]?.[0]).toContain(
      '"cause":"snapshot_hash_mismatch"'
    );
    expect(warn.mock.calls[1]?.[0]).not.toContain('snapshotHashPrefix');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('never revives a snapshot discarded while its successful admission is in flight', async () => {
    let respond!: (response: Response) => void;
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(json(reviewMemoryBundle()))
      .mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            respond = resolve;
          })
      );
    const warn = jest.fn();
    const session = await ReviewMemorySession.capture({
      apiUrl: 'https://fixture.invalid',
      authorizationToken: 'token',
      binding: reviewMemoryBinding,
      enabled: true,
      pr,
      fetchImpl,
      warn,
    });
    const snapshot = session.current()!;
    const admission = session.isEligible(snapshot.hash);
    session.discard();
    respond(json({ protocolVersion: 2, eligible: true }));
    await expect(admission).resolves.toBe(false);
    expect(session.current()).toBeNull();
    expect(warn.mock.calls[0]?.[0]).toContain('"cause":"snapshot_changed"');
    expect(await session.isEligible(snapshot.hash)).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

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
