import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import childProcess, { type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexProvider } from '../../../src/providers/codex';
import * as core from '../../../src/actions/core';
import { bundledReviewAgentForTransport } from '../../../src/control-plane/approved-review-agent';
import { AccountGatewayModelTransport } from '../../../src/review-orchestration/infrastructure/account-gateway-model-transport';
import * as modelTransports from '../../../src/review-orchestration/infrastructure/account-gateway-model-transport';
import { ReviewActionV2ControlPlaneAdapter } from '../../../src/review-orchestration/infrastructure/review-action-v2-control-plane-adapter';
import { GitHubActionsOidcTokenProvider } from '../../../src/codex-oauth/github-actions-oidc';
import { prepareCodexCliBeforeAuthRead } from '../../../src/codex-oauth/codex-cli';
import { CodexOAuthControlPlaneClient } from '../../../src/codex-oauth/control-plane';
import { safeCheckoutRepository } from '../../../src/codex-oauth/safe-checkout';
import {
  approvedProviderApiAgent,
  assertProviderApiLocalInputs,
  runProviderApiRuntime,
} from '../../../src/codex-oauth/provider-api-runtime';
import {
  CodexOAuthV2ReviewOutcome,
  type CodexOAuthV2ReviewRunnerPort,
} from '../../../src/codex-oauth/runtime';
import { MergeGateConclusion } from '../../../src/review-projection/domain';

jest.mock('../../../src/codex-oauth/codex-cli');
jest.mock('../../../src/codex-oauth/safe-checkout', () => ({
  ...jest.requireActual('../../../src/codex-oauth/safe-checkout'),
  safeCheckoutRepository: jest.fn(),
}));

describe('direct provider API bootstrap', () => {
  const originalEnv = process.env;
  const head = 'a'.repeat(40);
  const agent = bundledReviewAgentForTransport('provider_api');
  const profileJson = JSON.stringify(agent);
  let fixture: string;
  const runtimeConfig = () => ({
    protocolVersion: 1,
    configVersion: 7,
    runtimeEnv: {
      REVIEW_AUTH_MODE: 'openrouter-api',
      RUN_TIMEOUT_SECONDS: '7200',
      REVIEW_PROVIDERS: 'openrouter/vendor/model',
      REQUIRED_HEALTHY_PROVIDERS: 'openrouter/vendor/model',
      SYNTHESIS_MODEL: 'openrouter/vendor/model',
      PROVIDER_LIMIT: '1',
      PROVIDER_MAX_PARALLEL: '1',
      INLINE_MIN_AGREEMENT: '1',
      REVIEW_ROUTER_AGENT_PROFILE_JSON: profileJson,
      REVIEW_ROUTER_AGENT_PROFILE_DIGEST: createHash('sha256')
        .update(profileJson)
        .digest('hex'),
    },
  });
  const capability = () => ({
    httpStatus: 200,
    value: {
      protocolVersion: 1,
      repository: 'owner/repo',
      headSha: head,
      token: 'read-only-token',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      permissions: { contents: 'read', pullRequests: 'read' },
      runtimeConfig: runtimeConfig(),
    },
  });
  const completed = {
    outcome: CodexOAuthV2ReviewOutcome.Completed,
    mergeGateConclusion: MergeGateConclusion.Pass,
    publicationReceipt: {
      publicationAttemptId: 'app-publication',
      canonicalReceiptSetHash: 'f'.repeat(64),
    },
  } as const;

  beforeEach(async () => {
    process.env = { ...originalEnv };
    for (const key of Object.keys(process.env))
      if (/^(INPUT_|RR_|CODEX_|OPENAI_|OPENROUTER_|CLAUDE_)/.test(key))
        delete process.env[key];
    await fs.mkdir(path.resolve('tmp'), { recursive: true });
    fixture = await fs.mkdtemp(path.resolve('tmp/provider-api-unit-'));
    await fs.mkdir(path.join(fixture, 'source'));
    process.env.RUNNER_TEMP = path.join(fixture, 'runtime');
    process.env.INPUT_OPENROUTER_API_KEY = 'unit-provider-key';
    await fs.writeFile(
      path.join(fixture, 'codex'),
      `#!/bin/sh\n[ "$1" = --version ] || exit 99\nprintf 'codex-cli ${agent.packageVersion}\\n'\n`,
      { mode: 0o700 }
    );
    jest.mocked(prepareCodexCliBeforeAuthRead).mockResolvedValue({
      binaryPath: path.join(fixture, 'codex'),
      clear: jest.fn(),
    });
    jest.spyOn(core, 'setSecret').mockImplementation(() => undefined);
    jest.spyOn(core, 'warning').mockImplementation(() => undefined);
    jest
      .spyOn(GitHubActionsOidcTokenProvider.prototype, 'requestToken')
      .mockResolvedValue('oidc-token');
    const authorization = {
      authorizationToken: 'v2-current-token',
      facts: { headSha: head, pullRequestNumber: 9 },
    };
    jest
      .spyOn(ReviewActionV2ControlPlaneAdapter.prototype, 'authorize')
      .mockResolvedValue(authorization as never);
    jest
      .spyOn(
        ReviewActionV2ControlPlaneAdapter.prototype,
        'currentAuthorization'
      )
      .mockReturnValue(authorization as never);
    jest
      .spyOn(
        AccountGatewayModelTransport.prototype,
        'providerApiCheckoutCapability'
      )
      .mockImplementation(async () => capability());
    for (const operation of [
      'prelease',
      'finalize',
      'writebackPreflight',
      'writeback',
    ] as const) {
      jest
        .spyOn(CodexOAuthControlPlaneClient.prototype, operation)
        .mockImplementation(async () => {
          throw new Error('unexpected_oauth_effect');
        });
    }
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    process.env = originalEnv;
    await fs.rm(fixture, { recursive: true, force: true });
  });
  const inputs = () => ({
    apiUrl: 'https://api.reviewrouter.org',
    audience: 'reviewrouter',
    workflowSchemaVersion: 2,
    repository: 'owner/repo',
    pullRequestNumber: 9,
    headSha: head,
    workspacePath: path.join(fixture, 'source'),
  });

  it('uses captured API-key authority without OAuth rotation and closes the local lease before terminal publication', async () => {
    const startTransport = jest.spyOn(
      modelTransports,
      'startDirectOpenRouterModelTransport'
    );
    let localLease: NonNullable<
      Parameters<CodexOAuthV2ReviewRunnerPort['run']>[0]['providerApi']
    >['credentialLease'];
    let home = '';
    let checkout = '';
    const review = {
      run: jest.fn(
        async (input: Parameters<CodexOAuthV2ReviewRunnerPort['run']>[0]) => {
          expect(input.providerInstanceId).toBeUndefined();
          expect(input.accountGateway).toBeUndefined();
          expect(input.ocr).toBeUndefined();
          expect(input.providerApi?.runtimeConfig).toEqual(runtimeConfig());
          localLease = input.providerApi!.credentialLease;
          expect(localLease().environment).toEqual(
            input.providerApi!.modelTransport.environment
          );
          expect(localLease().environment?.OPENROUTER_API_KEY).toBeUndefined();
          expect(
            localLease().environment?.REVIEWROUTER_LOCAL_MODEL_TOKEN
          ).toMatch(/^Bearer [a-f0-9]{64}$/);
          expect(process.env.OPENROUTER_API_KEY).toBeUndefined();
          expect(process.env.INPUT_OPENROUTER_API_KEY).toBeUndefined();
          home = input.codexHome!;
          checkout = input.workspacePath;
          await expect(
            fs.stat(path.join(home, 'auth.json'))
          ).rejects.toMatchObject({ code: 'ENOENT' });
          const configuration = await fs.readFile(
            path.join(home, 'config.toml'),
            'utf8'
          );
          expect(configuration).toContain('model_provider="openrouter"');
          expect(configuration).toContain('OPENROUTER_API_KEY="exclude"');
          expect(configuration).not.toContain('unit-provider-key');
          expect(configuration).not.toContain('https://openrouter.ai');
          expect(configuration).toContain(
            input.providerApi!.modelTransport.baseUrl
          );
          expect(configuration).not.toContain('env_key=');
          await input.refreshScmReadToken();
          return completed;
        }
      ),
    };
    const terminalReview = jest.fn(async () => {
      expect(() => localLease()).toThrow('provider_api_credential_closed');
    });
    await runProviderApiRuntime(inputs(), { review, terminalReview });
    expect(startTransport).toHaveBeenCalledWith(expect.any(Function), {
      requestMs: 7_200_000,
      streamFrameBytes: 8 * 1024 * 1024,
    });
    expect(terminalReview).toHaveBeenCalledWith(
      completed,
      expect.any(AbortSignal)
    );
    expect(prepareCodexCliBeforeAuthRead).toHaveBeenCalledWith(
      expect.objectContaining({ approvedAgent: agent })
    );
    expect(safeCheckoutRepository).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'read-only-token', headSha: head })
    );
    for (const operation of [
      'prelease',
      'finalize',
      'writebackPreflight',
      'writeback',
    ] as const) {
      expect(
        CodexOAuthControlPlaneClient.prototype[operation]
      ).not.toHaveBeenCalled();
    }
    await expect(fs.stat(home)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(checkout)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    { REVIEW_AUTH_MODE: 'codex-account-gateway' },
    { INLINE_MIN_AGREEMENT: '2' },
    { CODEX_REASONING_EFFORT: 'ultra' },
  ])(
    'denies a mismatched capture %j before CLI, checkout or key materialization',
    async (override) => {
      jest
        .mocked(
          AccountGatewayModelTransport.prototype.providerApiCheckoutCapability
        )
        .mockResolvedValue({
          ...capability(),
          value: {
            ...capability().value,
            runtimeConfig: {
              ...runtimeConfig(),
              runtimeEnv: {
                ...runtimeConfig().runtimeEnv,
                ...override,
              },
            },
          },
        });
      const review = { run: jest.fn() };
      await expect(
        runProviderApiRuntime(inputs(), { review, terminalReview: jest.fn() })
      ).rejects.toThrow('provider_api_runtime_failed:checkout_capability');
      expect(prepareCodexCliBeforeAuthRead).not.toHaveBeenCalled();
      expect(safeCheckoutRepository).not.toHaveBeenCalled();
      expect(review.run).not.toHaveBeenCalled();
      expect(core.setSecret).not.toHaveBeenCalledWith('unit-provider-key');
      expect(process.env.INPUT_OPENROUTER_API_KEY).toBeUndefined();
    }
  );

  it('refuses captured settings drift on a read-token refresh', async () => {
    const review = {
      run: jest.fn(
        async (input: Parameters<CodexOAuthV2ReviewRunnerPort['run']>[0]) => {
          jest
            .mocked(
              AccountGatewayModelTransport.prototype
                .providerApiCheckoutCapability
            )
            .mockResolvedValue({
              ...capability(),
              value: {
                ...capability().value,
                runtimeConfig: { ...runtimeConfig(), configVersion: 8 },
              },
            });
          await expect(input.refreshScmReadToken()).rejects.toThrow(
            'provider_api_runtime_config_changed'
          );
          return completed;
        }
      ),
    };
    await runProviderApiRuntime(inputs(), {
      review,
      terminalReview: jest.fn(),
    });
  });

  it('keeps bootstrap-owned files and CLI until an aborted direct child closes', async () => {
    const proc = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: 12345,
      kill: jest.fn(),
    }) as unknown as ChildProcess;
    let didSpawn!: () => void;
    const spawned = new Promise<void>((resolve) => {
      didSpawn = resolve;
    });
    jest.spyOn(childProcess, 'spawn').mockImplementation(() => {
      didSpawn();
      return proc;
    });
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
    let home = '';
    let checkout = '';
    const terminalReview = jest.fn();
    const review = {
      run: async (
        input: Parameters<CodexOAuthV2ReviewRunnerPort['run']>[0]
      ) => {
        home = input.codexHome!;
        checkout = input.workspacePath;
        const provider = new CodexProvider('vendor/model', {
          modelProvider: 'openrouter',
          disableBuiltinTools: true,
          waitForProcessClose: true,
        });
        await provider['runCliWithStdin'](
          input.codexBinaryPath!,
          'review prompt',
          60_000,
          {
            healthCheck: false,
            signal: input.providerApi!.signal,
            cwd: checkout,
          }
        );
        return completed;
      },
    };
    const operation = runProviderApiRuntime(inputs(), {
      review,
      terminalReview,
    });
    const rejected = expect(operation).rejects.toThrow(
      'provider_api_runtime_failed:runner'
    );
    try {
      await spawned;
      const cli = await jest.mocked(prepareCodexCliBeforeAuthRead).mock
        .results[0].value;
      process.emit('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(kill).toHaveBeenCalledWith(-proc.pid!, 'SIGKILL');
      await expect(fs.stat(home)).resolves.toBeDefined();
      await expect(fs.stat(checkout)).resolves.toBeDefined();
      expect(cli.clear).not.toHaveBeenCalled();
      proc.emit('close', null);
      await rejected;
      await expect(fs.stat(home)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(checkout)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(cli.clear).toHaveBeenCalledTimes(1);
      expect(terminalReview).not.toHaveBeenCalled();
    } finally {
      proc.emit('close', null);
      await operation.catch(() => undefined);
    }
  });

  it('fences the local credential on cancellation and never enters terminal publication', async () => {
    const review = {
      run: jest.fn(
        async (input: Parameters<CodexOAuthV2ReviewRunnerPort['run']>[0]) => {
          process.emit('SIGTERM');
          expect(() => input.providerApi!.credentialLease()).toThrow(
            'provider_api_cancelled'
          );
          return completed;
        }
      ),
    };
    const terminalReview = jest.fn();
    await expect(
      runProviderApiRuntime(inputs(), { review, terminalReview })
    ).rejects.toThrow('provider_api_runtime_failed:terminal');
    expect(terminalReview).not.toHaveBeenCalled();
    expect(process.env.INPUT_OPENROUTER_API_KEY).toBeUndefined();
  });

  it('rejects alternate auth, unsupported model/profile and mutable capability identity', () => {
    for (const key of [
      'INPUT_AUTH_JSON',
      'INPUT_PROVIDER_INSTANCE_ID',
      'INPUT_CLAUDE-CODE-OAUTH-TOKEN',
      'RR_CODEX_SESSION_MODE',
    ]) {
      expect(() =>
        assertProviderApiLocalInputs({ [key]: 'alternate' })
      ).toThrow('provider_api_alternate_auth_input');
    }
    for (const providers of [
      'codex/model',
      'openrouter/free',
      'openrouter/vendor/model,openrouter/other/model',
    ]) {
      expect(() =>
        approvedProviderApiAgent({
          ...runtimeConfig(),
          protocolVersion: 1,
          runtimeEnv: {
            ...runtimeConfig().runtimeEnv,
            REVIEW_PROVIDERS: providers,
          },
        })
      ).toThrow('provider_api_admitted_configuration_invalid');
    }
  });
});
