import { createHash } from 'crypto';
import {
  RUNNER_LOCAL_ANTHROPIC_ROUTE,
  startRunnerLocalAnthropicModelTransport,
} from '../../../src/review-orchestration/infrastructure/runner-local-anthropic-model-transport';
import {
  PreparedModelDispatch,
  type PreparedModelInvocationScope,
} from '../../../src/review-orchestration/infrastructure/prepared-model-dispatch';
import {
  LOCAL_MODEL_CAPABILITY_ENV,
  type LocalGatewayModelTransport,
} from '../../../src/review-orchestration/infrastructure/account-gateway-model-transport';
import { encodeAnthropicVerificationRequest } from '../../../src/review-orchestration/infrastructure/anthropic-messages-codec';
import {
  prepareClaudeSubscriptionCredential,
  prepareClaudeSubscriptionModelRoute,
} from '../../../src/codex-oauth/claude-subscription-bootstrap';

const model = 'claude-fixture';
const token = 'sk-ant-oat01-synthetic_fixture';
const scope: PreparedModelInvocationScope = {
  executionId: 'execution',
  workSlotId: 'discovery',
  attemptOrdinal: 1,
  leaseId: 'lease',
  leaseCapability: 'capability',
  fencingToken: '1',
  preparedManifestKey: 'manifest',
};
const discovery = Buffer.from(
  JSON.stringify({
    model,
    max_tokens: 999,
    messages: [{ role: 'user', content: 'synthetic diff' }],
    output_config: { effort: 'high' },
    tools: [{ name: 'task_done', input_schema: { type: 'object' } }],
  })
);
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
function response(tool = false, changes: Record<string, unknown> = {}) {
  return json({
    id: 'msg_fixture',
    type: 'message',
    role: 'assistant',
    model,
    content: tool
      ? [{ type: 'tool_use', id: 'call_1', name: 'task_done', input: {} }]
      : [{ type: 'text', text: '{"results":[]}' }],
    stop_reason: tool ? 'tool_use' : 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
    ...changes,
  });
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function hash(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}

const transports: LocalGatewayModelTransport[] = [];
afterEach(async () => {
  await Promise.all(transports.splice(0).map((item) => item.dispose()));
});

async function harness(
  options: {
    upstream?: typeof fetch;
    settlementGate?: ReturnType<typeof gate>;
    loseSettlementAck?: boolean;
    maxRequests?: number;
    useClaudeBootstrap?: boolean;
  } = {}
) {
  const deadline = new Date(Date.now() + 60_000).toISOString();
  const records = new Map<string, Record<string, unknown>>();
  const events: string[] = [];
  const outbound: Array<{ url: string; init: RequestInit }> = [];
  const control = jest.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/claim')) {
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
      const id = path.split('/')[5];
      const dispatch = records.get(id);
      if (!dispatch) throw new Error('unexpected fixture dispatch');
      if (path.endsWith('/settle')) {
        events.push('settle:start');
        await options.settlementGate?.promise;
        const body = JSON.parse(String(init?.body));
        Object.assign(dispatch, {
          state: body.state,
          terminalReceipt: body.receipt ?? null,
        });
        events.push('settle:committed');
        if (options.loseSettlementAck)
          throw new Error('synthetic lost acknowledgement');
      } else events.push('readback');
      return json({ dispatch });
    }
  );
  const controller = new PreparedModelDispatch({
    apiUrl: 'https://control.example.invalid',
    capability: {
      extensionId: 'review-model-dispatch.v2',
      version: 2,
      routeIdentityHash: 'a'.repeat(64),
      transport: 'runner_local_anthropic',
      wireProtocol: 'anthropic-messages',
      outputTokenLimit: 'upstream_request',
      providerIndex: 0,
      ...(options.useClaudeBootstrap ? { configuredModel: 'sonnet' } : {}),
      model,
      deadline,
      maxRequests: options.maxRequests ?? 2,
      maxConcurrentRequests: 1,
      maxRequestBytes: 64_000,
      maxResponseBytes: 64_000,
      maxOutputTokens: 100,
    },
    authorization: () => ({
      authorizationId: 'authorization',
      authorizationToken: 'fixture-control-token',
    }),
    fetchImpl: control as typeof fetch,
  });
  const credential = options.useClaudeBootstrap
    ? prepareClaudeSubscriptionCredential({
        env: { CLAUDE_CODE_OAUTH_TOKEN: token },
      })
    : undefined;
  const readToken = jest.fn(() =>
    credential ? credential.readToken() : token
  );
  const upstream = jest.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      events.push('upstream');
      outbound.push({ url: String(url), init: init! });
      return options.upstream
        ? options.upstream(url, init)
        : response(outbound.length === 1);
    }
  );
  // Component fixture admission: current SaaS Claude defaults do not emit effort.
  const profile = JSON.stringify({
    profileRef: 'ocr-native-fixture',
    agentKind: 'ocr',
    packageVersion: '1.13.1-rr.6',
    binarySha256: 'a'.repeat(64),
    modelTransports: ['provider_api'],
    contextGateway: false,
    cancellation: true,
  });
  const transport = credential
    ? await prepareClaudeSubscriptionModelRoute({
        runtimeConfig: {
          protocolVersion: 1,
          configVersion: 1,
          runtimeEnv: {
            REVIEW_AUTH_MODE: 'claude-oauth',
            REVIEW_PROVIDERS: 'claude/sonnet',
            CLAUDE_MODEL: 'sonnet',
            CODEX_REASONING_EFFORT: 'high',
            REVIEW_ROUTER_AGENT_PROFILE_JSON: profile,
            REVIEW_ROUTER_AGENT_PROFILE_DIGEST: hash(Buffer.from(profile)),
          },
        },
        modelDispatch: controller,
        credential: { ...credential, readToken },
        fetchImpl: upstream as typeof fetch,
      })
    : await startRunnerLocalAnthropicModelTransport({
        readToken,
        modelDispatch: controller,
        credentialLifetime: { kind: 'opaque_provider_validated' },
        reasoningEffort: 'high',
        fetchImpl: upstream as typeof fetch,
      });
  transports.push(transport);
  const release = transport.beginInvocation!(() => scope);
  const request = (body: Uint8Array = discovery) =>
    fetch(`${transport.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: transport.environment[LOCAL_MODEL_CAPABILITY_ENV]!,
        'content-type': 'application/json',
      },
      body: Buffer.from(body),
    });
  return {
    transport,
    controller,
    readToken,
    upstream,
    outbound,
    records,
    events,
    request,
    release,
  };
}

describe('prepared native Anthropic route', () => {
  it('enforces a proven lifetime when available and requires a native subscription credential', async () => {
    const fixture = await harness();
    const readToken = jest.fn(() => token);
    await expect(
      startRunnerLocalAnthropicModelTransport({
        readToken,
        modelDispatch: fixture.controller,
        credentialLifetime: {
          kind: 'proven_expiry',
          credentialValidUntil:
            Date.parse(fixture.controller.capability.deadline) + 59_999,
        },
      })
    ).rejects.toThrow('anthropic_prepared_route_invalid');
    expect(readToken).not.toHaveBeenCalled();
    await expect(
      startRunnerLocalAnthropicModelTransport({
        readToken: () => 'sk-ant-api03-synthetic_api_key',
        modelDispatch: fixture.controller,
        credentialLifetime: {
          kind: 'proven_expiry',
          credentialValidUntil:
            Date.parse(fixture.controller.capability.deadline) + 60_000,
        },
      })
    ).rejects.toThrow('anthropic_subscription_credential_invalid');
    expect(fixture.upstream).not.toHaveBeenCalled();
  });

  it('requires the parent invocation authority and exact loopback capability', async () => {
    const fixture = await harness();
    const denied = await fetch(`${fixture.transport.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer incorrect',
        'content-type': 'application/json',
      },
      body: discovery,
    });
    expect(denied.status).toBe(403);
    fixture.release();
    expect((await fixture.request()).status).toBe(502);
    expect(fixture.records.size).toBe(0);
    expect(fixture.upstream).not.toHaveBeenCalled();
  });

  it('shares the real Claude bootstrap effort, captured account/model and durable budget between OCR and verifier', async () => {
    const fixture = await harness({ useClaudeBootstrap: true });
    const first = await fixture.request();
    expect(first.status).toBe(200);
    await first.json();
    fixture.release();
    const preparedBytes = fixture.transport.encodeLifecycleRequest!({
      model,
      instructions: 'shared verifier rules',
      userText: 'prior findings',
      outputCap: 80,
      maxRequestBytes: 64_000,
    });
    const prepared = {
      requestBytes: preparedBytes,
      requestHash: hash(preparedBytes),
    };
    expect(
      JSON.parse(Buffer.from(preparedBytes).toString()).output_config
    ).toEqual({
      effort: 'high',
    });
    const verified = await fixture.transport.generateLifecycleVerification!({
      requestBody: prepared.requestBytes,
      dispatch: {
        ...scope,
        dispatchId: 'parent-verification',
        workSlotId: 'verification',
      },
      signal: new AbortController().signal,
      maxResponseBytes: 64_000,
      maxOutputTokens: 80,
      deadlineMs: 10_000,
    });
    expect(Buffer.from(verified.body).toString()).toBe('{"results":[]}');
    expect(verified.providerRequestEnvelopeHash).toBe(prepared.requestHash);
    expect(fixture.readToken).toHaveBeenCalledTimes(1);
    expect(fixture.outbound).toHaveLength(2);
    expect(fixture.transport.requestCount!()).toBe(1);
    for (const outbound of fixture.outbound) {
      expect(outbound.url).toBe(RUNNER_LOCAL_ANTHROPIC_ROUTE.endpoint);
      expect(outbound.init.redirect).toBe('error');
      expect(outbound.init.headers).toEqual({
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
        'anthropic-version': RUNNER_LOCAL_ANTHROPIC_ROUTE.version,
        'anthropic-beta': RUNNER_LOCAL_ANTHROPIC_ROUTE.beta,
        'user-agent': RUNNER_LOCAL_ANTHROPIC_ROUTE.userAgent,
      });
      expect(JSON.parse(String(outbound.init.body)).model).toBe(model);
      expect(JSON.parse(String(outbound.init.body)).output_config).toEqual({
        effort: 'high',
      });
    }
    expect(JSON.parse(String(fixture.outbound[0].init.body)).max_tokens).toBe(
      100
    );
    expect(Buffer.from(String(fixture.outbound[1].init.body))).toEqual(
      Buffer.from(prepared.requestBytes)
    );
    const records = [...fixture.records.values()];
    expect(records.every((record) => record.state === 'completed')).toBe(true);
    expect(records.map((record) => record.role)).toEqual([
      'finding_discovery',
      'lifecycle_verification',
    ]);
    expect(records[0].providerRequestEnvelopeHash).toBe(
      hash(Buffer.from(String(fixture.outbound[0].init.body)))
    );
    expect(records[0].terminalReceipt).toMatchObject({
      actualModel: model,
      usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
    });
    expect(fixture.events).toEqual([
      'claim',
      'upstream',
      'settle:start',
      'settle:committed',
      'claim',
      'upstream',
      'settle:start',
      'settle:committed',
    ]);
    await expect(
      fixture.transport.generateLifecycleVerification!({
        requestBody: prepared.requestBytes,
        dispatch: {
          ...scope,
          dispatchId: 'parent-verification-2',
          workSlotId: 'verification-2',
        },
        signal: new AbortController().signal,
        maxResponseBytes: 64_000,
        maxOutputTokens: 80,
        deadlineMs: 10_000,
      })
    ).rejects.toThrow('model_dispatch_claim_unavailable');
    expect(fixture.upstream).toHaveBeenCalledTimes(2);
  });

  it('does not expose success until durable settlement and recovers a lost acknowledgement by readback', async () => {
    const settlementGate = gate();
    const fixture = await harness({ settlementGate, loseSettlementAck: true });
    let received = false;
    const pending = fixture.request().then(async (reply) => {
      received = true;
      return reply.json();
    });
    for (let i = 0; i < 50 && !fixture.events.includes('settle:start'); i++)
      await new Promise((resolve) => setTimeout(resolve, 2));
    expect(fixture.events).toContain('settle:start');
    expect(received).toBe(false);
    settlementGate.release();
    await pending;
    expect(fixture.events).toContain('readback');
    expect(fixture.upstream).toHaveBeenCalledTimes(1);
  });

  it('fences an opaque-token rejection without refresh, credential reselection, probes or replay', async () => {
    const fixture = await harness({
      upstream: (async () =>
        json({ error: 'synthetic expired token' }, 401)) as typeof fetch,
    });
    expect(fixture.upstream).not.toHaveBeenCalled();
    expect((await fixture.request()).status).toBe(502);
    expect((await fixture.request()).status).toBe(503);
    expect(fixture.readToken).toHaveBeenCalledTimes(1);
    expect(fixture.upstream).toHaveBeenCalledTimes(1);
    expect(fixture.records.size).toBe(1);
    expect([...fixture.records.values()][0].state).toBe('effect_unknown');
    expect(fixture.transport.failureFact()).toEqual({
      code: 'anthropic_subscription_authentication_failed',
      effect: 'effect_unknown',
    });
    expect(fixture.transport.releaseRetrySafeFailure!()).toBe(false);
  });

  it('binds the verifier allowance to its exact native request before a claim', async () => {
    const fixture = await harness();
    fixture.release();
    const requestBody = fixture.transport.encodeLifecycleRequest!({
      model,
      instructions: 'shared verifier rules',
      userText: 'prior findings',
      outputCap: 80,
      maxRequestBytes: 64_000,
    });
    await expect(
      fixture.transport.generateLifecycleVerification!({
        requestBody,
        dispatch: {
          ...scope,
          dispatchId: 'verification',
          workSlotId: 'verification',
        },
        signal: new AbortController().signal,
        maxResponseBytes: 64_000,
        maxOutputTokens: 79,
        deadlineMs: 10_000,
      })
    ).rejects.toThrow('anthropic_verification_wire_invalid');
    expect(fixture.records.size).toBe(0);
    expect(fixture.upstream).not.toHaveBeenCalled();
  });

  it('retains accepted discovery and stops verification when the same opaque token expires between phases', async () => {
    let calls = 0;
    const fixture = await harness({
      upstream: (async () =>
        ++calls === 1
          ? response(true)
          : json({ error: 'synthetic revoked token' }, 401)) as typeof fetch,
    });
    expect((await fixture.request()).status).toBe(200);
    fixture.release();
    const requestBody = fixture.transport.encodeLifecycleRequest!({
      model,
      instructions: 'shared verifier rules',
      userText: 'prior findings',
      outputCap: 80,
      maxRequestBytes: 64_000,
    });
    const request = {
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
    };
    await expect(
      fixture.transport.generateLifecycleVerification!(request)
    ).rejects.toThrow('anthropic_subscription_authentication_failed');
    await expect(
      fixture.transport.generateLifecycleVerification!(request)
    ).rejects.toThrow('anthropic_route_unavailable');
    expect([...fixture.records.values()].map((row) => row.state)).toEqual([
      'completed',
      'effect_unknown',
    ]);
    expect(
      fixture.outbound.map(
        (row) => (row.init.headers as Record<string, string>).authorization
      )
    ).toEqual([`Bearer ${token}`, `Bearer ${token}`]);
    expect(fixture.readToken).toHaveBeenCalledTimes(1);
    expect(fixture.upstream).toHaveBeenCalledTimes(2);
  });

  it.each([
    { stop_reason: 'max_tokens' },
    { model: 'another-model' },
    { usage: undefined },
  ])('fences unknown paid output without retries: %j', async (change) => {
    const fixture = await harness({
      upstream: (async () => response(false, change)) as typeof fetch,
    });
    expect((await fixture.request()).status).toBe(502);
    expect((await fixture.request()).status).toBe(503);
    expect([...fixture.records.values()][0].state).toBe('effect_unknown');
    expect(fixture.upstream).toHaveBeenCalledTimes(1);
    expect(fixture.transport.releaseRetrySafeFailure!()).toBe(false);
    expect(fixture.transport.failureFact()).toMatchObject({
      effect: 'effect_unknown',
    });
  });

  it('rejects wrong model, unknown envelope fields and unbound settings before a claim', async () => {
    const fixture = await harness();
    for (const change of [
      { model: 'other' },
      { metadata: { provider: 'override' } },
      { output_config: { effort: 'low' } },
      { stream: true },
    ]) {
      const body = Buffer.from(
        JSON.stringify({ ...JSON.parse(discovery.toString()), ...change })
      );
      expect((await fixture.request(body)).status).toBe(502);
    }
    expect(fixture.records.size).toBe(0);
    expect(fixture.upstream).not.toHaveBeenCalled();
  });

  it('binds one unambiguous serialized discovery envelope before authority is claimed', async () => {
    const fixture = await harness();
    const duplicated = Buffer.from(
      discovery.toString().replace('{', '{"model":"unapproved-first-value",')
    );
    expect((await fixture.request(duplicated)).status).toBe(200);
    const actual = String(fixture.outbound[0].init.body);
    expect(actual.match(/"model":/g)).toHaveLength(1);
    expect(actual).not.toContain('unapproved-first-value');
    expect([...fixture.records.values()][0].providerRequestEnvelopeHash).toBe(
      hash(Buffer.from(actual))
    );
  });

  it('aborts parent verifier fetch and drains its settlement during disposal', async () => {
    const entered = gate();
    const settlementGate = gate();
    const fixture = await harness({
      settlementGate,
      upstream: (async (_url, init) => {
        entered.release();
        return new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener(
            'abort',
            () => reject(new Error('cancelled')),
            { once: true }
          );
        });
      }) as typeof fetch,
    });
    fixture.release();
    const prepared = encodeAnthropicVerificationRequest({
      model,
      instructions: 'rules',
      userText: 'packet',
      outputCap: 80,
      maxRequestBytes: 64_000,
      reasoningEffort: 'high',
    });
    const verify = fixture.transport.generateLifecycleVerification!({
      requestBody: prepared.requestBytes,
      dispatch: {
        ...scope,
        dispatchId: 'parent-verification',
        workSlotId: 'verification',
      },
      signal: new AbortController().signal,
      maxResponseBytes: 64_000,
      maxOutputTokens: 80,
      deadlineMs: 10_000,
    }).catch((error) => error);
    await entered.promise;
    let disposed = false;
    const disposal = fixture.transport.dispose().then(() => {
      disposed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(disposed).toBe(false);
    settlementGate.release();
    await disposal;
    expect(await verify).toBeInstanceOf(Error);
    expect([...fixture.records.values()][0].state).toBe('effect_unknown');
    expect(fixture.upstream).toHaveBeenCalledTimes(1);
  });
});
