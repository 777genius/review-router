import { encodeStructuredLifecycleRequest } from '../../../src/finding-revalidation/domain/packet';
import {
  AccountGatewayModelTransport,
  type GatewayTransportDiagnostic,
} from '../../../src/review-orchestration/infrastructure/account-gateway-model-transport';
import { PreparedModelDispatch } from '../../../src/review-orchestration/infrastructure/prepared-model-dispatch';

function controller(
  transport: 'account_gateway' | 'runner_local_responses' = 'account_gateway',
  fetchImpl?: typeof fetch,
  maxRequests = 2,
  nativeRetry = false
) {
  return new PreparedModelDispatch({
    apiUrl: 'https://control.example.invalid',
    fetchImpl,
    authorization: () => ({
      authorizationId: 'authorization',
      authorizationToken: 'synthetic-run-jwt',
    }),
    capability: {
      extensionId: 'review-model-dispatch.v2',
      version: 2,
      routeIdentityHash: 'a'.repeat(64),
      transport,
      wireProtocol: 'openai-responses',
      outputTokenLimit: 'upstream_request',
      providerIndex: 0,
      model: 'synthetic-model',
      deadline: new Date(Date.now() + 60_000).toISOString(),
      ...(maxRequests > 32 || nativeRetry
        ? { capacityPolicy: 'model-dispatch-policy.capacity128.v1' }
        : {}),
      ...(nativeRetry ? { retryPolicy: 'native-rejection-once.v1' } : {}),
      maxRequests,
      maxConcurrentRequests: 1,
      maxRequestBytes: 64_000,
      maxResponseBytes: 64_000,
      maxOutputTokens: 100,
    },
  });
}

const request = (fields: Record<string, unknown> = {}) =>
  Buffer.from(
    JSON.stringify({
      model: 'synthetic-model',
      stream: true,
      input: [{ role: 'user', content: 'synthetic discovery' }],
      ...fields,
    })
  );

it('normalizes Gateway discovery before claiming and preserves exact verifier bytes', () => {
  const structured = encodeStructuredLifecycleRequest({
    model: 'synthetic-model',
    instructions: 'Verify exact source',
    userText: '{"packetHash":"synthetic"}',
    outputCap: 100,
    maxRequestBytes: 64000,
  });
  expect(controller().normalizeResponsesRequest(structured)).toEqual(
    Buffer.from(structured)
  );

  const dispatch = controller();
  const normalized = dispatch.normalizeResponsesRequest(
    request({ reasoning: null, max_output_tokens: 999 })
  );
  expect(JSON.parse(normalized.toString())).toEqual({
    model: 'synthetic-model',
    stream: true,
    input: [{ role: 'user', content: 'synthetic discovery' }],
    store: false,
    service_tier: 'default',
    max_output_tokens: 100,
  });
  expect(dispatch.normalizeResponsesRequest(normalized)).toEqual(normalized);
  const verifier = request({
    reasoning: { effort: 'high' },
    store: false,
    service_tier: 'default',
    max_output_tokens: 50,
  });
  expect(dispatch.normalizeResponsesRequest(verifier)).toEqual(verifier);
});

it.each([
  { store: true },
  { store: null },
  { service_tier: 'priority' },
  { previous_response_id: 'another-conversation' },
  { previous_response_id: null },
])(
  'rejects forbidden Gateway state before reserving allowance: %j',
  (fields) => {
    expect(() =>
      controller().normalizeResponsesRequest(request(fields))
    ).toThrow('model_dispatch_route_mismatch');
  }
);

it('keeps direct-provider request policy independent of Gateway defaults', () => {
  const direct = controller('runner_local_responses');
  const normalized = direct.normalizeResponsesRequest(
    request({ reasoning: null })
  );
  expect(JSON.parse(normalized.toString())).toEqual({
    model: 'synthetic-model',
    stream: true,
    input: [{ role: 'user', content: 'synthetic discovery' }],
    reasoning: null,
    max_output_tokens: 100,
  });
});

const scope = {
  executionId: 'execution',
  workSlotId: 'slot',
  attemptOrdinal: 1,
  leaseId: 'lease',
  leaseCapability: 'synthetic-capability',
  fencingToken: '1',
  preparedManifestKey: 'manifest',
};

it.each([
  [400, 'model_dispatch_request_invalid'],
  [409, 'model_dispatch_budget_exhausted'],
] as const)(
  'retains only a finite claim refusal (%s)',
  async (status, code) => {
    const fetchImpl = jest.fn(async () => Response.json({ code }, { status }));
    const dispatch = controller('account_gateway', fetchImpl);
    dispatch.beginInvocation(() => scope);
    await expect(
      dispatch.reserve(
        request({ max_output_tokens: 100 }),
        new AbortController().signal
      )
    ).rejects.toMatchObject({
      code,
      httpStatus: status,
      source: 'api_denial',
      message: code,
    });
    await expect(
      dispatch.reserve(
        request({ max_output_tokens: 100 }),
        new AbortController().signal
      )
    ).rejects.toThrow('model_dispatch_fenced');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  }
);

it.each([
  '{"code":"PRIVATE_SECRET"}',
  '{"code":"model_dispatch_request_invalid","secret":"PRIVATE_SECRET"}',
  '{invalid PRIVATE_SECRET',
  'PRIVATE_SECRET'.repeat(1000),
])(
  'suppresses malformed, unknown, additional and oversized refusal data',
  async (body) => {
    const dispatch = controller(
      'account_gateway',
      async () =>
        new Response(body, {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
    );
    dispatch.beginInvocation(() => scope);
    await expect(
      dispatch.reserve(
        request({ max_output_tokens: 100 }),
        new AbortController().signal
      )
    ).rejects.toThrow('model_dispatch_claim_unavailable');
  }
);

it.each([32, 128])(
  'keeps successful claims/settlements unchanged, then enforces frozen ordinal bound %s',
  async (limit) => {
    let claim: Record<string, unknown> = {};
    const fetchImpl = jest.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (String(url).endsWith('/claim')) {
          claim = body;
          return Response.json({
            status: 'claimed',
            receiptToken: 'b'.repeat(64),
            notAfter: new Date(Date.now() + 30_000).toISOString(),
            dispatch: {
              ...claim,
              authorizationId: 'authorization',
              state: 'dispatch_may_have_started',
            },
          });
        }
        return Response.json({
          dispatch: {
            ...claim,
            authorizationId: 'authorization',
            state: body.state,
          },
        });
      }
    );
    const dispatch = controller('account_gateway', fetchImpl, limit);
    dispatch.beginInvocation(() => scope);
    for (let i = 1; i <= limit; i++) {
      const ticket = await dispatch.reserve(
        request({ max_output_tokens: 100 }),
        new AbortController().signal
      );
      expect(ticket.claim.requestOrdinal).toBe(i);
      // Positively unpaid reservations still consume the immutable allowance.
      await ticket.failed();
    }
    expect(fetchImpl).toHaveBeenCalledTimes(limit * 2);
    await expect(
      dispatch.reserve(
        request({ max_output_tokens: 100 }),
        new AbortController().signal
      )
    ).rejects.toMatchObject({
      code: 'model_dispatch_budget_exhausted',
      source: 'local_bound',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(limit * 2);
    await expect(
      dispatch.reserve(
        request({ max_output_tokens: 100 }),
        new AbortController().signal
      )
    ).rejects.toThrow('model_dispatch_fenced');
  }
);

it('never replays a restored reservation', async () => {
  const fetchImpl = jest.fn(async () => Response.json({ status: 'restored' }));
  const dispatch = controller('account_gateway', fetchImpl);
  dispatch.beginInvocation(() => scope);
  await expect(
    dispatch.reserve(
      request({ max_output_tokens: 100 }),
      new AbortController().signal
    )
  ).rejects.toThrow('model_dispatch_claim_unavailable');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it.each([32, 128])(
  'routes frozen cap %s into the existing Gateway adapter, distinguishing claim denial without lifting fences',
  async (limit) => {
    const fetchImpl = jest.fn(async () =>
      Response.json(
        { code: 'model_dispatch_budget_exhausted' },
        { status: 409 }
      )
    );
    const dispatch = controller('account_gateway', fetchImpl, limit);
    const diagnostics: GatewayTransportDiagnostic[] = [];
    const transport = new AccountGatewayModelTransport(
      'https://control.example.invalid',
      () => 'synthetic-run-jwt',
      (diagnostic) => {
        diagnostics.push(diagnostic);
      }
    );
    transport.setModelDispatch(dispatch);
    transport.beginInvocation(() => scope);
    await expect(transport.responses(request())).rejects.toMatchObject({
      code: 'model_dispatch_budget_exhausted',
      source: 'api_denial',
    });
    // The refused claim never left the runner: a known stop, not an unknown
    // effect. Inference stays fenced below; nothing is released.
    expect(transport.lastFailure).toEqual({
      code: 'model_dispatch_budget_exhausted',
      effect: 'not_dispatched',
    });
    expect(diagnostics).toEqual([
      expect.objectContaining({
        stage: 'model_dispatch_claim',
        responseReceived: true,
        httpStatus: 409,
      }),
    ]);
    expect(transport.releaseRetrySafeFailure()).toBe(false);
    expect(transport.reopenConsumer()).toBe(false);
    await expect(transport.responses(request())).rejects.toThrow(
      'account_gateway_inference_denied'
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  }
);

it('never clears an earlier forwarded unknown effect to claim another request', async () => {
  let claim: Record<string, unknown> = {};
  const fetchImpl = jest.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (String(url).endsWith('/claim')) {
        claim = body;
        return Response.json({
          status: 'claimed',
          receiptToken: 'b'.repeat(64),
          notAfter: new Date(Date.now() + 30_000).toISOString(),
          dispatch: {
            ...claim,
            authorizationId: 'authorization',
            state: 'dispatch_may_have_started',
          },
        });
      }
      return Response.json({
        dispatch: {
          ...claim,
          authorizationId: 'authorization',
          state: body.state,
        },
      });
    }
  );
  const dispatch = controller('account_gateway', fetchImpl);
  dispatch.beginInvocation(() => scope);
  const ticket = await dispatch.reserve(
    request({ max_output_tokens: 100 }),
    new AbortController().signal
  );
  ticket.forwarded();
  await ticket.failed();
  expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body)).state).toBe(
    'effect_unknown'
  );
  await expect(
    dispatch.reserve(
      request({ max_output_tokens: 100 }),
      new AbortController().signal
    )
  ).rejects.toThrow('model_dispatch_fenced');
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

function nativeRetryFixture(
  options: {
    enabled?: boolean;
    maxRequests?: number;
    loseAcknowledgement?: boolean;
    afterProof?: () => void;
    alterReadback?: (value: Record<string, unknown>) => Record<string, unknown>;
  } = {}
) {
  const claims: Record<string, unknown>[] = [];
  const settlements: Record<string, unknown>[] = [];
  let proofReads = 0;
  let currentScope = { ...scope };
  const fetchImpl = jest.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/claim')) {
        const claim = JSON.parse(String(init?.body)) as Record<string, unknown>;
        claims.push(claim);
        return Response.json({
          status: 'claimed',
          receiptToken: 'b'.repeat(64),
          notAfter: new Date(Date.now() + 30_000).toISOString(),
          dispatch: {
            ...claim,
            authorizationId: 'authorization',
            role: 'finding_discovery',
            nativeRequestRef: `native-${claims.length}`,
            state: 'dispatch_may_have_started',
          },
        });
      }
      const settlement =
        init?.method === 'GET'
          ? settlements[settlements.length - 1]!
          : (JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (init?.method === 'GET') proofReads++;
      else settlements.push(settlement);
      const nativeProof = settlement.proof === 'native_rejection_after_forward';
      let readback: Record<string, unknown> = {
        ...claims[claims.length - 1],
        authorizationId: 'authorization',
        role: 'finding_discovery',
        nativeRequestRef: `native-${claims.length}`,
        state: settlement.state,
        ...(nativeProof
          ? {
              nativeRetryProof: {
                kind: 'native_rejection_after_forward',
                reason: 'admission_storage_conflict',
              },
            }
          : {}),
      };
      if (nativeProof) {
        options.afterProof?.();
        readback = options.alterReadback?.(readback) ?? readback;
        if (options.loseAcknowledgement && init?.method !== 'GET')
          throw new Error('synthetic_lost_settlement_acknowledgement');
      }
      return Response.json({ dispatch: readback });
    }
  );
  const dispatch = controller(
    'account_gateway',
    fetchImpl,
    options.maxRequests ?? 3,
    options.enabled !== false
  );
  dispatch.beginInvocation(() => currentScope);
  return {
    dispatch,
    claims,
    settlements,
    fetchImpl,
    proofReads: () => proofReads,
    replaceScope: (next: typeof scope) => {
      currentScope = next;
    },
  };
}

it.each([false, true])(
  'spends one fresh identical successor after exact native proof (lost ACK: %s)',
  async (loseAcknowledgement) => {
    const f = nativeRetryFixture({
      loseAcknowledgement,
      afterProof: () =>
        f.replaceScope({ ...scope, leaseCapability: 'refreshed-capability' }),
    });
    const bytes = request({ max_output_tokens: 100 });
    const signal = new AbortController().signal;
    const ticket = await f.dispatch.reserve(bytes, signal);
    ticket.forwarded();
    bytes.fill(0); // Retry uses the original captured bytes, never mutable input.
    const next = await ticket.retryAfterNativeRejection('native-1', signal);
    expect(next).not.toBeNull();
    expect(f.claims).toHaveLength(2);
    expect(f.claims[1]).toMatchObject({
      requestOrdinal: 2,
      retryOfDispatchId: f.claims[0]!.dispatchId,
      providerRequestEnvelopeHash: f.claims[0]!.providerRequestEnvelopeHash,
      requestBytes: f.claims[0]!.requestBytes,
      maxOutputTokens: 100,
      leaseId: f.claims[0]!.leaseId,
      fencingToken: f.claims[0]!.fencingToken,
      leaseCapability: 'refreshed-capability',
    });
    expect(f.claims[1]!.dispatchId).not.toBe(f.claims[0]!.dispatchId);
    expect(f.proofReads()).toBe(loseAcknowledgement ? 1 : 0);
    expect(f.settlements).toEqual([
      {
        state: 'not_dispatched',
        proof: 'native_rejection_after_forward',
      },
    ]);
    next!.forwarded();
    await expect(
      next!.retryAfterNativeRejection('native-2', signal)
    ).resolves.toBeNull();
    await next!.failed();
    expect(f.claims).toHaveLength(2);
    expect(f.settlements[1]).toEqual({ state: 'effect_unknown' });
    await expect(
      f.dispatch.reserve(request({ max_output_tokens: 100 }), signal)
    ).rejects.toThrow('model_dispatch_fenced');
  }
);

it.each([
  ['nativeRequestRef', 'foreign-request'],
  ['authorizationId', 'foreign-authorization'],
  ['providerRequestEnvelopeHash', '0'.repeat(64)],
  ['routeIdentityHash', '0'.repeat(64)],
  ['leaseId', 'foreign-lease'],
  ['fencingToken', '2'],
  ['retryOfDispatchId', 'foreign-predecessor'],
  ['role', 'lifecycle_verification'],
  ['state', 'effect_unknown'],
  ['nativeRetryProof', null],
  [
    'nativeRetryProof',
    { kind: 'native_rejection_after_forward', reason: 'other' },
  ],
  [
    'nativeRetryProof',
    {
      kind: 'native_rejection_after_forward',
      reason: 'admission_storage_conflict',
      extra: true,
    },
  ],
] as const)(
  'fences mismatched or unconfirmed native retry %s',
  async (field, value) => {
    const f = nativeRetryFixture({
      alterReadback: (row) => ({ ...row, [field]: value }),
    });
    const signal = new AbortController().signal;
    const ticket = await f.dispatch.reserve(
      request({ max_output_tokens: 100 }),
      signal
    );
    ticket.forwarded();
    await expect(
      ticket.retryAfterNativeRejection('native-1', signal)
    ).rejects.toThrow('model_dispatch_settlement_unconfirmed');
    expect(f.claims).toHaveLength(1);
    await expect(
      f.dispatch.reserve(request({ max_output_tokens: 100 }), signal)
    ).rejects.toThrow('model_dispatch_fenced');
  }
);

it.each(['legacy', 'auxiliary', 'budget'] as const)(
  'does not query native proof or replenish allowance for %s requests',
  async (kind) => {
    const f = nativeRetryFixture({
      enabled: kind !== 'legacy',
      maxRequests: kind === 'budget' ? 1 : 3,
    });
    const signal = new AbortController().signal;
    const ticket = await f.dispatch.reserve(
      request({ max_output_tokens: 100 }),
      signal,
      kind === 'auxiliary' ? scope : undefined
    );
    ticket.forwarded();
    await expect(
      ticket.retryAfterNativeRejection('native-1', signal)
    ).resolves.toBeNull();
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    await ticket.failed();
    expect(f.claims).toHaveLength(1);
    expect(f.settlements).toEqual([{ state: 'effect_unknown' }]);
  }
);

it('rejects a native reference changed in both the rejection header and readback', async () => {
  const f = nativeRetryFixture({
    alterReadback: (row) => ({
      ...row,
      nativeRequestRef: 'foreign-native-request',
    }),
  });
  const signal = new AbortController().signal;
  const ticket = await f.dispatch.reserve(
    request({ max_output_tokens: 100 }),
    signal
  );
  ticket.forwarded();
  await expect(
    ticket.retryAfterNativeRejection('foreign-native-request', signal)
  ).rejects.toThrow('model_dispatch_settlement_unconfirmed');
  expect(f.claims).toHaveLength(1);
});

it('keeps the single-request gate during retry delay and refuses changed lease authority', async () => {
  let proofObserved!: () => void;
  const proof = new Promise<void>((resolve) => {
    proofObserved = resolve;
  });
  const f = nativeRetryFixture({ afterProof: proofObserved });
  const signal = new AbortController().signal;
  const ticket = await f.dispatch.reserve(
    request({ max_output_tokens: 100 }),
    signal
  );
  ticket.forwarded();
  const retry = ticket.retryAfterNativeRejection('native-1', signal);
  await proof;
  await expect(
    f.dispatch.reserve(request({ max_output_tokens: 100 }), signal)
  ).rejects.toThrow('model_dispatch_fenced');
  f.replaceScope({ ...scope, leaseId: 'different-lease' });
  await expect(retry).rejects.toThrow('model_dispatch_authority_changed');
  expect(f.claims).toHaveLength(1);
});

it('never claims a successor after cancellation during proof settlement', async () => {
  const abort = new AbortController();
  const reason = new Error('synthetic_cancelled');
  const f = nativeRetryFixture({ afterProof: () => abort.abort(reason) });
  const ticket = await f.dispatch.reserve(
    request({ max_output_tokens: 100 }),
    abort.signal
  );
  ticket.forwarded();
  await expect(
    ticket.retryAfterNativeRejection('native-1', abort.signal)
  ).rejects.toBe(reason);
  expect(f.claims).toHaveLength(1);
});

it('does not extend the original deadline after proof settlement', async () => {
  const now = Date.now();
  let clock: jest.SpyInstance | undefined;
  const f = nativeRetryFixture({
    afterProof: () => {
      clock = jest.spyOn(Date, 'now').mockReturnValue(now + 60_000);
    },
  });
  const signal = new AbortController().signal;
  try {
    const ticket = await f.dispatch.reserve(
      request({ max_output_tokens: 100 }),
      signal
    );
    ticket.forwarded();
    await expect(
      ticket.retryAfterNativeRejection('native-1', signal)
    ).rejects.toThrow('model_dispatch_deadline');
    expect(f.claims).toHaveLength(1);
  } finally {
    clock?.mockRestore();
  }
});

it.each(['cancellation', 'deadline'] as const)(
  'does not claim after %s occurs during the retry pause',
  async (stop) => {
    const abort = new AbortController();
    const reason = new Error('synthetic_cancelled_during_pause');
    const now = Date.now();
    let clock: jest.SpyInstance | undefined;
    let pending: ReturnType<typeof setImmediate> | undefined;
    const f = nativeRetryFixture({
      afterProof: () => {
        pending = setImmediate(() => {
          if (stop === 'cancellation') abort.abort(reason);
          else clock = jest.spyOn(Date, 'now').mockReturnValue(now + 60_000);
        });
      },
    });
    try {
      const ticket = await f.dispatch.reserve(
        request({ max_output_tokens: 100 }),
        abort.signal
      );
      ticket.forwarded();
      const retry = ticket.retryAfterNativeRejection('native-1', abort.signal);
      if (stop === 'cancellation') {
        await expect(retry).rejects.toMatchObject({
          code: 'ABORT_ERR',
          cause: reason,
        });
      } else {
        await expect(retry).rejects.toThrow('model_dispatch_deadline');
      }
      expect(f.claims).toHaveLength(1);
    } finally {
      if (pending) clearImmediate(pending);
      clock?.mockRestore();
    }
  }
);
