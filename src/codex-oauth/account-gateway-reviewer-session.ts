import { CONTEXT_TOOLS_PLAN_ENV } from '../context-tools/contract';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as core from '../actions/core';
import type { AdmittedRuntimeConfig } from '../control-plane/runtime-config';
import type { ReviewReviewerPlanReviewerV1 } from '../control-plane/generated/review-action-v2/review-reviewer-plan';
import {
  readApprovedReviewAgent,
  assertApprovedReviewAgentVersion,
} from '../control-plane/approved-review-agent';
import {
  AccountGatewayModelTransport,
  startLocalGatewayModelTransport,
  ACCOUNT_GATEWAY_BOUNDS,
  LOCAL_MODEL_CAPABILITY_ENV,
  type LocalGatewayModelTransport,
  type GatewayTransportDiagnostic,
} from '../review-orchestration/infrastructure/account-gateway-model-transport';
import { extractRawLoopbackCapability } from '../review-orchestration/infrastructure/ocr-review-managed-run';
import {
  prepareOcrManagedRun,
  readApprovedOcrReviewAgent,
  resolveApprovedOcrBinary,
  type OcrManagedRunHandle,
} from './ocr-managed-bootstrap';
import {
  prepareCodexCliBeforeAuthRead,
  type PreparedCodexCli,
} from './codex-cli';
import { CodexReviewAgentAdapter } from '../review-investigation/infrastructure/codex-review-agent-adapter';
import { NodeReviewAgentProcessRunner } from '../review-investigation/infrastructure/review-agent-process-runner';
import {
  ReviewAgentProviderKind,
  ReviewAgentExecutionProfile,
  ReviewAgentConfinementStrength,
} from '../review-investigation/domain/runtime-profile';

export type AccountGatewayReviewerRuntime = Readonly<{
  reviewer: ReviewReviewerPlanReviewerV1;
  runtimeConfig: AdmittedRuntimeConfig;
  modelTransport: LocalGatewayModelTransport;
  bootstrapFailure?: true;
  codexHome?: string;
  codexBinaryPath?: string;
  ocr?: Readonly<{
    run: OcrManagedRunHandle;
    effectFacts: () => Readonly<{ effect: string }> | undefined;
  }>;
}>;

/** Safe captured policy is projected into a child's existing runtime contract.
 * Parent configuration is immutable; no child writes process.env. */
export function reviewerRuntimeConfig(
  parent: AdmittedRuntimeConfig,
  reviewer: ReviewReviewerPlanReviewerV1
): AdmittedRuntimeConfig {
  const runtimeEnv = { ...parent.runtimeEnv };
  // Captured native context tools are an OCR capability. Other engines keep
  // their own Context Gateway contract and cannot borrow the OCR selection.
  if (reviewer.agentProfile.agentKind !== 'ocr')
    delete runtimeEnv[CONTEXT_TOOLS_PLAN_ENV];
  delete runtimeEnv.CODEX_REASONING_EFFORT;
  delete runtimeEnv.REVIEW_ROUTER_GATEWAY_MODEL_SETTINGS_JSON;
  runtimeEnv.CODEX_MODEL = reviewer.requestedModel;
  runtimeEnv.REVIEW_PROVIDERS = `${reviewer.agentProfile.agentKind === 'ocr' ? 'ocr' : 'codex'}/${reviewer.requestedModel}`;
  runtimeEnv.CODEX_AGENTIC_CONTEXT = String(reviewer.agenticContext);
  runtimeEnv.CODEX_FAST_MODE = String(reviewer.fastMode);
  if (reviewer.reasoningEffort)
    runtimeEnv.CODEX_REASONING_EFFORT = reviewer.reasoningEffort;
  if (reviewer.modelSettings)
    runtimeEnv.REVIEW_ROUTER_GATEWAY_MODEL_SETTINGS_JSON = JSON.stringify(
      reviewer.modelSettings
    );
  // The digest belongs to canonical profile bytes, not object insertion order.
  runtimeEnv.REVIEW_ROUTER_AGENT_PROFILE_JSON = canonicalJson(
    reviewer.agentProfile
  );
  runtimeEnv.REVIEW_ROUTER_AGENT_PROFILE_DIGEST = reviewer.agentProfileDigest;
  return Object.freeze({ ...parent, runtimeEnv: Object.freeze(runtimeEnv) });
}

export async function prepareAccountGatewayReviewerSession(input: {
  apiUrl: string;
  authorization: () => string;
  runtimeConfig: AdmittedRuntimeConfig;
  reviewer: ReviewReviewerPlanReviewerV1;
  signal: AbortSignal;
  registerCleanup: (cleanup: () => Promise<void>) => void;
  registerTransport: (transport: AccountGatewayModelTransport) => void;
}): Promise<AccountGatewayReviewerRuntime> {
  const { reviewer, signal } = input;
  const runtimeConfig = reviewerRuntimeConfig(input.runtimeConfig, reviewer);
  const observeTransport = (diagnostic: GatewayTransportDiagnostic) =>
    core.warning(
      `Account gateway reviewer model transport: ${JSON.stringify({
        reviewerId: reviewer.reviewerId,
        ...diagnostic,
      })}`
    );
  const transport = new AccountGatewayModelTransport(
    input.apiUrl,
    input.authorization,
    observeTransport,
    undefined,
    false,
    undefined,
    undefined,
    reviewer.reviewerId
  );
  input.registerTransport(transport);
  signal.throwIfAborted();
  const bridge = await startLocalGatewayModelTransport(
    transport,
    observeTransport
  );
  let privateHome: string | undefined;
  let cli: PreparedCodexCli | undefined;
  let ocrRun: OcrManagedRunHandle | undefined;
  let ocrBinary:
    | Awaited<ReturnType<typeof resolveApprovedOcrBinary>>
    | undefined;
  input.registerCleanup(async () => {
    // This is local process/materialization cleanup. Only the parent closes
    // authorization allocations, after aggregate publication has settled.
    transport.cancelInference();
    const operations = [
      () => bridge?.dispose(),
      () => ocrRun?.cleanup(),
      () => ocrBinary?.cleanup(),
      () =>
        privateHome
          ? fs.rm(privateHome, { recursive: true, force: true })
          : undefined,
      () => cli?.clear?.(),
    ];
    const settled = await Promise.allSettled(
      operations.map((operation) => Promise.resolve().then(operation))
    );
    if (settled.some((result) => result.status === 'rejected'))
      throw new Error('account_gateway_child_cleanup_failed');
  });
  signal.throwIfAborted();
  try {
    if (
      'unavailableReason' in reviewer &&
      reviewer.unavailableReason !== undefined
    )
      throw new Error('account_gateway_captured_reviewer_unavailable');
    const profileJson =
      runtimeConfig.runtimeEnv.REVIEW_ROUTER_AGENT_PROFILE_JSON!;
    const profileDigest =
      runtimeConfig.runtimeEnv.REVIEW_ROUTER_AGENT_PROFILE_DIGEST!;
    if (reviewer.agentProfile.agentKind === 'ocr') {
      const approvedAgent = readApprovedOcrReviewAgent(
        profileJson,
        profileDigest
      );
      ocrBinary = await resolveApprovedOcrBinary({ approvedAgent, signal });
      ocrRun = await prepareOcrManagedRun({
        approvedAgent,
        baseUrl: bridge.baseUrl,
        rawCapability: extractRawLoopbackCapability(
          bridge.environment[LOCAL_MODEL_CAPABILITY_ENV] ?? ''
        ),
        model: reviewer.requestedModel,
        requestTimeoutSec: ACCOUNT_GATEWAY_BOUNDS.requestMs / 1000,
        modelReasoningEffort: reviewer.reasoningEffort ?? null,
        admittedRuntimeConfig: runtimeConfig,
        language: runtimeConfig.runtimeEnv.REVIEW_OUTPUT_LANGUAGE ?? null,
        signal,
        env: { ...process.env, REVIEWROUTER_OCR_BINARY: ocrBinary.binaryPath },
      });
      return Object.freeze({
        reviewer,
        runtimeConfig,
        modelTransport: bridge,
        ocr: {
          run: ocrRun,
          effectFacts: () =>
            transport.lastFailure
              ? { effect: transport.lastFailure.effect }
              : undefined,
        },
      });
    }
    const approvedAgent = readApprovedReviewAgent(profileJson, profileDigest);
    if (approvedAgent.agentKind !== 'codex')
      throw new Error('review_action_v2_reviewer_engine_unsupported');
    cli = await prepareCodexCliBeforeAuthRead({
      signal,
      approvedAgent,
      logger: { info: core.info, warn: core.warning },
    });
    const version = await promisify(execFile)(cli.binaryPath, ['--version'], {
      signal,
      killSignal: 'SIGKILL',
      timeout: 10_000,
      maxBuffer: 16_384,
      env: { PATH: process.env.PATH, HOME: os.tmpdir() },
    });
    assertApprovedReviewAgentVersion(
      approvedAgent,
      version.stdout.trim().replace(/^codex-cli /, '')
    );
    await new CodexReviewAgentAdapter(new NodeReviewAgentProcessRunner(), {
      binary: cli.binaryPath,
      executionSessions: {
        resolve: () => {
          throw new Error('review_agent_precheckout_session_unavailable');
        },
      },
    }).negotiate({
      providerKind: ReviewAgentProviderKind.Codex,
      executionProfile: ReviewAgentExecutionProfile.GatewayAttestedAgentV1,
      minimumConfinement: ReviewAgentConfinementStrength.GatewayOnly,
      requireActualModelAttribution: true,
      requireUsageAttribution: true,
      requireFencedCancellation: true,
      minimumMaxTurns: 1,
    });
    privateHome = await fs.mkdtemp(
      path.join(
        process.env.RUNNER_TEMP || os.tmpdir(),
        'reviewrouter-reviewer-'
      )
    );
    await fs.chmod(privateHome, 0o700);
    const codexHome = path.join(privateHome, '.codex');
    await fs.mkdir(codexHome, { mode: 0o700 });
    await fs.writeFile(
      path.join(codexHome, 'config.toml'),
      bridge.configuration.join('\n') + '\n',
      { mode: 0o600 }
    );
    return Object.freeze({
      reviewer,
      runtimeConfig,
      codexHome,
      codexBinaryPath: cli.binaryPath,
      modelTransport: {
        ...bridge,
        environment: Object.freeze({
          ...bridge.environment,
          HOME: privateHome,
          CODEX_HOME: codexHome,
        }),
      },
    });
  } catch {
    signal.throwIfAborted();
    core.warning(
      'Account gateway reviewer engine is unavailable; its review coverage will be incomplete.'
    );
    return Object.freeze({
      reviewer,
      runtimeConfig,
      modelTransport: bridge,
      bootstrapFailure: true as const,
    });
  }
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
