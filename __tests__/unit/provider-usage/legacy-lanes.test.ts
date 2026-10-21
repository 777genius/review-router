import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import nock from 'nock';
import { applyControlPlaneRuntimeConfig } from '../../../src/control-plane/runtime-config';
import {
  UsageDelivery,
  UsageGrant,
} from '../../../src/provider-usage/delivery';
import { ClaudeCodeProvider } from '../../../src/providers/claude-code';
import { ProviderRegistry } from '../../../src/providers/registry';
import { DEFAULT_CONFIG } from '../../../src/config/defaults';
import type { Provider } from '../../../src/providers/base';
import type { ReviewConfig } from '../../../src/types';

jest.mock('child_process', () => ({
  ...jest.requireActual<typeof import('child_process')>('child_process'),
  spawn: jest.fn(),
}));
const spawnMock = jest.mocked(spawn);
function grant(provider = 'claude', model = 'sonnet'): UsageGrant {
  return {
    grantId: 'legacy-grant',
    grantToken: 'PRIVATE-GRANT',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    scope: {
      sourceInstance: 'runner/legacy-grant',
      callIdPrefix: 'legacy-grant-',
      provider,
      requestedModel: model,
      runtimeType: 'claude',
      route: 'direct',
      purpose: 'review',
      workspaceId: 'workspace',
      invocationId: 'legacy-invocation',
      repositoryId: '123',
      runId: '456',
      runAttempt: 1,
      authorizationId: 'legacy-authorization',
      actorId: null,
      bindingId: null,
      producerDigest: 'digest',
      workflowIdentity: 'workflow',
      jobIdentity: 'job',
    },
  };
}
let directory: string;
const originalEnv = process.env;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'TEST-legacy-usage-'));
  process.env = { ...originalEnv };
  jest.clearAllMocks();
});
afterEach(() => {
  nock.cleanAll();
  process.env = originalEnv;
  rmSync(directory, { recursive: true, force: true });
});

it('registers the ephemeral key in existing OIDC exchange and accepts only server-derived grants', async () => {
  const exchanges: Record<string, unknown>[] = [];
  const fetchImpl = jest.fn(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('/session/exchange')) {
        exchanges.push(
          JSON.parse(String(init?.body)) as Record<string, unknown>
        );
        return new Response(
          JSON.stringify({
            sessionToken: 'PRIVATE-SESSION',
            providerUsageGrants: [grant()],
          })
        );
      }
      return new Response(
        JSON.stringify({
          protocolVersion: 1,
          configVersion: 1,
          runtimeEnv: {
            REVIEW_AUTH_MODE: 'claude-oauth',
            REVIEW_PROVIDERS: 'claude/sonnet',
          },
        })
      );
    }
  ) as typeof fetch;
  const env = {
    REVIEWROUTER_RUNTIME_CONFIG_MODE: 'oidc',
    REVIEWROUTER_API_URL: 'https://api.example',
    RUNNER_TEMP: directory,
  };
  const result = await applyControlPlaneRuntimeConfig({
    env,
    fetchImpl,
    registerProviderUsage: true,
    oidc: { requestToken: async () => 'PRIVATE-OIDC' },
  });
  expect(exchanges[0]).toMatchObject({
    oidcToken: 'PRIVATE-OIDC',
    audience: 'reviewrouter',
    usagePublicKey: expect.stringContaining('BEGIN PUBLIC KEY'),
  });
  expect(Object.keys(exchanges[0]).sort()).toEqual([
    'audience',
    'oidcToken',
    'usagePublicKey',
  ]);
  expect(result.status).toBe('applied');
  if (result.status !== 'applied') throw new Error('expected applied');
  expect(result.usageDeliveries).toHaveLength(1);
  expect(result.usageDeliveries![0].scope.provider).toBe('claude');
  expect(
    readFileSync(result.usageDeliveries![0].artifactPath, 'utf8')
  ).not.toContain('PRIVATE');
  expect(env).not.toHaveProperty('providerUsageGrants');
});

it('matches configured provider/model exactly and refuses ambiguous grant matches', () => {
  const registration = UsageDelivery.prepareRegistration();
  const delivery = registration.acceptGrant(
    {
      apiUrl: 'https://api.example',
      executionToken: '',
      invocationId: 'legacy-invocation',
      temporaryDirectory: directory,
      uploadArtifact: async () => {},
    },
    grant()
  );
  const instantiate = (deliveries: readonly UsageDelivery[]) => {
    const registry = new ProviderRegistry(undefined, undefined, {
      deliveries,
      authMode: 'claude-oauth',
    });
    return (
      registry as unknown as {
        instantiate(names: string[], config: ReviewConfig): Provider[];
      }
    ).instantiate(['claude/sonnet', 'claude/opus'], DEFAULT_CONFIG);
  };
  const options = (provider: Provider) =>
    (provider as unknown as { options: { usageDelivery?: UsageDelivery } })
      .options;
  const matched = instantiate([delivery]);
  expect(options(matched[0]).usageDelivery).toBe(delivery);
  expect(options(matched[1]).usageDelivery).toBeUndefined();
  expect(
    options(instantiate([delivery, delivery])[0]).usageDelivery
  ).toBeUndefined();
});

it('routes the actual Claude CLI request through supported child base URL and captures failed retry spend', async () => {
  const registration = UsageDelivery.prepareRegistration();
  const delivery = registration.acceptGrant(
    {
      apiUrl: 'https://api.example',
      executionToken: '',
      invocationId: 'legacy-invocation',
      temporaryDirectory: directory,
      uploadArtifact: async () => {},
    },
    grant()
  );
  const stream =
    'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":4,"cache_read_input_tokens":6,"cache_creation_input_tokens":2,"output_tokens":1}}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":3}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
  const failed = nock('https://api.anthropic.com')
    .post('/v1/messages')
    .matchHeader('authorization', 'Bearer PRIVATE-OAUTH')
    .reply(429, '{"error":{"type":"rate_limit_error"}}', {
      'content-type': 'application/json',
    });
  const success = nock('https://api.anthropic.com')
    .post('/v1/messages')
    .matchHeader('authorization', 'Bearer PRIVATE-OAUTH')
    .reply(200, stream, { 'content-type': 'text/event-stream' });
  const flights: Promise<void>[] = [];
  spawnMock.mockImplementation((_binary, args, options) => {
    const proc = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: jest.fn(),
      unref: jest.fn(),
      pid: 12345,
    });
    process.nextTick(() => {
      if ((args as string[]).includes('--version')) {
        proc.emit('close', 0);
        return;
      }
      const env = (options as { env: NodeJS.ProcessEnv }).env;
      expect(env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:/);
      expect(JSON.stringify(env)).not.toContain('PRIVATE-GRANT');
      const flight = (async () => {
        for (const status of [429, 200]) {
          const response = await fetch(
            env.ANTHROPIC_BASE_URL + '/v1/messages',
            {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                authorization: 'Bearer PRIVATE-OAUTH',
                'anthropic-version': '2023-06-01',
              },
              body: '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"PRIVATE-PROMPT"}]}',
            }
          );
          expect(response.status).toBe(status);
          const bytes = await response.text();
          if (status === 200) expect(bytes).toBe(stream);
        }
        proc.stderr.emit('data', 'PRIVATE-CLI-ERROR');
        proc.emit('close', 1);
      })().catch((error) => {
        proc.emit('error', error);
      });
      flights.push(flight);
    });
    return proc as unknown as ReturnType<typeof spawn>;
  });
  const provider = new ClaudeCodeProvider('sonnet', {
    usageDelivery: delivery,
  });
  const prepared = await provider.prepareInvocation('PRIVATE-PROMPT', 5000);
  await expect(
    provider.executePreparedInvocation(prepared, {
      bearerToken: 'sk-ant-oat01-test-token',
    })
  ).rejects.toThrow();
  await Promise.all(flights);
  expect(failed.isDone() && success.isDone()).toBe(true);
  const bytes = readFileSync(delivery.artifactPath, 'utf8');
  expect(bytes).not.toMatch(/PRIVATE/);
  const facts = JSON.parse(bytes).facts as Array<{
    state: string;
    tokens: { inputTotal: number; outputTotal: number; total: number };
  }>;
  expect(facts).toHaveLength(4);
  expect(facts[1].state).toBe('failed');
  expect(facts[3]).toMatchObject({
    state: 'completed',
    tokens: {
      inputTotal: 12,
      outputTotal: 3,
      cacheRead: 6,
      cacheWrite: 2,
      total: 15,
    },
  });
});

it.each([
  [
    'codex/gpt-test',
    'openai',
    'gpt-test',
    'openai-api',
    'https://api.openai.com/v1',
  ],
  [
    'codex/gpt-test',
    'codex',
    'gpt-test',
    'codex-oauth',
    'https://chatgpt.com/backend-api/codex',
  ],
  [
    'codex-mimo/mimo-v2.6-pro',
    'mimo',
    'mimo-v2.6-pro',
    'mimo-token-plan-api',
    undefined,
  ],
  [
    'openrouter/vendor/model',
    'openrouter',
    'vendor/model',
    'openrouter-api',
    undefined,
  ],
])(
  'wires the granted configured lane %s without widening provider scope',
  (name, provider, model, authMode, upstream) => {
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    const registration = UsageDelivery.prepareRegistration();
    const delivery = registration.acceptGrant(
      {
        apiUrl: 'https://api.example',
        executionToken: '',
        invocationId: 'legacy-invocation',
        temporaryDirectory: directory,
        uploadArtifact: async () => {},
      },
      grant(provider, model)
    );
    const registry = new ProviderRegistry(undefined, undefined, {
      deliveries: [delivery],
      authMode,
    });
    const providers = (
      registry as unknown as {
        instantiate(names: string[], config: ReviewConfig): Provider[];
      }
    ).instantiate([name], DEFAULT_CONFIG);
    expect(providers).toHaveLength(1);
    const options = (
      providers[0] as unknown as {
        options: {
          usageDelivery?: UsageDelivery;
          usageUpstreamBaseUrl?: string;
        };
      }
    ).options;
    expect(options.usageDelivery).toBe(delivery);
    expect(options.usageUpstreamBaseUrl).toBe(upstream);
  }
);

it('keeps valid runtime configuration usable when telemetry grants are unavailable or invalid', async () => {
  const fetchImpl = jest.fn(
    async (url: RequestInfo | URL) =>
      new Response(
        JSON.stringify(
          String(url).includes('/session/exchange')
            ? {
                sessionToken: 'session',
                providerUsageGrants: [{ grantId: 'invalid' }],
              }
            : {
                protocolVersion: 1,
                configVersion: 7,
                runtimeEnv: {
                  REVIEW_AUTH_MODE: 'claude-oauth',
                  REVIEW_PROVIDERS: 'claude/sonnet',
                },
              }
        )
      )
  ) as typeof fetch;
  const env: NodeJS.ProcessEnv = {
    REVIEWROUTER_RUNTIME_CONFIG_MODE: 'oidc',
    REVIEWROUTER_API_URL: 'https://api.example',
    REVIEWROUTER_STATIC_CONFIG_FALLBACK: 'false',
    RUNNER_TEMP: directory,
  };
  const result = await applyControlPlaneRuntimeConfig({
    env,
    fetchImpl,
    registerProviderUsage: true,
    oidc: { requestToken: async () => 'oidc' },
  });
  expect(result).toMatchObject({
    status: 'applied',
    configVersion: 7,
    usageDeliveries: [],
  });
  expect(env.REVIEW_PROVIDERS).toBe('claude/sonnet');
});
