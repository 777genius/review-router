import { createHash } from 'crypto';
import * as core from '../../../src/actions/core';
import {
  prepareClaudeSubscriptionCredential,
  prepareClaudeSubscriptionModelRoute,
} from '../../../src/codex-oauth/claude-subscription-bootstrap';
import { PreparedModelDispatch } from '../../../src/review-orchestration/infrastructure/prepared-model-dispatch';
import { startRunnerLocalAnthropicModelTransport } from '../../../src/review-orchestration/infrastructure/runner-local-anthropic-model-transport';

jest.mock('../../../src/actions/core', () => ({ setSecret: jest.fn() }));
jest.mock(
  '../../../src/review-orchestration/infrastructure/runner-local-anthropic-model-transport',
  () => ({
    startRunnerLocalAnthropicModelTransport: jest.fn(),
  })
);

const token = 'sk-ant-oat01-synthetic-original';
const replacement = 'sk-ant-oat01-synthetic-replacement';
const start = jest.mocked(startRunnerLocalAnthropicModelTransport);

beforeEach(() => jest.clearAllMocks());

it('captures the existing opaque secret once and exposes no invented expiry', () => {
  const env: NodeJS.ProcessEnv = {
    INPUT_CLAUDE_CODE_OAUTH_TOKEN: ` ${token}\n`,
    'INPUT_CLAUDE-CODE-OAUTH-TOKEN': token,
    CLAUDE_CODE_OAUTH_TOKEN: token,
    UNRELATED: 'preserved',
  };
  const credential = prepareClaudeSubscriptionCredential({ env });
  expect(env).toEqual({ UNRELATED: 'preserved' });
  expect(credential.lifetime).toEqual({ kind: 'opaque_provider_validated' });
  expect(credential).not.toHaveProperty('credentialValidUntil');
  env.CLAUDE_CODE_OAUTH_TOKEN = replacement;
  expect(credential.readToken()).toBe(token);
  expect(core.setSecret).toHaveBeenCalledWith(token);
  credential.dispose();
  credential.dispose();
  expect(() => credential.readToken()).toThrow(
    'claude_subscription_credential_disposed'
  );
});

it.each([
  { CLAUDE_CODE_OAUTH_TOKEN: '' },
  { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-api03-synthetic-key' },
  { CLAUDE_CODE_OAUTH_TOKEN: 'gh secret set CLAUDE_CODE_OAUTH_TOKEN' },
  {
    CLAUDE_CODE_OAUTH_TOKEN: token,
    INPUT_CLAUDE_CODE_OAUTH_TOKEN: replacement,
  },
])(
  'removes invalid or conflicting inputs without selecting another account: %j',
  (initial) => {
    const env: NodeJS.ProcessEnv = { ...initial };
    expect(() => prepareClaudeSubscriptionCredential({ env })).toThrow(
      'claude_subscription_secret_invalid'
    );
    expect(env).toEqual({});
    expect(start).not.toHaveBeenCalled();
  }
);

it('clears input material even when preparation was already cancelled', () => {
  const signal = AbortSignal.abort(new Error('cancelled'));
  const env = { CLAUDE_CODE_OAUTH_TOKEN: token };
  expect(() => prepareClaudeSubscriptionCredential({ env, signal })).toThrow(
    'cancelled'
  );
  expect(env).toEqual({});
});

it('cancellation retires the captured handle without reading a replacement', () => {
  const controller = new AbortController();
  const env = { CLAUDE_CODE_OAUTH_TOKEN: token };
  const credential = prepareClaudeSubscriptionCredential({
    env,
    signal: controller.signal,
  });
  env.CLAUDE_CODE_OAUTH_TOKEN = replacement;
  controller.abort(new Error('cancelled'));
  expect(() => credential.readToken()).toThrow('cancelled');
});

function fixture(runtimeChanges: Record<string, string> = {}) {
  const profile = JSON.stringify({
    profileRef: 'ocr-native-fixture',
    agentKind: 'ocr',
    packageVersion: '1.13.1-rr.5',
    binarySha256: 'a'.repeat(64),
    modelTransports: ['provider_api'],
    contextGateway: false,
    cancellation: true,
  });
  const modelDispatch = new PreparedModelDispatch({
    apiUrl: 'https://control.example.invalid',
    authorization: () => ({
      authorizationId: 'authorization',
      authorizationToken: 'synthetic',
    }),
    capability: {
      extensionId: 'review-model-dispatch.v2',
      version: 2,
      routeIdentityHash: 'b'.repeat(64),
      transport: 'runner_local_anthropic',
      wireProtocol: 'anthropic-messages',
      outputTokenLimit: 'upstream_request',
      providerIndex: 0,
      configuredModel: 'sonnet',
      model: 'claude-sonnet-fixture',
      deadline: new Date(Date.now() + 60_000).toISOString(),
      maxRequests: 2,
      maxConcurrentRequests: 1,
      maxRequestBytes: 64_000,
      maxResponseBytes: 64_000,
      maxOutputTokens: 100,
    },
  });
  const credential = prepareClaudeSubscriptionCredential({
    env: { CLAUDE_CODE_OAUTH_TOKEN: token },
  });
  return {
    credential,
    modelDispatch,
    runtimeConfig: {
      protocolVersion: 1 as const,
      configVersion: 1,
      runtimeEnv: {
        REVIEW_AUTH_MODE: 'claude-oauth',
        REVIEW_PROVIDERS: 'claude/sonnet',
        CLAUDE_MODEL: 'sonnet',
        CLAUDE_AGENTIC_CONTEXT: 'false',
        REVIEW_ROUTER_AGENT_PROFILE_JSON: profile,
        REVIEW_ROUTER_AGENT_PROFILE_DIGEST: createHash('sha256')
          .update(profile)
          .digest('hex'),
        ...runtimeChanges,
      },
    },
  };
}

it('prepares the captured canonical route for both phases while preserving configured alias and supplied-diff mode', async () => {
  const f = fixture();
  const dispose = jest.fn(async () => undefined);
  start.mockResolvedValue({
    protocol: 'anthropic-messages',
    baseUrl: 'http://127.0.0.1:1234',
    environment: {},
    configuration: [],
    actualModel: () => undefined,
    failureFact: () => undefined,
    dispose,
  });
  const route = await prepareClaudeSubscriptionModelRoute(f);
  expect(start).toHaveBeenCalledTimes(1);
  const args = start.mock.calls[0][0];
  expect(args.modelDispatch.capability.model).toBe('claude-sonnet-fixture');
  expect(args.credentialLifetime).toEqual({
    kind: 'opaque_provider_validated',
  });
  expect(await args.readToken()).toBe(token);
  expect(f.runtimeConfig.runtimeEnv.CLAUDE_MODEL).toBe('sonnet');
  await route.dispose();
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(() => f.credential.readToken()).toThrow(
    'claude_subscription_credential_disposed'
  );
});

it.each<Record<string, string>>([
  { CLAUDE_MODEL: 'opus' },
  { REVIEW_PROVIDERS: 'claude/sonnet,claude/opus' },
  { REVIEW_AUTH_MODE: 'openrouter-api' },
])(
  'rejects a changed model/account route before reading credentials or opening transport: %j',
  async (change) => {
    const f = fixture(change);
    await expect(prepareClaudeSubscriptionModelRoute(f)).rejects.toThrow(
      'claude_subscription_admitted_route_invalid'
    );
    expect(start).not.toHaveBeenCalled();
    expect(() => f.credential.readToken()).toThrow(
      'claude_subscription_credential_disposed'
    );
  }
);
