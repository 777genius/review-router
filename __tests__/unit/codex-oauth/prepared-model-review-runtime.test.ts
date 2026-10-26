import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import * as core from '../../../src/actions/core';
import { runPreparedModelReview } from '../../../src/codex-oauth/prepared-model-review-runtime';
import { GitHubActionsOidcTokenProvider } from '../../../src/codex-oauth/github-actions-oidc';
import { ReviewActionV2ControlPlaneAdapter } from '../../../src/review-orchestration/infrastructure/review-action-v2-control-plane-adapter';
import { safeCheckoutRepository } from '../../../src/codex-oauth/safe-checkout';
import {
  resolveApprovedOcrBinary,
  prepareOcrManagedRun,
} from '../../../src/codex-oauth/ocr-managed-bootstrap';
import { LOCAL_MODEL_CAPABILITY_ENV } from '../../../src/review-orchestration/infrastructure/account-gateway-model-transport';
import { reviewModelDispatchContract } from '../../../src/control-plane/generated/review-action-v2/review-model-dispatch-contract';
import type { CodexOAuthV2ReviewRunnerPort } from '../../../src/codex-oauth/runtime';

jest.mock('../../../src/codex-oauth/safe-checkout', () => ({
  ...jest.requireActual('../../../src/codex-oauth/safe-checkout'),
  safeCheckoutRepository: jest.fn(),
}));
jest.mock('../../../src/codex-oauth/ocr-managed-bootstrap', () => ({
  ...jest.requireActual('../../../src/codex-oauth/ocr-managed-bootstrap'),
  resolveApprovedOcrBinary: jest.fn(),
  prepareOcrManagedRun: jest.fn(),
}));

describe('one admitted prepared model bootstrap', () => {
  const originalEnv = process.env;
  const head = 'a'.repeat(40),
    mergeBase = 'b'.repeat(40);
  let fixture: string;
  const profile = {
    agentKind: 'ocr',
    profileRef: 'ocr-unified-fixture',
    binarySha256: 'c'.repeat(64),
    packageVersion: '1.13.1-rr.5',
    cancellation: true,
    contextGateway: false,
    modelTransports: ['provider_api'],
    reviewSkillsVersion: 1,
  };
  const profileJson = JSON.stringify(profile);
  const cap = () => ({
    extensionId: 'review-model-dispatch.v2',
    version: 2,
    routeIdentityHash: 'd'.repeat(64),
    transport: 'runner_local_responses',
    wireProtocol: 'codex-responses',
    outputTokenLimit: 'terminal_acceptance',
    providerIndex: 0,
    model: 'gpt-5.4',
    deadline: new Date(Date.now() + 600_000).toISOString(),
    maxRequests: 32,
    maxConcurrentRequests: 1,
    maxRequestBytes: 98304,
    maxResponseBytes: 32768,
    maxOutputTokens: 4096,
  });
  const runtime = () => ({
    protocolVersion: 1,
    configVersion: 7,
    runtimeEnv: {
      REVIEW_AUTH_MODE: 'codex-oauth',
      CODEX_MODEL: 'gpt-5.4',
      REVIEW_PROVIDERS: 'codex/gpt-5.4',
      CODEX_REASONING_EFFORT: 'high',
      RUN_TIMEOUT_SECONDS: '600',
      REVIEW_ROUTER_AGENT_PROFILE_JSON: profileJson,
      REVIEW_ROUTER_AGENT_PROFILE_DIGEST: createHash('sha256')
        .update(profileJson)
        .digest('hex'),
      [reviewModelDispatchContract.capabilityRuntimeEnvKey]:
        JSON.stringify(cap()),
    },
  });
  const checkout = (config = runtime()) => ({
    protocolVersion: 1,
    repository: 'owner/repo',
    headSha: head,
    token: 'synthetic-read-only-token',
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    permissions: { contents: 'read', pullRequests: 'read' },
    runtimeConfig: config,
  });
  const input = () => ({
    apiUrl: 'https://api.reviewrouter.org',
    audience: 'reviewrouter',
    repository: 'owner/repo',
    pullRequestNumber: 9,
    headSha: head,
    workflowSchemaVersion: 2,
    workspacePath: path.join(fixture, 'source'),
    // These extra runtime properties simulate the rotating auth parent. They
    // must never escape through the structural input type into the OCR runner.
    codexHome: path.join(fixture, 'private-auth'),
    scmReadToken: 'old-private-scm',
    privateCredential: 'synthetic-upstream-secret',
  });
  const response = (value: unknown) =>
    new Response(JSON.stringify(value), {
      headers: { 'content-type': 'application/json' },
    });

  beforeEach(async () => {
    process.env = { ...originalEnv };
    fixture = await fs.mkdtemp('/tmp/reviewrouter-prepared-bootstrap-');
    await fs.mkdir(path.join(fixture, 'source'));
    process.env.RUNNER_TEMP = path.join(fixture, 'runtime');
    jest.spyOn(core, 'setSecret').mockImplementation(() => undefined);
    jest
      .spyOn(GitHubActionsOidcTokenProvider.prototype, 'requestToken')
      .mockResolvedValue('synthetic-oidc');
    const authorization = {
      authorizationId: 'authorization',
      authorizationToken: 'synthetic-run-token',
      facts: { headSha: head, mergeBaseSha: mergeBase, pullRequestNumber: 9 },
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
      .mocked(resolveApprovedOcrBinary)
      .mockResolvedValue({
        binaryPath: '/verified/immutable-ocr',
        cleanup: jest.fn(async () => {}),
      });
    jest
      .mocked(prepareOcrManagedRun)
      .mockResolvedValue({
        binaryPath: '/verified/immutable-ocr',
        runDirectory: '/private/ocr-run',
        homeDirectory: '/private/ocr-home',
        configPath: '/private/config',
        rulePath: '/private/rule',
        backgroundPath: '/private/background',
        cleanup: jest.fn(async () => {}),
      });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    process.env = originalEnv;
    await fs.rm(fixture, { recursive: true, force: true });
  });

  it('binds one admitted model and exact revision while withholding parent credentials from the common runner', async () => {
    const value = checkout();
    const fetchImpl = jest.fn(async () => response(value));
    const dispose = jest.fn(async () => {});
    const prepareTransport = jest.fn(async () => ({
      baseUrl: 'http://127.0.0.1:4567',
      configuration: [],
      environment: { [LOCAL_MODEL_CAPABILITY_ENV]: `Bearer ${'1'.repeat(64)}` },
      actualModel: () => 'gpt-5.4',
      failureFact: () => undefined,
      dispose,
    }));
    let workspace = '';
    const review: CodexOAuthV2ReviewRunnerPort = {
      run: jest.fn(async (request) => {
        workspace = request.workspacePath;
        expect(request).not.toHaveProperty('codexHome');
        expect(request).not.toHaveProperty('privateCredential');
        expect(request.scmReadToken).toBe(value.token);
        expect(request.preparedRoute!.runtimeConfig).toEqual(
          value.runtimeConfig
        );
        expect(request.ocr!.run.binaryPath).toBe('/verified/immutable-ocr');
        const refreshed = await request.refreshScmReadToken();
        expect(refreshed.token).toBe(value.token);
        expect(dispose).not.toHaveBeenCalled();
        return { outcome: 'completed' } as never;
      }),
    };
    await expect(
      runPreparedModelReview(input(), {
        transport: 'runner_local_responses',
        signal: new AbortController().signal,
        fetchImpl,
        prepareTransport,
        review,
      })
    ).resolves.toEqual({ outcome: 'completed' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(prepareTransport).toHaveBeenCalledTimes(1);
    expect(
      jest.mocked(resolveApprovedOcrBinary).mock.invocationCallOrder[0]
    ).toBeLessThan(prepareTransport.mock.invocationCallOrder[0]!);
    expect(safeCheckoutRepository).toHaveBeenCalledWith(
      expect.objectContaining({
        headSha: head,
        mergeBaseSha: mergeBase,
        token: value.token,
        workspacePath: workspace,
      })
    );
    expect(prepareOcrManagedRun).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5.4',
        protocol: 'openai-responses',
        rawCapability: '1'.repeat(64),
        modelReasoningEffort: 'high',
      })
    );
    expect(dispose).toHaveBeenCalledTimes(1);
    await expect(fs.access(workspace)).rejects.toThrow();
  });

  it('rejects changed configuration on SCM refresh without reselecting credentials or retrying the review', async () => {
    const value = checkout();
    const changed = {
      ...value,
      runtimeConfig: { ...value.runtimeConfig, configVersion: 8 },
    };
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(response(value))
      .mockResolvedValueOnce(response(changed));
    const dispose = jest.fn(async () => {});
    const prepareTransport = jest.fn(async () => ({
      baseUrl: 'http://127.0.0.1:4567',
      configuration: [],
      environment: { [LOCAL_MODEL_CAPABILITY_ENV]: `Bearer ${'1'.repeat(64)}` },
      actualModel: () => 'gpt-5.4',
      failureFact: () => undefined,
      dispose,
    }));
    const review = {
      run: jest.fn(async (request) => {
        await request.refreshScmReadToken();
        return {} as never;
      }),
    };
    await expect(
      runPreparedModelReview(input(), {
        transport: 'runner_local_responses',
        signal: new AbortController().signal,
        fetchImpl,
        prepareTransport,
        review,
      })
    ).rejects.toThrow('prepared_model_runtime_configuration_changed');
    expect(prepareTransport).toHaveBeenCalledTimes(1);
    expect(review.run).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('never reads a credential or checks out PR code when the immutable OCR executable cannot be verified', async () => {
    jest
      .mocked(resolveApprovedOcrBinary)
      .mockRejectedValue(new Error('review_agent_binary_drift'));
    const prepareTransport = jest.fn();
    const review = { run: jest.fn() };
    await expect(
      runPreparedModelReview(input(), {
        transport: 'runner_local_responses',
        signal: new AbortController().signal,
        fetchImpl: async () => response(checkout()),
        prepareTransport,
        review,
      })
    ).rejects.toThrow('review_agent_binary_drift');
    expect(prepareTransport).not.toHaveBeenCalled();
    expect(safeCheckoutRepository).not.toHaveBeenCalled();
    expect(review.run).not.toHaveBeenCalled();
  });
});
