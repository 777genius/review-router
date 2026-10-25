import nock from 'nock';
import {
  providerApiAuthModes,
  providerApiDescriptors,
} from '../../../src/control-plane/generated/review-action-v2/companion-contracts';
import {
  AccountGatewayModelTransport,
  LOCAL_MODEL_CAPABILITY_ENV,
  startDirectProviderApiModelTransport,
} from '../../../src/review-orchestration/infrastructure/account-gateway-model-transport';

describe('finite direct provider Responses transport', () => {
  afterEach(() => nock.cleanAll());

  it.each(providerApiAuthModes)(
    'sends %s to its fixed destination with parent-only key and unmodified request bytes',
    async (mode) => {
      const descriptor = providerApiDescriptors[mode];
      const endpoint = new URL(descriptor.fixedResponsesUrl);
      const model =
        mode === 'openrouter-api' ? 'vendor/model' : descriptor.defaultModel;
      const body = JSON.stringify({
        model,
        input: [{ role: 'user', content: 'synthetic fixture' }],
        tools: [
          {
            type: 'function',
            name: 'read_fixture',
            parameters: { type: 'object' },
          },
        ],
      });
      const upstream = nock(endpoint.origin)
        .post(endpoint.pathname, body)
        .matchHeader('authorization', 'Bearer synthetic-upstream-key')
        .matchHeader('user-agent', (value) =>
          String(value).startsWith('ReviewRouter/')
        )
        .reply(
          200,
          `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'synthetic-response', status: 'completed', model, output: [] } })}\n\n`,
          { 'content-type': 'text/event-stream' }
        );
      const bridge = await startDirectProviderApiModelTransport(
        mode,
        () => 'synthetic-upstream-key',
        { requestMs: 10000, streamFrameBytes: 1048576 }
      );
      try {
        expect(JSON.stringify(bridge.environment)).not.toContain(
          'synthetic-upstream-key'
        );
        expect(bridge.configuration.join('\n')).not.toContain(endpoint.origin);
        const response = await fetch(`${bridge.baseUrl}/responses`, {
          method: 'POST',
          headers: {
            authorization: bridge.environment[LOCAL_MODEL_CAPABILITY_ENV] ?? '',
            'content-type': 'application/json',
          },
          body,
        });
        expect(response.status).toBe(200);
        await response.text();
        upstream.done();
        expect(bridge.actualModel()).toBe(model);
        expect(bridge.requestCount?.()).toBe(1);
        if (mode === 'kimi-code-api')
          expect(bridge.configuration.join('\n')).not.toContain('service_tier');
      } finally {
        await bridge.dispose();
      }
    }
  );

  it('refuses a different direct origin and never follows upstream redirects', async () => {
    expect(
      () =>
        new AccountGatewayModelTransport(
          'https://untrusted.invalid',
          () => 'synthetic-key',
          undefined,
          { mode: 'kimi-code-api', requestMs: 10000, streamFrameBytes: 1048576 }
        )
    ).toThrow('provider_api_origin_invalid');
    const upstream = nock('https://api.kimi.ai')
      .post('/coding/v1/responses')
      .reply(302, '', {
        location: 'https://untrusted.invalid/steal',
        'content-type': 'application/json',
      });
    const bridge = await startDirectProviderApiModelTransport(
      'kimi-code-api',
      () => 'synthetic-key',
      { requestMs: 10000, streamFrameBytes: 1048576 }
    );
    try {
      const response = await fetch(`${bridge.baseUrl}/responses`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          authorization: bridge.environment[LOCAL_MODEL_CAPABILITY_ENV] ?? '',
          'content-type': 'application/json',
        },
        body: '{"model":"k3-256k"}',
      });
      expect(response.status).toBe(302);
      await response.text();
      upstream.done();
      expect(bridge.requestCount?.()).toBe(1);
    } finally {
      await bridge.dispose();
    }
  });
});
