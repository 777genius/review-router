import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as core from '../actions/core';
import { ConfigLoader } from '../config/loader';
import { readApprovedReviewAgent } from '../control-plane/approved-review-agent';
import { ReviewActionV2Client } from '../control-plane/review-action-v2-client';
import type { AdmittedRuntimeConfig } from '../control-plane/runtime-config';
import {
  parseReviewModelDispatchCapabilityV2,
  reviewModelDispatchContract,
  type ReviewModelTransport,
} from '../control-plane/generated/review-action-v2/review-model-dispatch-contract';
import {
  createAccountGatewayRunFetch,
  LOCAL_MODEL_CAPABILITY_ENV,
  type LocalGatewayModelTransport,
} from '../review-orchestration/infrastructure/account-gateway-model-transport';
import { PreparedModelDispatch } from '../review-orchestration/infrastructure/prepared-model-dispatch';
import { ReviewActionV2ControlPlaneAdapter } from '../review-orchestration/infrastructure/review-action-v2-control-plane-adapter';
import { extractRawLoopbackCapability } from '../review-orchestration/infrastructure/ocr-review-managed-run';
import { CODEX_SHELL_ENVIRONMENT_POLICY } from '../providers/codex-confinement-policy';
import { validateAccountGatewayCheckout } from './account-gateway-runtime';
import { GitHubActionsOidcTokenProvider } from './github-actions-oidc';
import {
  createIsolatedCheckoutWorkspace,
  safeCheckoutRepository,
} from './safe-checkout';
import {
  prepareCodexCliBeforeAuthRead,
  type PreparedCodexCli,
} from './codex-cli';
import {
  prepareOcrManagedRun,
  readApprovedOcrReviewAgent,
  resolveApprovedOcrBinary,
  type OcrManagedRunHandle,
} from './ocr-managed-bootstrap';
import type { CodexOAuthV2ReviewRunnerPort } from './runtime';

export type PreparedModelReviewInputs = Pick<
  Parameters<CodexOAuthV2ReviewRunnerPort['run']>[0],
  | 'apiUrl'
  | 'audience'
  | 'repository'
  | 'pullRequestNumber'
  | 'headSha'
  | 'workflowSchemaVersion'
  | 'workspacePath'
  | 'providerInstanceId'
>;
export type PreparedModelRouteContext = Readonly<{
  runtimeConfig: AdmittedRuntimeConfig;
  controlPlane: ReviewActionV2ControlPlaneAdapter;
  modelDispatch: PreparedModelDispatch;
  signal: AbortSignal;
}>;

/** Common admitted bootstrap for subscription adapters. Credential lifecycle
 * stays outside this function. Review planning, verification and publication
 * remain in the existing production runner supplied through the review port. */
export async function runPreparedModelReview(
  input: PreparedModelReviewInputs,
  ports: Readonly<{
    transport: Exclude<ReviewModelTransport, 'account_gateway'>;
    signal: AbortSignal;
    fetchImpl?: typeof fetch;
    review: CodexOAuthV2ReviewRunnerPort;
    prepareTransport(
      context: PreparedModelRouteContext
    ): Promise<LocalGatewayModelTransport>;
  }>
) {
  const signal = ports.signal;
  signal.throwIfAborted();
  if (
    !Number.isSafeInteger(input.workflowSchemaVersion) ||
    input.workflowSchemaVersion < 1
  )
    throw new Error('prepared_model_workflow_schema_invalid');
  const fetchImpl = createAccountGatewayRunFetch(
    ports.fetchImpl ?? fetch,
    signal
  );
  const controlPlane = new ReviewActionV2ControlPlaneAdapter(
    new ReviewActionV2Client({ apiUrl: input.apiUrl, fetchImpl })
  );
  const oidc = new GitHubActionsOidcTokenProvider({ fetchImpl });
  const authorization = await controlPlane.authorize({
    oidcToken: await oidc.requestToken(input.audience),
  });
  if (
    authorization.facts.headSha !== input.headSha.toLowerCase() ||
    authorization.facts.pullRequestNumber !== input.pullRequestNumber
  )
    throw new Error('prepared_model_authorization_input_mismatch');

  let admitted: AdmittedRuntimeConfig | undefined;
  const readCapability = async () => {
    signal.throwIfAborted();
    const response = await fetchImpl(
      new URL('/api/action/v2/model-route/checkout', input.apiUrl),
      {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${controlPlane.currentAuthorization().authorizationToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          transport: ports.transport,
          providerIndex: 0,
          // This is the model-route checkout contract version. The original
          // caller schema (including rotating schemas 4/5) is independently
          // verified by OIDC admission and remains unchanged in review input.
          workflowSchemaVersion: 2,
        }),
        signal,
      }
    );
    const raw = await boundedCheckoutResponse(response);
    const capability = validateAccountGatewayCheckout(
      { httpStatus: response.status, value: raw },
      input.repository,
      authorization.facts.headSha
    );
    const cap = parseReviewModelDispatchCapabilityV2(
      JSON.parse(
        capability.runtimeConfig.runtimeEnv[
          reviewModelDispatchContract.capabilityRuntimeEnvKey
        ] ?? 'null'
      )
    );
    if (
      cap.transport !== ports.transport ||
      cap.providerIndex !== 0 ||
      Date.now() >= Date.parse(cap.deadline)
    )
      throw new Error('prepared_model_route_mismatch');
    if (
      admitted &&
      (admitted.configVersion !== capability.runtimeConfig.configVersion ||
        canonicalEnv(admitted) !== canonicalEnv(capability.runtimeConfig))
    )
      throw new Error('prepared_model_runtime_configuration_changed');
    admitted ??= capability.runtimeConfig;
    core.setSecret(capability.token);
    return capability;
  };
  const capability = await readCapability();
  const runtimeConfig = capability.runtimeConfig;
  const env = runtimeConfig.runtimeEnv;
  const modelDispatch = new PreparedModelDispatch({
    apiUrl: input.apiUrl,
    capability: JSON.parse(
      env[reviewModelDispatchContract.capabilityRuntimeEnvKey]!
    ),
    authorization: () => controlPlane.currentAuthorization(),
    fetchImpl: ports.fetchImpl,
  });
  const agent = readApprovedReviewAgent(
    env.REVIEW_ROUTER_AGENT_PROFILE_JSON ?? '',
    env.REVIEW_ROUTER_AGENT_PROFILE_DIGEST ?? ''
  );
  if (
    !agent.modelTransports.includes('provider_api') ||
    (agent.agentKind !== 'ocr' && agent.agentKind !== 'codex') ||
    (agent.agentKind === 'codex' &&
      modelDispatch.capability.wireProtocol === 'anthropic-messages')
  )
    throw new Error('prepared_model_agent_incompatible');

  let binary: Awaited<ReturnType<typeof resolveApprovedOcrBinary>> | undefined;
  let cli: PreparedCodexCli | undefined;
  let ocr: OcrManagedRunHandle | undefined;
  let modelTransport: LocalGatewayModelTransport | undefined;
  let workspace: string | undefined;
  let codexHome: string | undefined;
  try {
    // Verify immutable executable identity before reading an upstream credential
    // or making the PR checkout available to the engine.
    const approvedOcr =
      agent.agentKind === 'ocr'
        ? readApprovedOcrReviewAgent(
            env.REVIEW_ROUTER_AGENT_PROFILE_JSON!,
            env.REVIEW_ROUTER_AGENT_PROFILE_DIGEST!
          )
        : undefined;
    if (approvedOcr)
      binary = await resolveApprovedOcrBinary({
        approvedAgent: approvedOcr,
        signal,
      });
    else
      cli = await prepareCodexCliBeforeAuthRead({
        approvedAgent: agent,
        signal,
        logger: { info: core.info, warn: core.warning },
      });
    modelTransport = await ports.prepareTransport({
      runtimeConfig,
      controlPlane,
      modelDispatch,
      signal,
    });
    signal.throwIfAborted();
    workspace = await createIsolatedCheckoutWorkspace({
      runnerTempPath: process.env.RUNNER_TEMP,
      githubWorkspacePath: input.workspacePath,
    });
    await safeCheckoutRepository({
      repository: capability.repository,
      headSha: capability.headSha,
      mergeBaseSha: authorization.facts.mergeBaseSha,
      workspacePath: workspace,
      token: capability.token,
      signal,
    });
    if (approvedOcr) {
      const config = ConfigLoader.loadRuntimeEnvironment(env, {
        modelTransport: true,
      });
      ocr = await prepareOcrManagedRun({
        approvedAgent: approvedOcr,
        baseUrl: modelTransport.baseUrl,
        rawCapability: extractRawLoopbackCapability(
          modelTransport.environment[LOCAL_MODEL_CAPABILITY_ENV] ?? ''
        ),
        model: modelDispatch.capability.model,
        protocol:
          modelDispatch.capability.wireProtocol === 'anthropic-messages'
            ? 'anthropic-messages'
            : 'openai-responses',
        requestTimeoutSec: config.runTimeoutSeconds,
        modelReasoningEffort: env.CODEX_REASONING_EFFORT ?? null,
        language: env.REVIEW_OUTPUT_LANGUAGE ?? null,
        signal,
        env: { ...process.env, REVIEWROUTER_OCR_BINARY: binary!.binaryPath },
      });
    } else {
      codexHome = await fs.mkdtemp(
        path.join(
          process.env.RUNNER_TEMP || os.tmpdir(),
          'reviewrouter-native-capability-'
        )
      );
      await fs.chmod(codexHome, 0o700);
      await fs.writeFile(
        path.join(codexHome, 'config.toml'),
        [
          ...CODEX_SHELL_ENVIRONMENT_POLICY,
          ...modelTransport.configuration,
        ].join('\n') + '\n',
        { mode: 0o600 }
      );
      modelTransport = Object.freeze({
        ...modelTransport,
        environment: Object.freeze({
          ...modelTransport.environment,
          CODEX_HOME: codexHome,
        }),
      });
    }
    return await ports.review.run({
      apiUrl: input.apiUrl,
      audience: input.audience,
      workflowSchemaVersion: input.workflowSchemaVersion,
      pullRequestNumber: input.pullRequestNumber,
      ...(input.providerInstanceId
        ? { providerInstanceId: input.providerInstanceId }
        : {}),
      workspacePath: workspace,
      repository: capability.repository,
      headSha: capability.headSha,
      ...(codexHome ? { codexHome } : {}),
      ...(cli ? { codexBinaryPath: cli.binaryPath } : {}),
      ...(ocr
        ? {
            ocr: { run: ocr, effectFacts: () => modelTransport?.failureFact() },
          }
        : {}),
      scmReadToken: capability.token,
      scmReadTokenExpiresAt: capability.expiresAt,
      refreshScmReadToken: readCapability,
      preparedRoute: { runtimeConfig, controlPlane, modelTransport, signal },
    });
  } finally {
    // Drain in-flight model work and receipt settlement before removing the
    // process configuration or executable. Every remaining cleanup still runs
    // when an earlier one fails, including after cancellation.
    let cleanupFailed = false;
    for (const cleanup of [
      () => modelTransport?.dispose(),
      () => ocr?.cleanup(),
      () => binary?.cleanup(),
      () => cli?.clear?.(),
      ...[codexHome, workspace].map(
        (directory) => () =>
          directory
            ? fs.rm(directory, { recursive: true, force: true })
            : undefined
      ),
    ]) {
      try {
        await cleanup();
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) throw new Error('prepared_model_cleanup_unconfirmed');
  }
}

function canonicalEnv(config: AdmittedRuntimeConfig): string {
  return JSON.stringify(
    Object.entries(config.runtimeEnv).sort(([left], [right]) =>
      left.localeCompare(right)
    )
  );
}

async function boundedCheckoutResponse(response: Response): Promise<unknown> {
  if (
    !response.ok ||
    !response.body ||
    !/^application\/json(?:\s*;.*)?$/i.test(
      response.headers.get('content-type') ?? ''
    )
  ) {
    await response.body?.cancel();
    throw new Error('prepared_model_checkout_unavailable');
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > 65_536) throw new Error('prepared_model_checkout_bound');
    chunks.push(chunk);
  }
  return JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  );
}
