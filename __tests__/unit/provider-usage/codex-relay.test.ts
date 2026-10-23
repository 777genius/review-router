import { startCodexUsageRelay } from '../../../src/provider-usage/codex-relay';
import type { UsageDelivery } from '../../../src/provider-usage/delivery';
import {
  validateUsageFact,
  type UsageFact,
} from '../../../src/provider-usage/usage-contract';

it('captures real loopback retries separately while preserving auth and response bytes', async () => {
  const facts: UsageFact[] = [];
  const delivery = {
    scope: {
      invocationId: 'invocation',
      sourceInstance: 'action:invocation',
      callIdPrefix: 'invocation:',
      provider: 'codex',
      requestedModel: 'test',
      runtimeType: 'codex-responses-relay',
      route: 'direct',
    },
    scopeIdentity: () => ({
      workspaceId: 'workspace',
      repositoryId: '12',
      actorId: null,
      runId: '34',
      runAttempt: 1,
      invocationId: 'invocation',
      bindingId: null,
      authorizationId: 'authorization',
    }),
    record: (fact: UsageFact) => {
      validateUsageFact(fact);
      facts.push(fact);
    },
  } as unknown as UsageDelivery;
  const content =
    'data: {"type":"response.completed","response":{"model":"actual","usage":{"input_tokens":14,"output_tokens":6},"output":[{"text":"PRIVATE-output"}]}}\n\n';
  const upstream = jest
    .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
    .mockResolvedValueOnce(new Response('PRIVATE-error', { status: 429 }))
    .mockResolvedValueOnce(
      new Response(content, {
        headers: { 'content-type': 'text/event-stream' },
      })
    );
  const relay = await startCodexUsageRelay({
    upstreamBaseUrl: 'https://chatgpt.com/backend-api/codex',
    model: 'test',
    delivery,
    provider: 'codex',
    fetchUpstream: upstream,
  });
  try {
    const request = () =>
      fetch(relay.baseUrl + '/responses', {
        method: 'POST',
        headers: {
          authorization: 'Bearer PRIVATE-key',
          'chatgpt-account-id': 'PRIVATE-account',
        },
        body: '{"model":"test","input":"PRIVATE-prompt"}',
      });
    const failure = await request();
    expect(failure.status).toBe(429);
    expect(await failure.text()).toBe('PRIVATE-error');
    const success = await request();
    expect(await success.text()).toBe(content);
  } finally {
    await relay.close();
  }
  expect(upstream).toHaveBeenCalledTimes(2);
  expect(upstream.mock.calls[0]?.[0]).toBe(
    'https://chatgpt.com/backend-api/codex/responses'
  );
  expect(upstream.mock.calls[0]?.[1]?.headers).toMatchObject({
    authorization: 'Bearer PRIVATE-key',
    'chatgpt-account-id': 'PRIVATE-account',
  });
  expect(facts.map((f) => f.state)).toEqual([
    'dispatched',
    'failed',
    'dispatched',
    'completed',
  ]);
  expect(facts[0]?.identity.callId).not.toBe(facts[2]?.identity.callId);
  expect(facts[3]?.tokens.total).toBe(20);
  expect(JSON.stringify(facts)).not.toContain('PRIVATE');
});

it('passes resolved and helper models unchanged and excludes token-counting calls', async () => {
  const facts: UsageFact[] = [];
  const delivery = {
    scope: {
      sourceInstance: 'action:invocation',
      callIdPrefix: 'invocation:',
      provider: 'claude',
      requestedModel: 'sonnet',
      runtimeType: 'claude',
      route: 'direct',
    },
    scopeIdentity: () => ({
      workspaceId: 'workspace',
      repositoryId: '12',
      actorId: null,
      runId: '34',
      runAttempt: 1,
      invocationId: 'invocation',
      bindingId: null,
      authorizationId: 'authorization',
    }),
    record: (fact: UsageFact) => {
      facts.push(fact);
    },
  } as unknown as UsageDelivery;
  const upstream = jest
    .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
    .mockImplementation(
      async () =>
        new Response(
          '{"type":"message","usage":{"input_tokens":2,"output_tokens":1}}',
          { headers: { 'content-type': 'application/json' } }
        )
    );
  const relay = await startCodexUsageRelay({
    upstreamBaseUrl: 'https://api.anthropic.com',
    model: 'sonnet',
    provider: 'claude',
    delivery,
    fetchUpstream: upstream,
  });
  const bodies = [
    '{"model":"claude-sonnet-4-6","messages":[]}',
    '{"model":"claude-sonnet-4-6","messages":[]}',
    '{"model":"claude-haiku-4-5","messages":[]}',
  ];
  try {
    for (const [index, suffix] of [
      '/v1/messages/count_tokens',
      '/v1/messages',
      '/v1/messages',
    ].entries()) {
      const response = await fetch(relay.baseUrl + suffix, {
        method: 'POST',
        headers: { 'x-api-key': 'private' },
        body: bodies[index],
      });
      expect(response.status).toBe(200);
      await response.text();
    }
  } finally {
    await relay.close();
  }
  expect(upstream.mock.calls.map((call) => call[1]?.body)).toEqual(bodies);
  expect(upstream.mock.calls[1]?.[1]?.headers).toMatchObject({
    'x-api-key': 'private',
  });
  expect(facts).toHaveLength(4);
  expect(facts[1]?.identity.requestedModel).toBe('sonnet');
  expect(facts[1]?.actualModel).toBeNull();
});
