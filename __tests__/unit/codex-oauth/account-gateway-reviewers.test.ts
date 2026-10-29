import { CONTEXT_TOOLS_PLAN_ENV } from '../../../src/context-tools/contract';
import { assertAccountGatewayRuntimeConfigContinuity } from '../../../src/codex-oauth/account-gateway-runtime';
import { createScmReadTokenProvider } from '../../../src/review-orchestration/infrastructure/production-t0-review-runner';
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { prepareCodexCliBeforeAuthRead } from '../../../src/codex-oauth/codex-cli';
import { resolveApprovedOcrBinary } from '../../../src/codex-oauth/ocr-managed-bootstrap';
import {
  prepareAccountGatewayReviewerSession,
  reviewerRuntimeConfig,
} from '../../../src/codex-oauth/account-gateway-reviewer-session';
import { readAdmittedGatewayCodexModelSettings } from '../../../src/control-plane/admitted-gateway-codex-model-settings';
import type { ReviewReviewerPlanReviewerV1 } from '../../../src/control-plane/generated/review-action-v2/review-reviewer-plan';
import type { AdmittedRuntimeConfig } from '../../../src/control-plane/runtime-config';

jest.mock('../../../src/codex-oauth/codex-cli', () => ({
  prepareCodexCliBeforeAuthRead: jest.fn(),
}));
jest.mock('../../../src/codex-oauth/ocr-managed-bootstrap', () => ({
  ...jest.requireActual('../../../src/codex-oauth/ocr-managed-bootstrap'),
  resolveApprovedOcrBinary: jest.fn(),
}));
jest.mock(
  '../../../src/review-investigation/infrastructure/codex-review-agent-adapter',
  () => ({
    CodexReviewAgentAdapter: jest.fn().mockImplementation(() => ({
      negotiate: jest.fn().mockResolvedValue(undefined),
    })),
  })
);

describe('isolated Gateway reviewer sessions', () => {
  let root: string;
  let cleanups: Array<() => Promise<void>>;
  beforeEach(async () => {
    root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'reviewer-session-fixture-')
    );
    cleanups = [];
    const binaryPath = path.join(root, 'codex');
    await fs.writeFile(
      binaryPath,
      '#!/bin/sh\nprintf "codex-cli 0.147.0\\n"\n',
      { mode: 0o700 }
    );
    jest
      .mocked(prepareCodexCliBeforeAuthRead)
      .mockReset()
      .mockResolvedValue({ binaryPath });
    jest.mocked(resolveApprovedOcrBinary).mockReset();
  });
  afterEach(async () => {
    await Promise.all(cleanups.map((cleanup) => cleanup()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const prepare = (reviewer: ReviewReviewerPlanReviewerV1) =>
    prepareAccountGatewayReviewerSession({
      apiUrl: 'https://api.reviewrouter.invalid',
      authorization: () => 'synthetic-run-token',
      runtimeConfig: parentRuntime(),
      reviewer,
      signal: new AbortController().signal,
      registerCleanup: (cleanup) => cleanups.push(cleanup),
      registerTransport: () => {},
    });

  it('keeps separate private homes, loopback capabilities and captured models/settings without changing global environment', async () => {
    const original = { ...process.env };
    const first = await prepare(reviewer('first', 'gpt-first', 'high'));
    const second = await prepare(reviewer('second', 'gpt-second', 'xhigh'));
    expect(first.modelTransport.baseUrl).not.toBe(
      second.modelTransport.baseUrl
    );
    expect(
      first.modelTransport.environment.REVIEWROUTER_LOCAL_MODEL_TOKEN
    ).not.toBe(
      second.modelTransport.environment.REVIEWROUTER_LOCAL_MODEL_TOKEN
    );
    expect(first.modelTransport.environment.HOME).not.toBe(
      second.modelTransport.environment.HOME
    );
    expect(first.codexHome).not.toBe(second.codexHome);
    expect(first.runtimeConfig.runtimeEnv.CODEX_MODEL).toBe('gpt-first');
    expect(second.runtimeConfig.runtimeEnv.CODEX_MODEL).toBe('gpt-second');
    expect(first.runtimeConfig.runtimeEnv.CODEX_REASONING_EFFORT).toBe('high');
    expect(second.runtimeConfig.runtimeEnv.CODEX_REASONING_EFFORT).toBe(
      'xhigh'
    );
    expect(
      readAdmittedGatewayCodexModelSettings(first.runtimeConfig, 'gpt-first')
        ?.model
    ).toBe('gpt-first');
    expect(
      readAdmittedGatewayCodexModelSettings(second.runtimeConfig, 'gpt-second')
        ?.model
    ).toBe('gpt-second');
    for (const session of [first, second]) {
      expect(
        (await fs.stat(session.modelTransport.environment.HOME!)).mode & 0o777
      ).toBe(0o700);
      expect((await fs.stat(session.codexHome!)).mode & 0o777).toBe(0o700);
      expect(
        (await fs.stat(path.join(session.codexHome!, 'config.toml'))).mode &
          0o777
      ).toBe(0o600);
    }
    expect(process.env).toEqual(original);
    await cleanups[0]();
    expect((await fs.stat(second.codexHome!)).isDirectory()).toBe(true);
    expect(second.modelTransport.failureFact()).toBeUndefined();
  });

  it('retains the exact reviewer when its engine bootstrap fails and cleans only local resources', async () => {
    jest
      .mocked(prepareCodexCliBeforeAuthRead)
      .mockRejectedValueOnce(new Error('synthetic-install-failure'));
    const selected = reviewer('primary', 'captured-model', 'high');
    const session = await prepare(selected);
    expect(session.bootstrapFailure).toBe(true);
    expect(session.reviewer).toBe(selected);
    expect(session.runtimeConfig.runtimeEnv.CODEX_MODEL).toBe('captured-model');
    expect(session.codexBinaryPath).toBeUndefined();
    const sibling = await prepare(reviewer('sibling', 'other-model', 'xhigh'));
    expect(sibling.bootstrapFailure).toBeUndefined();
    await cleanups[0]();
    expect((await fs.stat(sibling.codexHome!)).isDirectory()).toBe(true);
  });

  it('dispatches an unavailable captured OCR engine without installing or substituting Codex', async () => {
    jest
      .mocked(resolveApprovedOcrBinary)
      .mockRejectedValueOnce(new Error('synthetic-ocr-unavailable'));
    const selected = reviewer('ocr-primary', 'ocr-model', 'high');
    const agentProfile = {
      ...selected.agentProfile,
      agentKind: 'ocr' as const,
      contextGateway: false as const,
      modelTransports: ['account_gateway'] as const,
    };
    const session = await prepare({
      ...selected,
      agentProfile,
      agentProfileDigest: digest(canonicalJson(agentProfile)),
    });
    expect(session.bootstrapFailure).toBe(true);
    expect(session.reviewer.agentProfile.agentKind).toBe('ocr');
    expect(prepareCodexCliBeforeAuthRead).not.toHaveBeenCalled();
  });

  it.each(['allocation_unavailable', 'model_settings_unavailable'] as const)(
    'settles captured %s before any child binary effect',
    async (unavailableReason) => {
      const selected = {
        ...reviewer('unavailable', 'captured-model', 'high'),
        unavailableReason,
      };
      const session = await prepare(selected);
      expect(session.bootstrapFailure).toBe(true);
      expect(session.reviewer).toBe(selected);
      expect(prepareCodexCliBeforeAuthRead).not.toHaveBeenCalled();
      expect(resolveApprovedOcrBinary).not.toHaveBeenCalled();
    }
  );

  it('refreshes SCM access after a sibling allocation is revoked while preserving the original reviewer plan', async () => {
    const first = reviewer('first', 'first-model', 'high');
    const sibling = {
      ...reviewer('sibling', 'sibling-model', 'xhigh'),
      providerIndex: 1,
    };
    const initialPlan = {
      planVersion: 1,
      primaryReviewerId: first.reviewerId,
      maxParallelReviewers: 2,
      inlineMinAgreement: 2,
      reviewers: [first, sibling],
      concurrencyGroups: [
        { concurrencyGroupId: 'shared-account', maxParallel: 2 },
      ],
    };
    const initial: AdmittedRuntimeConfig = {
      ...parentRuntime(),
      runtimeEnv: {
        ...parentRuntime().runtimeEnv,
        REVIEW_ROUTER_REVIEWER_PLAN_JSON: JSON.stringify(initialPlan),
      },
    };
    const { modelSettings: _settings, ...revokedSibling } = sibling;
    const changedPlan = {
      ...initialPlan,
      reviewers: [
        first,
        { ...revokedSibling, unavailableReason: 'allocation_unavailable' },
      ],
    };
    const current: AdmittedRuntimeConfig = {
      ...initial,
      runtimeEnv: {
        ...initial.runtimeEnv,
        REVIEW_ROUTER_REVIEWER_PLAN_JSON: JSON.stringify(changedPlan),
      },
    };
    const refresh = jest.fn(async () => {
      assertAccountGatewayRuntimeConfigContinuity(initial, current);
      return {
        token: 'refreshed-scm-token',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      };
    });
    const provider = createScmReadTokenProvider({
      token: 'expiring-scm-token',
      expiresAt: new Date(Date.now() + 1000).toISOString(),
      refresh,
    });
    expect(await provider.getToken()).toBe('refreshed-scm-token');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(initial.runtimeEnv.REVIEW_ROUTER_REVIEWER_PLAN_JSON).toBe(
      JSON.stringify(initialPlan)
    );
    expect(initialPlan.reviewers[1]).toHaveProperty('modelSettings');
    for (const changedReviewer of [
      { ...sibling, requestedModel: 'another-model', modelSettings: undefined },
      { ...sibling, reasoningEffort: 'medium' },
      {
        ...sibling,
        modelSettings: { ...sibling.modelSettings!, reasoning: null },
      },
      { ...sibling, concurrencyGroupId: 'foreign-group' },
    ]) {
      expect(() =>
        assertAccountGatewayRuntimeConfigContinuity(initial, {
          ...current,
          runtimeEnv: {
            ...current.runtimeEnv,
            REVIEW_ROUTER_REVIEWER_PLAN_JSON: JSON.stringify({
              ...initialPlan,
              reviewers: [first, changedReviewer],
            }),
          },
        })
      ).toThrow();
    }
  });

  it('does not resurrect an initially unavailable reviewer when later checkout reports availability', () => {
    const selected = reviewer('primary', 'captured-model', 'high');
    const { modelSettings, ...missing } = selected;
    const plan = {
      planVersion: 1,
      primaryReviewerId: selected.reviewerId,
      maxParallelReviewers: 1,
      inlineMinAgreement: 1,
      reviewers: [
        { ...missing, unavailableReason: 'model_settings_unavailable' },
      ],
      concurrencyGroups: [
        { concurrencyGroupId: 'shared-account', maxParallel: 1 },
      ],
    };
    const runtime = parentRuntime();
    const initial: AdmittedRuntimeConfig = {
      ...runtime,
      runtimeEnv: {
        ...runtime.runtimeEnv,
        REVIEW_ROUTER_REVIEWER_PLAN_JSON: JSON.stringify(plan),
      },
    };
    const recovered: AdmittedRuntimeConfig = {
      ...initial,
      runtimeEnv: {
        ...initial.runtimeEnv,
        REVIEW_ROUTER_REVIEWER_PLAN_JSON: JSON.stringify({
          ...plan,
          reviewers: [{ ...missing, modelSettings }],
        }),
      },
    };
    assertAccountGatewayRuntimeConfigContinuity(initial, recovered);
    expect(
      JSON.parse(initial.runtimeEnv.REVIEW_ROUTER_REVIEWER_PLAN_JSON!)
        .reviewers[0].unavailableReason
    ).toBe('model_settings_unavailable');
  });

  it('projects captured native context tools only into OCR children of a mixed roster', () => {
    const parent = parentRuntime();
    const shared = {
      ...parent,
      runtimeEnv: {
        ...parent.runtimeEnv,
        [CONTEXT_TOOLS_PLAN_ENV]: 'captured-immutable-plan',
      },
    };
    const codex = reviewer('codex', 'codex-model', 'high');
    const ocr = {
      ...reviewer('ocr', 'ocr-model', 'high'),
      agentProfile: {
        ...codex.agentProfile,
        agentKind: 'ocr' as const,
        contextGateway: false as const,
      },
    };
    expect(
      reviewerRuntimeConfig(shared, codex).runtimeEnv[CONTEXT_TOOLS_PLAN_ENV]
    ).toBeUndefined();
    expect(
      reviewerRuntimeConfig(shared, ocr).runtimeEnv[CONTEXT_TOOLS_PLAN_ENV]
    ).toBe('captured-immutable-plan');
    expect(shared.runtimeEnv[CONTEXT_TOOLS_PLAN_ENV]).toBe(
      'captured-immutable-plan'
    );
  });

  it('removes a primary reasoning/model-settings value when a sibling has no such captured setting', () => {
    const selected = reviewer('no-reasoning', 'plain-model', 'high');
    const {
      reasoningEffort: _effort,
      modelSettings: _settings,
      ...plain
    } = selected;
    const runtime = reviewerRuntimeConfig(parentRuntime(), plain);
    expect(runtime.runtimeEnv.CODEX_REASONING_EFFORT).toBeUndefined();
    expect(
      runtime.runtimeEnv.REVIEW_ROUTER_GATEWAY_MODEL_SETTINGS_JSON
    ).toBeUndefined();
    expect(runtime.runtimeEnv.CODEX_MODEL).toBe('plain-model');
  });
});

function reviewer(
  reviewerId: string,
  model: string,
  effort: 'high' | 'xhigh'
): ReviewReviewerPlanReviewerV1 {
  const agentProfile = {
    profileRef: 'codex-qualified-v1',
    agentKind: 'codex' as const,
    binarySha256: 'a'.repeat(64),
    packageVersion: '0.147.0',
    modelTransports: ['account_gateway'] as const,
    contextGateway: true as const,
    cancellation: true as const,
  };
  return {
    reviewerId,
    providerIndex: 0,
    providerVoteIdentityHash: digest(reviewerId),
    required: true,
    transport: 'account_gateway',
    requestedModel: model,
    reasoningEffort: effort,
    agenticContext: true,
    fastMode: false,
    modelSettings: {
      model,
      reasoning: { allowed: ['high', 'xhigh'], default: 'high' },
    },
    agentProfile,
    agentProfileDigest: digest(canonicalJson(agentProfile)),
    concurrencyGroupId: 'shared-account',
    investigationGrant: null,
  };
}
function parentRuntime(): AdmittedRuntimeConfig {
  const primary = reviewer('parent', 'parent-model', 'high');
  return {
    protocolVersion: 1,
    configVersion: 1,
    runtimeEnv: {
      REVIEW_AUTH_MODE: 'codex-account-gateway',
      CODEX_MODEL: 'parent-model',
      CODEX_REASONING_EFFORT: 'high',
      REVIEW_ROUTER_GATEWAY_MODEL_SETTINGS_JSON: JSON.stringify(
        primary.modelSettings
      ),
      REVIEW_ROUTER_AGENT_PROFILE_JSON: canonicalJson(primary.agentProfile),
      REVIEW_ROUTER_AGENT_PROFILE_DIGEST: primary.agentProfileDigest,
    },
  };
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
      )
      .join(',')}}`;
  return JSON.stringify(value);
}
function digest(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
