import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ReviewActionV2Client } from '../control-plane/review-action-v2-client';
import { ReviewActionV2ControlPlaneAdapter } from '../review-orchestration/infrastructure/review-action-v2-control-plane-adapter';
import {
  AccountGatewayModelTransport,
  startLocalGatewayModelTransport,
  type GatewayCloseReason,
  type GatewayReadback,
  type GatewayFailureFact,
  type LocalGatewayModelTransport,
} from '../review-orchestration/infrastructure/account-gateway-model-transport';
import { GitHubActionsOidcTokenProvider } from './github-actions-oidc';
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
 * body {}, bearer=current ReviewActionV2 authorization. No job header authority. */
export type AccountGatewayCheckoutRequest = Readonly<Record<string, never>>;
export type AccountGatewayCheckoutCapability = Readonly<{
  protocolVersion: 1;
  repository: string;
  headSha: string;
  token: string;
  expiresAt: string;
  permissions: Readonly<{ contents: 'read'; pullRequests: 'read' }>;
}>;

/** Reuses existing v2 admission/renewal, isolated checkout and prepared CLI.
 * There is no prelease, upstream auth read/refresh or credential writeback. */
export async function runAccountGatewayRuntime(
  input: CodexOAuthRuntimeInputs,
  ports: {
    readonly review: CodexOAuthV2ReviewRunnerPort;
    readonly fetchImpl?: typeof fetch;
    readonly terminalReview: (
      review: CodexOAuthV2ReviewResult
    ) => Promise<void>;
    readonly terminalFailure: (error: unknown) => Promise<void>;
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
  const controlPlane = new ReviewActionV2ControlPlaneAdapter(
    new ReviewActionV2Client({
      apiUrl: input.apiUrl,
      fetchImpl: ports.fetchImpl,
    })
  );
  const transport = new AccountGatewayModelTransport(
    input.apiUrl,
    () => controlPlane.currentAuthorization().authorizationToken
  );
  let authorized = false;
  let workspacePath: string | undefined;
  let codexHome: string | undefined;
  let cli: PreparedCodexCli | undefined;
  let bridge: LocalGatewayModelTransport | undefined;
  let reason: GatewayCloseReason = 'failed';
  const cancel = () => {
    reason = 'cancelled';
    transport.cancelInference();
  };
  let cancelled = false;
  const onSignal = () => {
    cancelled = true;
    cancel();
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  try {
    const oidc = new GitHubActionsOidcTokenProvider({
      fetchImpl: ports.fetchImpl,
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
    const readCapability =
      async (): Promise<AccountGatewayCheckoutCapability> => {
        const request: AccountGatewayCheckoutRequest = {};
        const result = await transport.checkoutCapability(request);
        return validateAccountGatewayCheckout(
          result,
          input.repository,
          authorization.facts.headSha
        );
      };
    const capability = await readCapability();
    if (cancelled) throw new Error('account_gateway_cancelled');
    workspacePath = await createIsolatedCheckoutWorkspace({
      runnerTempPath: process.env.RUNNER_TEMP,
      githubWorkspacePath: input.workspacePath,
    });
    await safeCheckoutRepository({
      repository: capability.repository,
      headSha: capability.headSha,
      workspacePath,
      token: capability.token,
    });
    cli = await prepareCodexCliBeforeAuthRead();
    // A binary-only version check; alternate installed versions do not inherit retry qualification.
    const version = await promisify(execFile)(cli.binaryPath, ['--version'], {
      timeout: 10_000,
      maxBuffer: 16_384,
      env: { PATH: process.env.PATH, HOME: os.tmpdir() },
    });
    if (!/^codex-cli 0\.147\.0\s*$/.test(version.stdout))
      throw new Error('account_gateway_codex_version_unqualified');
    codexHome = await fs.mkdtemp(
      path.join(
        process.env.RUNNER_TEMP || os.tmpdir(),
        'reviewrouter-keyless-codex-'
      )
    );
    await fs.chmod(codexHome, 0o700);
    bridge = await startLocalGatewayModelTransport(transport);
    // App-server uses generated isolated config; exec also receives pinned -c values.
    // Empty fresh home; never auth.json, including dummy credentials.
    await fs.writeFile(
      path.join(codexHome, 'config.toml'),
      bridge.configuration.join('\n') + '\n',
      { mode: 0o600 }
    );
    if (cancelled) throw new Error('account_gateway_cancelled');
    const review = await ports.review.run({
      ...input,
      repository: capability.repository,
      headSha: capability.headSha,
      workspacePath,
      codexHome,
      codexBinaryPath: cli.binaryPath,
      scmReadToken: capability.token,
      scmReadTokenExpiresAt: capability.expiresAt,
      refreshScmReadToken: readCapability,
      accountGateway: { controlPlane, modelTransport: bridge },
    });
    // Runner has awaited App publication. Terminal status/advisory finishes before close.
    ports.observeRelay(transport.lastFailure);
    await ports.terminalReview(review);
    reason =
      cancelled ||
      review.outcome === CodexOAuthV2ReviewOutcome.Cancelled ||
      review.outcome === CodexOAuthV2ReviewOutcome.Superseded
        ? 'cancelled'
        : review.outcome === CodexOAuthV2ReviewOutcome.Completed
          ? 'completed'
          : 'failed';
  } catch (error) {
    ports.observeRelay(transport.lastFailure);
    await ports.terminalFailure(error);
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
    } finally {
      await bridge?.dispose();
      process.removeListener('SIGTERM', onSignal);
      process.removeListener('SIGINT', onSignal);
      if (codexHome) await fs.rm(codexHome, { recursive: true, force: true });
      if (workspacePath)
        await fs.rm(workspacePath, { recursive: true, force: true });
      await cli?.clear?.();
      clearCodexRotatingProcessAuthEnv();
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
      'expiresAt,headSha,permissions,protocolVersion,repository,token' ||
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
  });
}
