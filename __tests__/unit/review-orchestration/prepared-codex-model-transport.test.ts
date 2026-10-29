import { createHash } from 'crypto';
import nock from 'nock';
import {
  HOSTED_POOL_CODEX_RESPONSES_PATH,
  LOCAL_MODEL_CAPABILITY_ENV,
  startHostedPoolCodexModelTransport,
  startRunnerLocalCodexSubscriptionModelTransport,
  type LocalGatewayModelTransport,
} from '../../../src/review-orchestration/infrastructure/account-gateway-model-transport';
import {
  PreparedModelDispatch,
  type PreparedModelInvocationScope,
} from '../../../src/review-orchestration/infrastructure/prepared-model-dispatch';
import { normalizeCodexSubscriptionResponsesRequest } from '../../../src/review-orchestration/infrastructure/codex-subscription-responses-codec';

const model = 'codex-fixture';
const accessToken = 'synthetic+opaque/access==';
const originalGrant = 'synthetic_original_hosted_grant';
const scope: PreparedModelInvocationScope = {
  executionId: 'execution',
  workSlotId: 'discovery',
  attemptOrdinal: 1,
  leaseId: 'lease',
  leaseCapability: 'lease-capability',
  fencingToken: '1',
  preparedManifestKey: 'manifest',
};
const discovery = Buffer.from(
  JSON.stringify({
    model,
    stream: true,
    store: false,
    max_output_tokens: 999,
    input: [{ role: 'user', content: 'synthetic diff' }],
    reasoning: { effort: 'high' },
    tools: [
      { type: 'function', name: 'task_done', parameters: { type: 'object' } },
    ],
  })
);
function hash(value: Uint8Array) {
  return createHash('sha256').update(value).digest('hex');
}
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
function completed(changes: Record<string, unknown> = {}, tool = false) {
  return {
    id: 'response-fixture',
    object: 'response',
    model,
    status: 'completed',
    output: tool
      ? [
          {
            type: 'function_call',
            call_id: 'tool-1',
            name: 'task_done',
            arguments: '{}',
          },
        ]
      : [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: '{"results":[]}' }],
          },
        ],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    ...changes,
  };
}
function sse(response: unknown) {
  return `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`;
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function until(check: () => boolean) {
  for (let count = 0; count < 100 && !check(); count++)
    await new Promise((resolve) => setTimeout(resolve, 2));
  expect(check()).toBe(true);
}

const bridges: LocalGatewayModelTransport[] = [];
beforeEach(() => {
  nock.disableNetConnect();
  nock.enableNetConnect('127.0.0.1');
});
afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.dispose()));
  nock.abortPendingRequests();
  nock.cleanAll();
  nock.enableNetConnect();
});

async function fixture(
  kind: 'subscription' | 'hosted_pool' = 'subscription',
  options: {
    settlementGate?: ReturnType<typeof gate>;
    loseAck?: boolean;
    maxRequests?: number;
    signal?: AbortSignal;
  } = {}
) {
  const records = new Map<string, Record<string, unknown>>();
  const events: string[] = [];
  const deadline = new Date(Date.now() + 60_000).toISOString();
  const fetchImpl = jest.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith('/claim')) {
        events.push('claim');
        if (records.size >= (options.maxRequests ?? 2))
          return json({ error: 'budget' }, 409);
        const claim = JSON.parse(String(init?.body));
        const dispatch = {
          ...claim,
          authorizationId: 'authorization',
          nativeRequestRef: 'request',
          role:
            claim.workSlotId === 'discovery'
              ? 'finding_discovery'
              : 'lifecycle_verification',
          state: 'dispatch_may_have_started',
          terminalReceipt: null,
        };
        records.set(claim.dispatchId, dispatch);
        return json({
          status: 'claimed',
          dispatch,
          notAfter: deadline,
          receiptToken: 'e'.repeat(64),
        });
      }
      const dispatch = records.get(pathname.split('/')[5]);
      if (!dispatch) throw new Error('unexpected fixture request');
      if (pathname.endsWith('/settle')) {
        events.push('settle:start');
        await options.settlementGate?.promise;
        const settlement = JSON.parse(String(init?.body));
        Object.assign(dispatch, {
          state: settlement.state,
          terminalReceipt: settlement.receipt ?? null,
        });
        events.push('settle:committed');
        if (options.loseAck) throw new Error('synthetic lost acknowledgement');
      } else events.push('readback');
      return json({ dispatch });
    }
  );
  const modelDispatch = new PreparedModelDispatch({
    apiUrl: 'https://control.example.invalid',
    fetchImpl: fetchImpl as typeof fetch,
    authorization: () => ({
      authorizationId: 'authorization',
      authorizationToken: 'synthetic-run-jwt',
    }),
    capability: {
      extensionId: 'review-model-dispatch.v2',
      version: 2,
      routeIdentityHash: 'a'.repeat(64),
      transport:
        kind === 'subscription' ? 'runner_local_responses' : 'hosted_pool',
      wireProtocol: 'codex-responses',
      outputTokenLimit: 'terminal_acceptance',
      providerIndex: 0,
      model,
      deadline,
      maxRequests: options.maxRequests ?? 2,
      maxConcurrentRequests: 1,
      maxRequestBytes: 64_000,
      maxResponseBytes: 64_000,
      maxOutputTokens: 100,
    },
  });
  let grant = originalGrant;
  const readGrant = jest.fn(() => grant);
  const credential = {
    accessToken,
    accountId: 'account-fixed',
    credentialValidUntil: Date.parse(deadline) + 60_000,
  };
  const bridge =
    kind === 'subscription'
      ? await startRunnerLocalCodexSubscriptionModelTransport({
          credential,
          modelDispatch,
          reasoningEffort: 'high',
          signal: options.signal,
        })
      : await startHostedPoolCodexModelTransport({
          apiUrl: 'https://control.example.invalid',
          authorization: () => 'synthetic-run-jwt',
          readGrant,
          modelDispatch,
          reasoningEffort: 'high',
          signal: options.signal,
        });
  bridges.push(bridge);
  credential.accessToken = 'mutated-token-after-capture';
  grant = 'mutated_grant_after_capture';
  const release = bridge.beginInvocation!(() => scope);
  return {
    bridge,
    records,
    events,
    readGrant,
    modelDispatch,
    release,
    origin:
      kind === 'subscription'
        ? 'https://chatgpt.com'
        : 'https://control.example.invalid',
    path:
      kind === 'subscription'
        ? '/backend-api/codex/responses'
        : HOSTED_POOL_CODEX_RESPONSES_PATH,
    request: (body = discovery) =>
      fetch(`${bridge.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: bridge.environment[LOCAL_MODEL_CAPABILITY_ENV]!,
          'content-type': 'application/json',
        },
        body,
      }),
  };
}

it.each(['subscription', 'hosted_pool'] as const)(
  'uses the same captured %s route for discovery and verifier with one durable allowance',
  async (kind) => {
    const f = await fixture(kind);
    const headers: Record<string, string | string[]>[] = [];
    const bodies: Record<string, unknown>[] = [];
    const upstream = nock(f.origin)
      .post(f.path)
      .times(2)
      .reply(function (_uri, body) {
        headers.push(this.req.headers);
        bodies.push(typeof body === 'string' ? JSON.parse(body) : body);
        return [
          200,
          sse(completed({}, bodies.length === 1)),
          { 'content-type': 'text/event-stream' },
        ];
      });
    const first = await f.request();
    expect(first.status).toBe(200);
    await first.text();
    f.release();
    const requestBody = f.bridge.encodeLifecycleRequest!({
      model,
      instructions: 'shared verifier rules',
      userText: 'prior findings',
      outputCap: 80,
      maxRequestBytes: 64_000,
    });
    const result = await f.bridge.generateLifecycleVerification!({
      requestBody,
      dispatch: {
        ...scope,
        dispatchId: 'verification',
        workSlotId: 'verification',
      },
      signal: new AbortController().signal,
      maxResponseBytes: 64_000,
      maxOutputTokens: 80,
      deadlineMs: 10_000,
    });
    expect(Buffer.from(result.body).toString()).toBe('{"results":[]}');
    expect(result.providerRequestEnvelopeHash).toBe(hash(requestBody));
    expect(f.bridge.requestCount!()).toBe(1);
    expect(f.bridge.actualModel()).toBe(model);
    expect(
      bodies.every(
        (body) =>
          body.model === model && !Object.hasOwn(body, 'max_output_tokens')
      )
    ).toBe(true);
    expect(bodies[1].reasoning).toEqual({ effort: 'high' });
    const normalized = normalizeCodexSubscriptionResponsesRequest({
      requestBytes: discovery,
      model,
      maxRequestBytes: 64_000,
      maxOutputTokens: 100,
      reasoningEffort: 'high',
    });
    const records = [...f.records.values()];
    expect(records.map((row) => row.maxOutputTokens)).toEqual([100, 80]);
    expect(records.map((row) => row.providerRequestEnvelopeHash)).toEqual([
      hash(normalized.requestBytes),
      hash(requestBody),
    ]);
    expect(records.every((row) => row.state === 'completed')).toBe(true);
    expect(records.map((row) => row.role)).toEqual([
      'finding_discovery',
      'lifecycle_verification',
    ]);
    for (const row of records)
      expect(row.terminalReceipt).toMatchObject({
        actualModel: model,
        fullyConsumed: true,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      });
    for (const header of headers) {
      if (kind === 'subscription') {
        expect(header.authorization).toBe(`Bearer ${accessToken}`);
        expect(header['chatgpt-account-id']).toBe('account-fixed');
        expect(header.originator).toBe('reviewrouter');
        expect(header['user-agent']).toBe('reviewrouter/ocr-native-v1');
        expect(
          Object.keys(header).some((key) => key.startsWith('x-reviewrouter-'))
        ).toBe(false);
      } else {
        expect(header.authorization).toBe('Bearer synthetic-run-jwt');
        expect(header['x-reviewrouter-hosted-grant']).toBe(originalGrant);
        expect(header['x-reviewrouter-model-dispatch-version']).toBe('2');
        expect(header['x-reviewrouter-model-route-identity-hash']).toBe(
          'a'.repeat(64)
        );
        expect(header['chatgpt-account-id']).toBeUndefined();
      }
    }
    expect(JSON.stringify(f.bridge.environment)).not.toContain(accessToken);
    expect(JSON.stringify(f.bridge.environment)).not.toContain(originalGrant);
    expect(f.readGrant).toHaveBeenCalledTimes(kind === 'hosted_pool' ? 1 : 0);
    await expect(
      f.bridge.generateLifecycleVerification!({
        requestBody,
        dispatch: { ...scope, dispatchId: 'extra', workSlotId: 'extra' },
        signal: new AbortController().signal,
        maxResponseBytes: 64_000,
        maxOutputTokens: 80,
        deadlineMs: 10_000,
      })
    ).rejects.toThrow();
    expect(f.records.size).toBe(2);
    upstream.done();
  }
);

it('withholds completed bytes until durable settlement and reconciles a lost acknowledgement without another POST', async () => {
  const settlementGate = gate();
  const f = await fixture('subscription', { settlementGate, loseAck: true });
  const upstream = nock(f.origin)
    .post(f.path)
    .once()
    .reply(200, sse(completed()), { 'content-type': 'text/event-stream' });
  let finished = false;
  const pending = f
    .request()
    .then((response) => response.text())
    .then((body) => {
      finished = true;
      return body;
    });
  await until(() => f.events.includes('settle:start'));
  expect(finished).toBe(false);
  settlementGate.release();
  expect(await pending).toContain('response.completed');
  expect(f.events).toContain('readback');
  expect(f.records.size).toBe(1);
  upstream.done();
});

it.each([
  { usage: undefined },
  { usage: { input_tokens: 10, output_tokens: 101, total_tokens: 111 } },
  { model: 'other' },
  { status: 'incomplete' },
  {
    output: [
      {
        type: 'function_call',
        call_id: 'tool-1',
        name: 'unoffered',
        arguments: '{}',
      },
    ],
  },
])(
  'fences invalid native terminal evidence without replay: %j',
  async (change) => {
    const f = await fixture();
    const upstream = nock(f.origin)
      .post(f.path)
      .once()
      .reply(200, sse(completed(change)), {
        'content-type': 'text/event-stream',
      });
    await expect(
      f.request().then((response) => response.text())
    ).rejects.toThrow();
    await until(() => [...f.records.values()][0]?.state === 'effect_unknown');
    const again = await f.request();
    expect(again.status).toBe(502);
    expect(f.records.size).toBe(1);
    expect(f.bridge.actualModel()).toBeUndefined();
    expect(f.bridge.releaseRetrySafeFailure!()).toBe(false);
    upstream.done();
  }
);

it('requires original run lifetime plus margin before exposing a repository OAuth route', async () => {
  const f = await fixture();
  expect(() =>
    startRunnerLocalCodexSubscriptionModelTransport({
      modelDispatch: f.modelDispatch,
      credential: {
        accessToken,
        accountId: 'account-fixed',
        credentialValidUntil:
          Date.parse(f.modelDispatch.capability.deadline) + 59_999,
      },
    })
  ).toThrow('codex_prepared_credential_lifetime_invalid');
  expect(f.records.size).toBe(0);
});

it('rejects native verifier tools before spending its durable allowance', async () => {
  const f = await fixture();
  f.release();
  const requestBody = Buffer.from(
    JSON.stringify({
      ...JSON.parse(discovery.toString()),
      tool_choice: 'auto',
    })
  );
  await expect(
    f.bridge.generateLifecycleVerification!({
      requestBody,
      dispatch: {
        ...scope,
        dispatchId: 'verification',
        workSlotId: 'verification',
      },
      signal: new AbortController().signal,
      maxResponseBytes: 64_000,
      maxOutputTokens: 80,
      deadlineMs: 10_000,
    })
  ).rejects.toThrow('lifecycle_verification_native_tools_forbidden');
  expect(f.records.size).toBe(0);
  expect(f.bridge.requestCount!()).toBe(0);
});

it('keeps a repository OAuth authentication rejection fenced without refresh or another upstream request', async () => {
  const f = await fixture();
  const upstream = nock(f.origin)
    .post(f.path)
    .once()
    .reply(
      401,
      { error: { message: 'synthetic expired credential' } },
      { 'content-type': 'application/json' }
    );
  const rejected = await f.request();
  expect(rejected.status).toBe(401);
  await rejected.text();
  await until(() => [...f.records.values()][0]?.state === 'effect_unknown');
  expect((await f.request()).status).toBe(502);
  expect(f.records.size).toBe(1);
  expect(f.bridge.failureFact()).toEqual({
    code: 'codex_subscription_authentication_failed',
    effect: 'effect_unknown',
  });
  upstream.done();
});

it('bounds native verifier text before accepting its completion receipt', async () => {
  const f = await fixture();
  f.release();
  const upstream = nock(f.origin)
    .post(f.path)
    .once()
    .reply(200, sse(completed()), { 'content-type': 'text/event-stream' });
  const requestBody = f.bridge.encodeLifecycleRequest!({
    model,
    instructions: 'rules',
    userText: 'prior findings',
    outputCap: 80,
    maxRequestBytes: 64_000,
  });
  await expect(
    f.bridge.generateLifecycleVerification!({
      requestBody,
      dispatch: {
        ...scope,
        dispatchId: 'verification',
        workSlotId: 'verification',
      },
      signal: new AbortController().signal,
      maxResponseBytes: 4,
      maxOutputTokens: 80,
      deadlineMs: 10_000,
    })
  ).rejects.toThrow();
  await until(() => [...f.records.values()][0]?.state === 'effect_unknown');
  upstream.done();
});

it('cancels parent verification and drains its permanent unknown-effect receipt before disposal', async () => {
  const settlementGate = gate();
  const f = await fixture('hosted_pool', { settlementGate });
  f.release();
  const upstream = nock(f.origin)
    .post(f.path)
    .delayBody(10_000)
    .reply(200, sse(completed()), { 'content-type': 'text/event-stream' });
  const requestBody = f.bridge.encodeLifecycleRequest!({
    model,
    instructions: 'rules',
    userText: 'prior findings',
    outputCap: 80,
    maxRequestBytes: 64_000,
  });
  const verification = f.bridge.generateLifecycleVerification!({
    requestBody,
    dispatch: {
      ...scope,
      dispatchId: 'verification',
      workSlotId: 'verification',
    },
    signal: new AbortController().signal,
    maxResponseBytes: 64_000,
    maxOutputTokens: 80,
    deadlineMs: 10_000,
  }).catch((error) => error);
  await until(() => f.records.size === 1 && nock.pendingMocks().length === 0);
  let disposed = false;
  const disposing = f.bridge.dispose().then(() => {
    disposed = true;
  });
  await until(() => f.events.includes('settle:start'));
  expect(disposed).toBe(false);
  settlementGate.release();
  await disposing;
  expect(await verification).toBeInstanceOf(Error);
  expect([...f.records.values()][0].state).toBe('effect_unknown');
  upstream.done();
});
