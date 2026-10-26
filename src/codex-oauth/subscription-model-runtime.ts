import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as core from '../actions/core';
import {
  startHostedPoolCodexModelTransport,
  startRunnerLocalCodexSubscriptionModelTransport,
} from '../review-orchestration/infrastructure/account-gateway-model-transport';
import { readPreparedCodexCredential } from './codex-auth-refresh-validation';
import { CODEX_ROTATING_AUTH_JSON_MAX_BYTES } from './crypto';
import {
  prepareClaudeSubscriptionCredential,
  prepareClaudeSubscriptionModelRoute,
} from './claude-subscription-bootstrap';
import {
  clearCodexRotatingOidcRequestEnv,
  clearCodexRotatingProcessAuthEnv,
} from './auth-input';
import {
  runPreparedModelReview,
  type PreparedModelReviewInputs,
} from './prepared-model-review-runtime';
import type {
  CodexOAuthV2ReviewRunnerPort,
  CodexOAuthV2ReviewResult,
} from './runtime';

export const PREPARED_SUBSCRIPTION_ACTION_MODE = 'prepared-subscription';
export const PREPARED_SUBSCRIPTION_TRANSPORT_ENV =
  'REVIEWROUTER_PREPARED_MODEL_TRANSPORT';
export const HOSTED_ORIGINAL_GRANT_ENV = 'REVIEWROUTER_HOSTED_ORIGINAL_GRANT';

/** Called only AFTER the existing rotating lease, official auth-only refresh,
 * sealed writeback and its definite acknowledgement. The common runner never
 * receives this private home, upstream token or refresh authority. */
export function createPreparedCodexSubscriptionReviewRunner(
  input: Readonly<{
    review: CodexOAuthV2ReviewRunnerPort;
    signal: AbortSignal;
    fetchImpl?: typeof fetch;
  }>
): CodexOAuthV2ReviewRunnerPort {
  return {
    checkoutOwner: 'review_runner',
    async run(request) {
      if (!request.codexHome)
        throw new Error('codex_subscription_prepared_auth_missing');
      const authPath = path.join(request.codexHome, 'auth.json');
      return runPreparedModelReview(request, {
        review: input.review,
        fetchImpl: input.fetchImpl,
        signal: input.signal,
        transport: 'runner_local_responses',
        async prepareTransport({ modelDispatch, runtimeConfig, signal }) {
          const cap = modelDispatch.capability;
          if (
            cap.wireProtocol !== 'codex-responses' ||
            runtimeConfig.runtimeEnv.REVIEW_AUTH_MODE !== 'codex-oauth' ||
            runtimeConfig.runtimeEnv.CODEX_MODEL !== cap.model
          )
            throw new Error('codex_subscription_admitted_route_invalid');
          const stat = await fs.lstat(authPath);
          if (!stat.isFile() || stat.size > CODEX_ROTATING_AUTH_JSON_MAX_BYTES)
            throw new Error('codex_subscription_prepared_auth_invalid');
          const credential = readPreparedCodexCredential(
            await fs.readFile(authPath, 'utf8'),
            Date.parse(cap.deadline)
          );
          core.setSecret(credential.accessToken);
          return startRunnerLocalCodexSubscriptionModelTransport({
            credential,
            modelDispatch,
            reasoningEffort:
              runtimeConfig.runtimeEnv.CODEX_REASONING_EFFORT ?? null,
            signal,
          });
        },
      });
    },
  };
}

/** Native Claude and Hosted bootstrap differ only in their existing credential
 * lifecycle. No account/model selection, review planning or publication lives here. */
export async function runPreparedSubscriptionRuntime(
  input: PreparedModelReviewInputs,
  ports: Readonly<{
    review: CodexOAuthV2ReviewRunnerPort;
    terminalReview(
      result: CodexOAuthV2ReviewResult,
      signal: AbortSignal
    ): Promise<void>;
    fetchImpl?: typeof fetch;
    env?: NodeJS.ProcessEnv;
  }>
): Promise<void> {
  const env = ports.env ?? process.env;
  const selected = env[PREPARED_SUBSCRIPTION_TRANSPORT_ENV];
  delete env[PREPARED_SUBSCRIPTION_TRANSPORT_ENV];
  if (selected !== 'runner_local_anthropic' && selected !== 'hosted_pool')
    throw new Error('prepared_subscription_transport_invalid');
  const run = new AbortController();
  const cancel = () => run.abort(new Error('prepared_subscription_cancelled'));
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  let claude:
    | ReturnType<typeof prepareClaudeSubscriptionCredential>
    | undefined;
  let originalGrant: string | undefined;
  try {
    // Parent-only grant, issued by the existing Hosted adapter. It is not an
    // upstream provider credential and cannot mint another account allowance.
    if (selected === 'hosted_pool') {
      originalGrant = env[HOSTED_ORIGINAL_GRANT_ENV];
      delete env[HOSTED_ORIGINAL_GRANT_ENV];
      if (
        !originalGrant ||
        originalGrant.length > 8192 ||
        /[\s\u0000-\u001f]/u.test(originalGrant)
      )
        throw new Error('hosted_original_grant_invalid');
      core.setSecret(originalGrant);
    }
    const result = await runPreparedModelReview(input, {
      transport: selected,
      signal: run.signal,
      fetchImpl: ports.fetchImpl,
      review: ports.review,
      async prepareTransport(context) {
        if (selected === 'runner_local_anthropic') {
          claude = prepareClaudeSubscriptionCredential({
            env,
            signal: context.signal,
          });
          return prepareClaudeSubscriptionModelRoute({
            ...context,
            credential: claude,
            fetchImpl: ports.fetchImpl,
          });
        }
        if (context.modelDispatch.capability.wireProtocol !== 'codex-responses')
          throw new Error('hosted_admitted_route_invalid');
        return startHostedPoolCodexModelTransport({
          apiUrl: input.apiUrl,
          authorization: () =>
            context.controlPlane.currentAuthorization().authorizationToken,
          readGrant: () => {
            if (!originalGrant) throw new Error('hosted_original_grant_closed');
            return originalGrant;
          },
          modelDispatch: context.modelDispatch,
          reasoningEffort:
            context.runtimeConfig.runtimeEnv.CODEX_REASONING_EFFORT ?? null,
          signal: context.signal,
        });
      },
    });
    run.signal.throwIfAborted();
    await ports.terminalReview(result, run.signal);
  } finally {
    claude?.dispose();
    originalGrant = undefined;
    delete env[HOSTED_ORIGINAL_GRANT_ENV];
    clearCodexRotatingOidcRequestEnv(env);
    clearCodexRotatingProcessAuthEnv(env);
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
