import { PreparedModelDispatch } from '../../../src/review-orchestration/infrastructure/prepared-model-dispatch';

function controller(
  transport: 'account_gateway' | 'runner_local_responses' = 'account_gateway'
) {
  return new PreparedModelDispatch({
    apiUrl: 'https://control.example.invalid',
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
      maxRequests: 2,
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
