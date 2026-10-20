import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as core from '../actions/core';
import { ConfigLoader } from '../config/loader';
import {
  readApprovedReviewAgent,
  assertApprovedReviewAgentVersion,
} from '../control-plane/approved-review-agent';
import { providerApiCheckoutCompanionContract } from '../control-plane/generated/review-action-v2/companion-contracts';
import { ReviewActionV2Client } from '../control-plane/review-action-v2-client';
import type { AdmittedRuntimeConfig } from '../control-plane/runtime-config';
import { CODEX_SHELL_ENVIRONMENT_POLICY } from '../providers/codex-confinement-policy';
import { CODEX_OPENROUTER_CONFIGURATION } from '../providers/codex-model-provider-configuration';
import {
  AccountGatewayModelTransport,
  createAccountGatewayRunFetch,
} from '../review-orchestration/infrastructure/account-gateway-model-transport';
import { ReviewActionV2ControlPlaneAdapter } from '../review-orchestration/infrastructure/review-action-v2-control-plane-adapter';
import { selectDirectOpenRouterProvider } from '../review-orchestration/infrastructure/production-t0-review-runner';
import { validateAccountGatewayCheckout } from './account-gateway-runtime';
import {
  clearCodexRotatingOidcRequestEnv,
  clearCodexRotatingProcessAuthEnv,
  clearCodexRotatingProviderSecretEnv,
  readCodexRotatingProviderSecretInputs,
  CODEX_ROTATING_AUTH_INPUT_ENV_NAMES,
} from './auth-input';
import {
  prepareCodexCliBeforeAuthRead,
  type PreparedCodexCli,
} from './codex-cli';
import { GitHubActionsOidcTokenProvider } from './github-actions-oidc';
import {
  createIsolatedCheckoutWorkspace,
  safeCheckoutRepository,
} from './safe-checkout';
import type {
  CodexOAuthRuntimeInputs,
  CodexOAuthV2ReviewResult,
  CodexOAuthV2ReviewRunnerPort,
} from './runtime';

export const PROVIDER_API_ACTION_MODE = 'provider-api';
export type ProviderApiRuntimeInputs = Omit<
  CodexOAuthRuntimeInputs,
  'providerInstanceId' | 'reviewMode'
>;

export function assertProviderApiLocalInputs(
  env: NodeJS.ProcessEnv = process.env
): void {
  for (const key of [
    ...CODEX_ROTATING_AUTH_INPUT_ENV_NAMES,
    'CODEX_AUTH_JSON',
    'CODEX_CONFIG_TOML',
    'INPUT_CODEX_CONFIG_TOML',
    'INPUT_CODEX-CONFIG-TOML',
    'INPUT_PROVIDER_INSTANCE_ID',
    'INPUT_PROVIDER-INSTANCE-ID',
    'RR_PROVIDER_INSTANCE_ID',
    'RR_CODEX_SESSION_MODE',
    'INPUT_CLAUDE_CODE_OAUTH_TOKEN',
    'INPUT_CLAUDE-CODE-OAUTH-TOKEN',
    'INPUT_OPENAI_API_KEY',
    'INPUT_OPENAI-API-KEY',
    'INPUT_MIMO_TOKEN_PLAN_API_KEY',
  ]) {
    if (env[key]) throw new Error('provider_api_alternate_auth_input');
  }
}

export function approvedProviderApiAgent(runtime: AdmittedRuntimeConfig) {
  const env = runtime.runtimeEnv;
  if (
    env.REVIEW_AUTH_MODE !==
      providerApiCheckoutCompanionContract.providerApiAuthMode ||
    !/^openrouter\/[A-Za-z0-9_.:~-]+(?:\/[A-Za-z0-9_.:~-]+)+$/.test(
      env.REVIEW_PROVIDERS ?? ''
    )
  ) {
    throw new Error('provider_api_admitted_configuration_invalid');
  }
  selectDirectOpenRouterProvider(ConfigLoader.loadRuntimeEnvironment(env));
  const agent = readApprovedReviewAgent(
    env.REVIEW_ROUTER_AGENT_PROFILE_JSON ?? '',
    env.REVIEW_ROUTER_AGENT_PROFILE_DIGEST ?? ''
  );
  if (
    agent.agentKind !== 'codex' ||
    !agent.modelTransports.includes('provider_api') ||
    !agent.cancellation ||
    (env.CODEX_AGENTIC_CONTEXT !== 'false' && !agent.contextGateway)
  ) {
    throw new Error('provider_api_approved_agent_invalid');
  }
  return agent;
}

/** A separate credential bootstrap; the full review/publication runner is shared. */
export async function runProviderApiRuntime(
  input: ProviderApiRuntimeInputs,
  ports: {
    readonly review: CodexOAuthV2ReviewRunnerPort;
    readonly fetchImpl?: typeof fetch;
    readonly terminalReview: (
      result: CodexOAuthV2ReviewResult,
      signal: AbortSignal
    ) => Promise<void>;
  }
): Promise<void> {
  const run = new AbortController();
  const cancel = () => run.abort(new Error('provider_api_cancelled'));
  process.on('SIGTERM', cancel);
  process.on('SIGINT', cancel);
  let cli: PreparedCodexCli | undefined;
  let workspacePath: string | undefined;
  let codexHome: string | undefined;
  let apiKey: string | undefined;
  let phase = 'authorization';
  try {
    const fetchImpl = createAccountGatewayRunFetch(
      ports.fetchImpl ?? fetch,
      run.signal
    );
    const controlPlane = new ReviewActionV2ControlPlaneAdapter(
      new ReviewActionV2Client({ apiUrl: input.apiUrl, fetchImpl })
    );
    const transport = new AccountGatewayModelTransport(
      input.apiUrl,
      () => controlPlane.currentAuthorization().authorizationToken
    );
    if (
      input.workflowSchemaVersion !==
      providerApiCheckoutCompanionContract.workflowSchemaVersion
    ) {
      throw new Error('provider_api_workflow_schema_invalid');
    }
    assertProviderApiLocalInputs();
    clearCodexRotatingProviderSecretEnv();
    delete process.env.OPENAI_API_KEY;
    delete process.env.CODEX_HOME;
    const oidc = new GitHubActionsOidcTokenProvider({ fetchImpl });
    const authorization = await controlPlane.authorize({
      oidcToken: await oidc.requestToken(input.audience),
    });
    if (
      authorization.facts.headSha !== input.headSha ||
      authorization.facts.pullRequestNumber !== input.pullRequestNumber
    ) {
      throw new Error('provider_api_authorization_input_mismatch');
    }
    phase = 'checkout_capability';
    let admitted: AdmittedRuntimeConfig | undefined;
    const readCapability = async () => {
      run.signal.throwIfAborted();
      const capability = validateAccountGatewayCheckout(
        await transport.providerApiCheckoutCapability(run.signal),
        input.repository,
        input.headSha
      );
      approvedProviderApiAgent(capability.runtimeConfig);
      if (
        admitted &&
        (admitted.configVersion !== capability.runtimeConfig.configVersion ||
          JSON.stringify(Object.entries(admitted.runtimeEnv).sort()) !==
            JSON.stringify(
              Object.entries(capability.runtimeConfig.runtimeEnv).sort()
            ))
      ) {
        throw new Error('provider_api_runtime_config_changed');
      }
      admitted ??= capability.runtimeConfig;
      core.setSecret(capability.token);
      return capability;
    };
    const capability = await readCapability();
    const agent = approvedProviderApiAgent(capability.runtimeConfig);
    phase = 'prepare_cli';
    cli = await prepareCodexCliBeforeAuthRead({
      signal: run.signal,
      approvedAgent: agent,
      logger: { info: core.info, warn: core.warning },
    });
    const version = await promisify(execFile)(cli.binaryPath, ['--version'], {
      signal: run.signal,
      killSignal: 'SIGKILL',
      timeout: 10_000,
      maxBuffer: 16_384,
      env: { PATH: process.env.PATH, HOME: os.tmpdir() },
    });
    assertApprovedReviewAgentVersion(
      agent,
      version.stdout.trim().replace(/^codex-cli /, '')
    );
    phase = 'checkout';
    workspacePath = await createIsolatedCheckoutWorkspace({
      runnerTempPath: process.env.RUNNER_TEMP,
      githubWorkspacePath: input.workspacePath,
    });
    await safeCheckoutRepository({
      repository: capability.repository,
      headSha: capability.headSha,
      workspacePath,
      token: capability.token,
      signal: run.signal,
    });
    codexHome = await fs.mkdtemp(
      path.join(
        process.env.RUNNER_TEMP || os.tmpdir(),
        'reviewrouter-provider-api-'
      )
    );
    await fs.chmod(codexHome, 0o700);
    // No auth.json. Both exec and app-server use this isolated provider setup.
    await fs.writeFile(
      path.join(codexHome, 'config.toml'),
      [
        ...CODEX_SHELL_ENVIRONMENT_POLICY,
        ...CODEX_OPENROUTER_CONFIGURATION,
      ].join('\n') + '\n',
      { mode: 0o600 }
    );
    phase = 'local_credential';
    const secrets = readCodexRotatingProviderSecretInputs();
    apiKey = secrets.openRouterApiKey;
    if (!apiKey || secrets.claudeCodeOAuthToken)
      throw new Error('provider_api_credential_missing');
    phase = 'runner';
    const review = await ports.review.run({
      ...input,
      workspacePath,
      codexHome,
      codexBinaryPath: cli.binaryPath,
      scmReadToken: capability.token,
      scmReadTokenExpiresAt: capability.expiresAt,
      refreshScmReadToken: readCapability,
      providerApi: {
        runtimeConfig: capability.runtimeConfig,
        controlPlane,
        signal: run.signal,
        credentialLease: () => {
          run.signal.throwIfAborted();
          if (!apiKey) throw new Error('provider_api_credential_closed');
          return { environment: Object.freeze({ OPENROUTER_API_KEY: apiKey }) };
        },
      },
    });
    apiKey = undefined;
    phase = 'terminal';
    run.signal.throwIfAborted();
    await ports.terminalReview(review, run.signal);
  } catch {
    core.warning(`Direct provider API runtime failed: phase=${phase}`);
    throw new Error(`provider_api_runtime_failed:${phase}`);
  } finally {
    apiKey = undefined;
    clearCodexRotatingOidcRequestEnv();
    clearCodexRotatingProcessAuthEnv();
    process.removeListener('SIGTERM', cancel);
    process.removeListener('SIGINT', cancel);
    for (const cleanup of [
      async () => {
        if (codexHome) await fs.rm(codexHome, { recursive: true, force: true });
      },
      async () => {
        if (workspacePath)
          await fs.rm(workspacePath, { recursive: true, force: true });
      },
      async () => {
        await cli?.clear?.();
      },
    ]) {
      try {
        await cleanup();
      } catch {
        core.setFailed('provider_api_cleanup_failed');
      }
    }
  }
}
