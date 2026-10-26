import * as core from '../actions/core';
import type { AdmittedRuntimeConfig } from '../control-plane/runtime-config';
import {
  isClaudeSubscriptionSetupToken,
  type ClaudeSubscriptionCredentialLifetime,
} from '../providers/claude-subscription-credential';
import type { PreparedModelDispatch } from '../review-orchestration/infrastructure/prepared-model-dispatch';
import { startRunnerLocalAnthropicModelTransport } from '../review-orchestration/infrastructure/runner-local-anthropic-model-transport';
import { readApprovedOcrReviewAgent } from './ocr-managed-bootstrap';

const CLAUDE_SECRET_INPUTS = [
  'INPUT_CLAUDE_CODE_OAUTH_TOKEN',
  'INPUT_CLAUDE-CODE-OAUTH-TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const;

export type PreparedClaudeSubscriptionCredential = Readonly<{
  lifetime: ClaudeSubscriptionCredentialLifetime;
  readToken(): string;
  dispose(): void;
}>;

/** Capture the existing GitHub secret exactly once, without a login, probe,
 * refresh, host credential lookup, or fabricated remaining lifetime. The native
 * provider validates this same opaque token on each budgeted model request.
 * Docs: code.claude.com/docs/en/authentication#generate-a-long-lived-token and
 * code.claude.com/docs/en/errors#oauth-token-revoked-or-expired. */
export function prepareClaudeSubscriptionCredential(
  input: {
    readonly env?: NodeJS.ProcessEnv;
    readonly signal?: AbortSignal;
  } = {}
): PreparedClaudeSubscriptionCredential {
  const env = input.env ?? process.env;
  const values: string[] = [];
  for (const name of CLAUDE_SECRET_INPUTS) {
    const raw = env[name];
    delete env[name];
    if (raw !== undefined) values.push(raw);
  }
  for (const raw of values) if (raw) core.setSecret(raw);
  input.signal?.throwIfAborted();
  let token = values[0]?.trim() ?? '';
  if (
    !isClaudeSubscriptionSetupToken(token) ||
    values.some((value) => value.trim() !== token)
  )
    throw new Error('claude_subscription_secret_invalid');
  // Also mask the normalized value when a pasted secret had surrounding space.
  core.setSecret(token);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    token = '';
    input.signal?.removeEventListener('abort', dispose);
  };
  input.signal?.addEventListener('abort', dispose, { once: true });
  if (input.signal?.aborted) dispose();
  return Object.freeze({
    lifetime: Object.freeze({ kind: 'opaque_provider_validated' as const }),
    readToken: () => {
      input.signal?.throwIfAborted();
      if (disposed) throw new Error('claude_subscription_credential_disposed');
      return token;
    },
    dispose,
  });
}

/** Called only after the authenticated common model-route checkout. Selection
 * remains the server-captured configured alias; cap.model is its exact native
 * model resolved by the trusted producer's frozen qualification map. No alias
 * is resolved from today's CLI, environment, model list, or response prefix. */
export async function prepareClaudeSubscriptionModelRoute(input: {
  readonly runtimeConfig: AdmittedRuntimeConfig;
  readonly modelDispatch: PreparedModelDispatch;
  readonly credential: PreparedClaudeSubscriptionCredential;
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
}) {
  try {
    input.signal?.throwIfAborted();
    const env = input.runtimeConfig.runtimeEnv;
    const cap = input.modelDispatch.capability;
    const configuredModel = cap.configuredModel ?? cap.model;
    const agent = readApprovedOcrReviewAgent(
      env.REVIEW_ROUTER_AGENT_PROFILE_JSON ?? '',
      env.REVIEW_ROUTER_AGENT_PROFILE_DIGEST ?? ''
    );
    if (
      cap.transport !== 'runner_local_anthropic' ||
      cap.wireProtocol !== 'anthropic-messages' ||
      cap.outputTokenLimit !== 'upstream_request' ||
      !agent.modelTransports.includes('provider_api') ||
      env.REVIEW_AUTH_MODE !== 'claude-oauth' ||
      env.CLAUDE_MODEL !== configuredModel ||
      env.REVIEW_PROVIDERS !== `claude/${configuredModel}` ||
      !['sonnet', 'opus', 'haiku'].includes(configuredModel) ||
      !/^claude-[a-z0-9][a-z0-9-]{1,127}$/.test(cap.model)
    )
      throw new Error('claude_subscription_admitted_route_invalid');
    const transport = await startRunnerLocalAnthropicModelTransport({
      readToken: () => input.credential.readToken(),
      credentialLifetime: input.credential.lifetime,
      modelDispatch: input.modelDispatch,
      deadlineMs: input.deadlineMs,
      signal: input.signal,
      fetchImpl: input.fetchImpl,
    });
    return Object.freeze({
      ...transport,
      dispose: async () => {
        try {
          await transport.dispose();
        } finally {
          input.credential.dispose();
        }
      },
    });
  } catch (error) {
    input.credential.dispose();
    throw error;
  }
}
