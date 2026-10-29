import { canonicalJson } from '../review-investigation/domain/canonical-json';
import {
  parseReviewReviewerPlan,
  reviewerPlanContract,
} from '../control-plane/generated/review-action-v2/review-reviewer-plan';
import { prepareAccountGatewayReviewerSession } from './account-gateway-reviewer-session';
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
    | 'prepare_ocr'
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
  const childCleanups: Array<() => Promise<void>> = [];
  const childTransports: AccountGatewayModelTransport[] = [];
  let reason: GatewayCloseReason = 'failed';
  const onSignal = () => {
    reason = 'cancelled';
    run.abort(new Error('account_gateway_cancelled'));
    transport.cancelInference();
    for (const child of childTransports) child.cancelInference();
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
          assertAccountGatewayRuntimeConfigContinuity(
            admittedRuntimeConfig,
            capability.runtimeConfig
          );
        } else {
          admittedRuntimeConfig = capability.runtimeConfig;
        }
        // Token refresh never changes the invocation plan captured at checkout.
        return Object.freeze({
          ...capability,
          runtimeConfig: admittedRuntimeConfig,
        });
      };
    phase = 'checkout_capability';
    const capability = await readCapability();
    run.signal.throwIfAborted();
    const planJson =
      capability.runtimeConfig.runtimeEnv[reviewerPlanContract.runtimeEnvKey];
    const reviewerPlan =
      planJson === undefined ? undefined : parseReviewReviewerPlan(planJson);
    let review: CodexOAuthV2ReviewResult;
    if (reviewerPlan) {
      if (
        authorization.facts.providerVoteLanes.length !==
          reviewerPlan.reviewers.length ||
        reviewerPlan.reviewers.some(
          (reviewer) =>
            !authorization.facts.providerVoteLanes.some(
              (lane) =>
                lane.providerVoteIdentityHash ===
                  reviewer.providerVoteIdentityHash &&
                lane.providerKind ===
                  (reviewer.agentProfile.agentKind === 'ocr' ? 'ocr' : 'codex')
            )
        )
      )
        throw new Error('account_gateway_reviewer_plan_authority_mismatch');
      // The complete roster is parsed before any binary/provider effect.
      phase = 'create_workspace';
      workspacePath = await createIsolatedCheckoutWorkspace({
        runnerTempPath: process.env.RUNNER_TEMP,
        githubWorkspacePath: input.workspacePath,
      });
      phase = 'checkout';
      await safeCheckoutRepository({
        repository: capability.repository,
        headSha: capability.headSha,
        mergeBaseSha: authorization.facts.mergeBaseSha,
        workspacePath,
        token: capability.token,
        signal: run.signal,
      });
      phase = 'local_transport';
      const reviewers = [];
      for (const reviewer of reviewerPlan.reviewers)
        reviewers.push(
          await prepareAccountGatewayReviewerSession({
            apiUrl: input.apiUrl,
            authorization: () =>
              controlPlane.currentAuthorization().authorizationToken,
            runtimeConfig: capability.runtimeConfig,
            reviewer,
            signal: run.signal,
            registerCleanup: (cleanup) => childCleanups.push(cleanup),
            registerTransport: (child) => childTransports.push(child),
          })
        );
      const primary = reviewers.find(
        (reviewer) =>
          reviewer.reviewer.reviewerId === reviewerPlan.primaryReviewerId
      )!;
      phase = 'runner';
      review = await ports.review.run({
        ...input,
        repository: capability.repository,
        headSha: capability.headSha,
        workspacePath,
        ...(primary.codexHome ? { codexHome: primary.codexHome } : {}),
        ...(primary.codexBinaryPath
          ? { codexBinaryPath: primary.codexBinaryPath }
          : {}),
        ...(primary.ocr ? { ocr: primary.ocr } : {}),
        scmReadToken: capability.token,
        scmReadTokenExpiresAt: capability.expiresAt,
        refreshScmReadToken: readCapability,
        accountGateway: {
          runtimeConfig: capability.runtimeConfig,
          controlPlane,
          modelTransport: primary.modelTransport,
          signal: run.signal,
          reviewerPlan,
          reviewers,
        },
      });
    } else {
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
        phase = 'prepare_ocr';
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
        const version = await promisify(execFile)(
          cli.binaryPath,
          ['--version'],
          {
            signal: run.signal,
            killSignal: 'SIGKILL',
            timeout: 10_000,
            maxBuffer: 16_384,
            env: { PATH: process.env.PATH, HOME: os.tmpdir() },
          }
        );
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
      bridge = await startLocalGatewayModelTransport(
        transport,
        observeTransport
      );
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
          admittedRuntimeConfig: capability.runtimeConfig,
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
      review = await ports.review.run({
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
    }
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
    for (const child of childTransports) child.cancelInference();
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
          for (const child of childTransports) {
            ports.observeRelay(child.lastFailure);
            const requestRef = child.lastRequestRef;
            if (requestRef)
              ports.observeReadback(
                requestRef,
                await child.readRequest(requestRef).catch(() => ({
                  httpStatus: 0,
                  value: { effect: 'effect_unknown' },
                }))
              );
          }
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
        for (const childCleanup of childCleanups)
          await cleanup('reviewer', childCleanup);
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

/** A refreshed SCM capability may report lost/recovered allocation availability.
 * It never changes the initially admitted invocation inputs or revives a slot. */
export function assertAccountGatewayRuntimeConfigContinuity(
  initial: AdmittedRuntimeConfig,
  current: AdmittedRuntimeConfig
): void {
  const fail = () => {
    throw new Error('account_gateway_runtime_config_changed');
  };
  if (initial.configVersion !== current.configVersion) fail();
  const canonicalEnv = (env: Readonly<Record<string, string>>) =>
    canonicalJson(env);
  const firstJson = initial.runtimeEnv[reviewerPlanContract.runtimeEnvKey];
  const nextJson = current.runtimeEnv[reviewerPlanContract.runtimeEnvKey];
  if (firstJson === undefined || nextJson === undefined) {
    if (canonicalEnv(initial.runtimeEnv) !== canonicalEnv(current.runtimeEnv))
      fail();
    return;
  }
  const first = parseReviewReviewerPlan(firstJson);
  const next = parseReviewReviewerPlan(nextJson);
  const { reviewers: firstReviewers, ...firstPlan } = first;
  const { reviewers: nextReviewers, ...nextPlan } = next;
  if (
    canonicalJson(firstPlan) !== canonicalJson(nextPlan) ||
    firstReviewers.length !== nextReviewers.length
  )
    fail();
  firstReviewers.forEach((reviewer, index) => {
    const currentReviewer = nextReviewers[index]!;
    const {
      unavailableReason: _firstAvailability,
      modelSettings: firstSettings,
      ...firstStable
    } = reviewer;
    const {
      unavailableReason: _nextAvailability,
      modelSettings: nextSettings,
      ...nextStable
    } = currentReviewer;
    if (
      canonicalJson(firstStable) !== canonicalJson(nextStable) ||
      (firstSettings !== undefined &&
        nextSettings !== undefined &&
        canonicalJson(firstSettings) !== canonicalJson(nextSettings)) ||
      (firstSettings !== undefined &&
        nextSettings === undefined &&
        currentReviewer.unavailableReason === undefined) ||
      (firstSettings === undefined &&
        nextSettings !== undefined &&
        reviewer.unavailableReason === undefined)
    )
      fail();
  });
  const normalized: Record<string, string> = {
    ...current.runtimeEnv,
    [reviewerPlanContract.runtimeEnvKey]: firstJson,
  };
  const modelSettingsKey = 'REVIEW_ROUTER_GATEWAY_MODEL_SETTINGS_JSON';
  const firstSettings = initial.runtimeEnv[modelSettingsKey];
  const nextSettings = current.runtimeEnv[modelSettingsKey];
  if (firstSettings !== nextSettings) {
    const firstPrimary = firstReviewers.find(
      (reviewer) => reviewer.reviewerId === first.primaryReviewerId
    )!;
    const nextPrimary = nextReviewers.find(
      (reviewer) => reviewer.reviewerId === next.primaryReviewerId
    )!;
    if (
      (firstSettings !== undefined &&
        nextSettings === undefined &&
        nextPrimary.unavailableReason === undefined) ||
      (firstSettings === undefined &&
        nextSettings !== undefined &&
        firstPrimary.unavailableReason === undefined)
    )
      fail();
    if (firstSettings !== undefined && nextSettings !== undefined) {
      try {
        if (
          canonicalJson(JSON.parse(firstSettings)) !==
          canonicalJson(JSON.parse(nextSettings))
        )
          fail();
      } catch {
        fail();
      }
    }
    if (firstSettings === undefined) delete normalized[modelSettingsKey];
    else normalized[modelSettingsKey] = firstSettings;
  }
  if (canonicalEnv(initial.runtimeEnv) !== canonicalEnv(normalized)) fail();
}
