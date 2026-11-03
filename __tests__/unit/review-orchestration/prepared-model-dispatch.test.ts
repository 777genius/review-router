import {
  AccountGatewayModelTransport,
  type GatewayTransportDiagnostic,
} from '../../../src/review-orchestration/infrastructure/account-gateway-model-transport';
import { PreparedModelDispatch } from '../../../src/review-orchestration/infrastructure/prepared-model-dispatch';

function controller(
  transport: 'account_gateway' | 'runner_local_responses' = 'account_gateway',
  fetchImpl?: typeof fetch,
  maxRequests = 2
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
      ...(maxRequests > 32
        ? { capacityPolicy: 'model-dispatch-policy.capacity128.v1' }
        : {}),
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
    expect(transport.lastFailure).toEqual({
      code: 'model_dispatch_budget_exhausted',
      effect: 'effect_unknown',
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
