import {
  parseAdmittedRuntimeConfig,
  type AdmittedRuntimeConfig,
} from '../control-plane/runtime-config';
import {
  readApprovedReviewAgent,
  assertApprovedReviewAgentVersion,
} from '../control-plane/approved-review-agent';
import { execFile } from 'child_process';
import * as core from '../actions/core';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ReviewActionV2Client } from '../control-plane/review-action-v2-client';
import { ReviewActionV2ControlPlaneAdapter } from '../review-orchestration/infrastructure/review-action-v2-control-plane-adapter';
import {
  AccountGatewayModelTransport,
  createAccountGatewayRunFetch,
  startLocalGatewayModelTransport,
  ACCOUNT_GATEWAY_BOUNDS,
  LOCAL_MODEL_CAPABILITY_ENV,
  type AccountGatewayCheckoutRequest,
  type GatewayCloseReason,
  type GatewayReadback,
  type GatewayFailureFact,
  type LocalGatewayModelTransport,
  type GatewayTransportDiagnostic,
} from '../review-orchestration/infrastructure/account-gateway-model-transport';
import {
  prepareOcrManagedRun,
  readApprovedOcrReviewAgent,
  readApprovedReviewAgentKind,
  resolveApprovedOcrBinary,
  type ApprovedOcrReviewAgent,
  type OcrManagedRunHandle,
} from './ocr-managed-bootstrap';
import { extractRawLoopbackCapability } from '../review-orchestration/infrastructure/ocr-review-managed-run';
import { GitHubActionsOidcTokenProvider } from './github-actions-oidc';
import { CodexReviewAgentAdapter } from '../review-investigation/infrastructure/codex-review-agent-adapter';
import { NodeReviewAgentProcessRunner } from '../review-investigation/infrastructure/review-agent-process-runner';
import {
  ReviewAgentProviderKind,
  ReviewAgentExecutionProfile,
  ReviewAgentConfinementStrength,
} from '../review-investigation/domain/runtime-profile';
import {
  prepareCodexCliBeforeAuthRead,
  type PreparedCodexCli,
} from './codex-cli';
import {
  createIsolatedCheckoutWorkspace,
  safeCheckoutRepository,
} from './safe-checkout';
import {
  clearCodexRotatingProcessAuthEnv,
  clearCodexRotatingOidcRequestEnv,
  clearCodexRotatingProviderSecretEnv,
} from './auth-input';
import {
  CodexOAuthV2ReviewOutcome,
  type CodexOAuthRuntimeInputs,
  type CodexOAuthV2ReviewResult,
  type CodexOAuthV2ReviewRunnerPort,
} from './runtime';

export const ACCOUNT_GATEWAY_ACTION_MODE = 'account-gateway';

/** Explicit required backend companion seam. POST /account-gateway/checkout,
 * explicit selectors, bearer=current ReviewActionV2 authorization. No job header authority. */
export type { AccountGatewayCheckoutRequest } from '../review-orchestration/infrastructure/account-gateway-model-transport';
export type AccountGatewayCheckoutCapability = Readonly<{
  protocolVersion: 1;
  repository: string;
  headSha: string;
  token: string;
  expiresAt: string;
  permissions: Readonly<{ contents: 'read'; pullRequests: 'read' }>;
  runtimeConfig: AdmittedRuntimeConfig;
}>;

/** Reuses existing v2 admission/renewal, isolated checkout and prepared CLI.
 * There is no prelease, upstream auth read/refresh or credential writeback. */
export async function runAccountGatewayRuntime(
  input: CodexOAuthRuntimeInputs,
  ports: Parameters<typeof runAccountGatewayRuntimeInternal>[1]
): Promise<void> {
  try {
    await runAccountGatewayRuntimeInternal(input, ports);
  } finally {
    try {
      clearCodexRotatingOidcRequestEnv();
    } finally {
      clearCodexRotatingProcessAuthEnv();
    }
  }
}

async function runAccountGatewayRuntimeInternal(
  input: CodexOAuthRuntimeInputs,
  ports: {
    readonly review: CodexOAuthV2ReviewRunnerPort;
    readonly fetchImpl?: typeof fetch;
    readonly terminalReview: (
      review: CodexOAuthV2ReviewResult,
      signal: AbortSignal
    ) => Promise<void>;
    readonly terminalFailure: (
      error: unknown,
      context: Readonly<{ authorized: boolean }>
    ) => Promise<void>;
    readonly observeClose: (result: GatewayReadback) => void;
    readonly observeRelay: (fact: GatewayFailureFact | undefined) => void;
    readonly observeReadback: (
      requestRef: string,
      result: GatewayReadback
    ) => void;
  }
): Promise<void> {
  clearCodexRotatingProviderSecretEnv();
  clearCodexRotatingProcessAuthEnv();
  const run = new AbortController();
  const fetchImpl = createAccountGatewayRunFetch(
    ports.fetchImpl ?? fetch,
    run.signal
  );
  const controlPlane = new ReviewActionV2ControlPlaneAdapter(
    new ReviewActionV2Client({
      apiUrl: input.apiUrl,
      fetchImpl,
    })
  );
  const observeTransport = (diagnostic: GatewayTransportDiagnostic) =>
    core.warning(
      `Account gateway model transport: ${JSON.stringify(diagnostic)}`
    );
  const transport = new AccountGatewayModelTransport(
    input.apiUrl,
    () => controlPlane.currentAuthorization().authorizationToken,
    observeTransport
  );
  let phase:
    | 'authorization'
    | 'checkout_capability'
    | 'create_workspace'
    | 'checkout'
    | 'prepare_cli'
    | 'version'
    | 'negotiate'
    | 'local_transport'
    | 'runner'
    | 'terminal' = 'authorization';
  let authorized = false;
  let failed = false;
  let workspacePath: string | undefined;
  let codexHome: string | undefined;
  let cli: PreparedCodexCli | undefined;
  let bridge: LocalGatewayModelTransport | undefined;
  let ocrRun: OcrManagedRunHandle | undefined;
  let ocrBinary:
    | Awaited<ReturnType<typeof resolveApprovedOcrBinary>>
    | undefined;
  let reason: GatewayCloseReason = 'failed';
  const onSignal = () => {
    reason = 'cancelled';
    run.abort(new Error('account_gateway_cancelled'));
    transport.cancelInference();
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  try {
    const oidc = new GitHubActionsOidcTokenProvider({
      fetchImpl,
    });
    const authorization = await controlPlane.authorize({
      oidcToken: await oidc.requestToken(input.audience),
    });
    authorized = true;
    if (
      authorization.facts.headSha !== input.headSha.toLowerCase() ||
      authorization.facts.pullRequestNumber !== input.pullRequestNumber
    )
      throw new Error('account_gateway_authorization_input_mismatch');
    let admittedRuntimeConfig: AdmittedRuntimeConfig | undefined;
    const readCapability =
      async (): Promise<AccountGatewayCheckoutCapability> => {
        const request: AccountGatewayCheckoutRequest = {
          providerInstanceId: input.providerInstanceId,
          workflowSchemaVersion: input.workflowSchemaVersion,
        };
        run.signal.throwIfAborted();
        const result = await transport.checkoutCapability(request, run.signal);
        run.signal.throwIfAborted();
        const capability = validateAccountGatewayCheckout(
          result,
          input.repository,
          authorization.facts.headSha
        );
        if (admittedRuntimeConfig) {
          const canonicalEnv = (config: AdmittedRuntimeConfig) =>
            JSON.stringify(
              Object.entries(config.runtimeEnv).sort(([a], [b]) =>
                a < b ? -1 : a > b ? 1 : 0
              )
            );
          if (
            capability.runtimeConfig.configVersion !==
              admittedRuntimeConfig.configVersion ||
            canonicalEnv(capability.runtimeConfig) !==
              canonicalEnv(admittedRuntimeConfig)
          ) {
            throw new Error('account_gateway_runtime_config_changed');
          }
        } else {
          admittedRuntimeConfig = capability.runtimeConfig;
        }
        return capability;
      };
    phase = 'checkout_capability';
    const capability = await readCapability();
    run.signal.throwIfAborted();
    const agentProfileJson =
      capability.runtimeConfig.runtimeEnv.REVIEW_ROUTER_AGENT_PROFILE_JSON!;
    const agentProfileDigest =
      capability.runtimeConfig.runtimeEnv.REVIEW_ROUTER_AGENT_PROFILE_DIGEST!;
    // Captured agentKind decides the engine before any CLI effect (plan 56 §5.2).
    const agentKind = readApprovedReviewAgentKind(
      agentProfileJson,
      agentProfileDigest
    );
    let ocrAgent: ApprovedOcrReviewAgent | undefined;
    if (agentKind === 'ocr') {
      // OCR dispatch happens before phase=prepare_cli: no Codex install,
      // probe, negotiate, health check or exec exists on this path.
      ocrAgent = readApprovedOcrReviewAgent(
        agentProfileJson,
        agentProfileDigest
      );
      ocrBinary = await resolveApprovedOcrBinary({
        approvedAgent: ocrAgent,
        signal: run.signal,
      });
    } else {
      const agentProfile = readApprovedReviewAgent(
        agentProfileJson,
        agentProfileDigest
      );
      phase = 'prepare_cli';
      cli = await prepareCodexCliBeforeAuthRead({
        signal: run.signal,
        approvedAgent: agentProfile,
        logger: { info: core.info, warn: core.warning },
      });
      // A binary-only version check; alternate installed versions do not inherit retry qualification.
      phase = 'version';
      const version = await promisify(execFile)(cli.binaryPath, ['--version'], {
        signal: run.signal,
        killSignal: 'SIGKILL',
        timeout: 10_000,
        maxBuffer: 16_384,
        env: { PATH: process.env.PATH, HOME: os.tmpdir() },
      });
      assertApprovedReviewAgentVersion(
        agentProfile,
        version.stdout.trim().replace(/^codex-cli /, '')
      );
      phase = 'negotiate';
      // Use the execution adapter's existing capability contract. No PR session
      // exists yet: negotiation must not resolve one or launch an agent turn.
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
    }
    run.signal.throwIfAborted();
    phase = 'create_workspace';
    workspacePath = await createIsolatedCheckoutWorkspace({
      runnerTempPath: process.env.RUNNER_TEMP,
      githubWorkspacePath: input.workspacePath,
    });
    phase = 'checkout';
    await safeCheckoutRepository({
      repository: capability.repository,
      headSha: capability.headSha,
      ...(ocrAgent ? { mergeBaseSha: authorization.facts.mergeBaseSha } : {}),
      workspacePath,
      token: capability.token,
      signal: run.signal,
    });
    run.signal.throwIfAborted();
    phase = 'local_transport';
    bridge = await startLocalGatewayModelTransport(transport, observeTransport);
    if (ocrAgent) {
      // Managed OCR run layout (§5.2): private run dir, HOME 0700 and
      // HOME/.opencodereview/config.json 0600 with the controlled provider.
      const model = capability.runtimeConfig.runtimeEnv.CODEX_MODEL;
      if (!model) throw new Error('review_action_v2_ocr_model_missing');
      ocrRun = await prepareOcrManagedRun({
        approvedAgent: ocrAgent,
        baseUrl: bridge.baseUrl,
        rawCapability: extractRawLoopbackCapability(
          bridge.environment[LOCAL_MODEL_CAPABILITY_ENV] ?? ''
        ),
        model,
        requestTimeoutSec: ACCOUNT_GATEWAY_BOUNDS.requestMs / 1000,
        modelReasoningEffort:
          capability.runtimeConfig.runtimeEnv.CODEX_REASONING_EFFORT ?? null,
        language:
          capability.runtimeConfig.runtimeEnv.REVIEW_OUTPUT_LANGUAGE ?? null,
        signal: run.signal,
        env: {
          ...process.env,
          REVIEWROUTER_OCR_BINARY: ocrBinary!.binaryPath,
        },
      });
    } else {
      codexHome = await fs.mkdtemp(
        path.join(
          process.env.RUNNER_TEMP || os.tmpdir(),
          'reviewrouter-keyless-codex-'
        )
      );
      await fs.chmod(codexHome, 0o700);
      // App-server uses generated isolated config; exec also receives pinned -c values.
      // Empty fresh home; never auth.json, including dummy credentials.
      await fs.writeFile(
        path.join(codexHome, 'config.toml'),
        bridge.configuration.join('\n') + '\n',
        { mode: 0o600 }
      );
    }
    run.signal.throwIfAborted();
    phase = 'runner';
    const review = await ports.review.run({
      ...input,
      repository: capability.repository,
      headSha: capability.headSha,
      workspacePath,
      ...(codexHome ? { codexHome } : {}),
      ...(cli ? { codexBinaryPath: cli.binaryPath } : {}),
      scmReadToken: capability.token,
      scmReadTokenExpiresAt: capability.expiresAt,
      refreshScmReadToken: readCapability,
      accountGateway: {
        runtimeConfig: capability.runtimeConfig,
        controlPlane,
        modelTransport:
          codexHome !== undefined
            ? {
                ...bridge,
                environment: Object.freeze({
                  ...bridge.environment,
                  CODEX_HOME: codexHome,
                }),
              }
            : bridge,
        signal: run.signal,
      },
      ...(ocrRun
        ? {
            ocr: {
              run: ocrRun,
              effectFacts: (): Readonly<{ effect: string }> | undefined => {
                const failure = transport.lastFailure;
                return failure ? { effect: failure.effect } : undefined;
              },
            },
          }
        : {}),
    });
    phase = 'terminal';
    // Runner has awaited App publication. Terminal status/advisory finishes before close.
    ports.observeRelay(transport.lastFailure);
    run.signal.throwIfAborted();
    await ports.terminalReview(review, run.signal);
    run.signal.throwIfAborted();
    reason =
      review.outcome === CodexOAuthV2ReviewOutcome.Cancelled ||
      review.outcome === CodexOAuthV2ReviewOutcome.Superseded
        ? 'cancelled'
        : review.outcome === CodexOAuthV2ReviewOutcome.Completed
          ? 'completed'
          : 'failed';
  } catch (error) {
    failed = true;
    // Closed stage only: errors may contain credentials, argv or provider output.
    core.warning(`Account gateway runtime failed: phase=${phase}`);
    ports.observeRelay(transport.lastFailure);
    await ports.terminalFailure(
      run.signal.aborted ? run.signal.reason : error,
      { authorized }
    );
  } finally {
    transport.cancelInference();
    // Every post-authorization exit (bootstrap failure/early return included).
    try {
      if (authorized) {
        // A bounded safe read, never recovery/replay. Absence/error is unknown.
        const requestRef = transport.lastRequestRef;
        try {
          if (requestRef)
            ports.observeReadback(
              requestRef,
              await transport.readRequest(requestRef).catch(() => ({
                httpStatus: 0,
                value: { effect: 'effect_unknown' },
              }))
            );
        } finally {
          ports.observeClose(await transport.close(reason));
        }
      }
    } catch {
      core.warning('Gateway cleanup reporting failed; outcome unconfirmed');
      if (!failed) core.setFailed('account_gateway_cleanup_failed');
    } finally {
      try {
        const cleanup = async (
          name: string,
          operation: () => Promise<unknown>
        ) => {
          try {
            await operation();
          } catch {
            core.warning(
              `Account gateway ${name} cleanup failed; removal unconfirmed`
            );
            if (!failed) core.setFailed('account_gateway_cleanup_failed');
          }
        };
        await cleanup('bridge', async () => bridge?.dispose());
        // Private OCR run dir removal also covers cache-hit/early-exit paths.
        await cleanup('OCR run', async () => ocrRun?.cleanup());
        await cleanup('OCR binary', async () => ocrBinary?.cleanup());
        if (codexHome)
          await cleanup('CODEX_HOME', () =>
            fs.rm(codexHome!, { recursive: true, force: true })
          );
        if (workspacePath)
          await cleanup('checkout', () =>
            fs.rm(workspacePath!, { recursive: true, force: true })
          );
        await cleanup('CLI', async () => cli?.clear?.());
      } finally {
        process.removeListener('SIGTERM', onSignal);
        process.removeListener('SIGINT', onSignal);
      }
    }
  }
}

export function validateAccountGatewayCheckout(
  result: GatewayReadback,
  repository: string,
  headSha: string
): AccountGatewayCheckoutCapability {
  const value = result.value;
  if (
    result.httpStatus !== 200 ||
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  )
    throw new Error('account_gateway_checkout_capability_unavailable');
  const body = value as Record<string, unknown>;
  const permissions = body.permissions as Record<string, unknown> | undefined;
  if (
    Object.keys(body).sort().join(',') !==
      'expiresAt,headSha,permissions,protocolVersion,repository,runtimeConfig,token' ||
    body.protocolVersion !== 1 ||
    body.repository !== repository ||
    body.headSha !== headSha ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !/^[a-f0-9]{40}$/.test(headSha) ||
    typeof body.token !== 'string' ||
    !/^[A-Za-z0-9._~-]{1,16384}$/.test(body.token) ||
    typeof body.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(body.expiresAt)) ||
    Date.parse(body.expiresAt) <= Date.now() + 30_000 ||
    !permissions ||
    Object.keys(permissions).sort().join(',') !== 'contents,pullRequests' ||
    permissions.contents !== 'read' ||
    permissions.pullRequests !== 'read'
  ) {
    throw new Error('account_gateway_checkout_capability_invalid');
  }
  return Object.freeze({
    protocolVersion: 1,
    repository,
    headSha,
    token: body.token,
    expiresAt: body.expiresAt,
    permissions: Object.freeze({ contents: 'read', pullRequests: 'read' }),
    runtimeConfig: parseAdmittedRuntimeConfig(body.runtimeConfig),
  });
}
