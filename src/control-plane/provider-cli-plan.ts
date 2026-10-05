import type { RuntimeConfigResult } from './runtime-config';

export type ProviderCliPlan = {
  readonly codexCliNeeded: boolean;
  readonly codexOauthNeeded: boolean;
  readonly claudeCliNeeded: boolean;
};

const gatewaySessionMode = 'account-gateway';
const gatewayAuthMode = 'codex-account-gateway';

// The workflow mode selects an entrypoint; only applied OIDC config authorizes it.
export function prepareRuntimePreflight(
  env: NodeJS.ProcessEnv = process.env
): void {
  if (
    env.RR_CODEX_SESSION_MODE !== gatewaySessionMode &&
    env.REVIEW_AUTH_MODE !== gatewayAuthMode
  ) {
    return;
  }
  if (
    env.REVIEWROUTER_RUNTIME_CONFIG_MODE !== 'oidc' ||
    env.REVIEWROUTER_STATIC_CONFIG_FALLBACK !== 'false'
  ) {
    throw new Error('account_gateway_requires_oidc_without_static_fallback');
  }
  // Missing server auth mode must not inherit a caller's static gateway claim.
  delete env.REVIEW_AUTH_MODE;
}

export function resolveRuntimePreflightPlan(
  runtimeConfig: RuntimeConfigResult | undefined,
  env: NodeJS.ProcessEnv = process.env
): ProviderCliPlan & { readonly accountGatewayNeeded: boolean } {
  const gatewayRequested = env.RR_CODEX_SESSION_MODE === gatewaySessionMode;
  const gatewayConfigured = env.REVIEW_AUTH_MODE === gatewayAuthMode;
  if (gatewayRequested || gatewayConfigured) {
    if (
      env.REVIEWROUTER_RUNTIME_CONFIG_MODE !== 'oidc' ||
      env.REVIEWROUTER_STATIC_CONFIG_FALLBACK !== 'false' ||
      runtimeConfig?.status !== 'applied' ||
      !gatewayConfigured
    ) {
      throw new Error('account_gateway_requires_authenticated_applied_config');
    }
    if (!gatewayRequested) {
      throw new Error('account_gateway_workflow_mode_mismatch');
    }
  }
  return {
    ...resolveProviderCliPlan(env),
    accountGatewayNeeded: gatewayConfigured,
  };
}

export function resolveProviderCliPlan(
  env: NodeJS.ProcessEnv = process.env
): ProviderCliPlan {
  const authMode = (env.REVIEW_AUTH_MODE || '').trim();
  if (authMode === gatewayAuthMode) {
    return {
      codexCliNeeded: true,
      codexOauthNeeded: false,
      claudeCliNeeded: false,
    };
  }
  const explicitProviders = parseProviderList(env.REVIEW_PROVIDERS);
  const inferredProvider =
    explicitProviders.length === 0
      ? inferredProviderFromEnv(authMode, env)
      : undefined;
  const providerHints = [
    ...explicitProviders,
    env.FALLBACK_PROVIDERS,
    env.SYNTHESIS_MODEL,
    inferredProvider,
  ]
    .filter((value): value is string => Boolean(value))
    .join(',');

  const codexProviderRequested = hasProviderPrefix(providerHints, 'codex');
  const openRouterProviderRequested = hasProviderPrefix(
    providerHints,
    'openrouter'
  );

  return {
    codexCliNeeded:
      authMode === 'codex-oauth' ||
      authMode === 'openai-api' ||
      authMode === 'openrouter-api' ||
      codexProviderRequested ||
      openRouterProviderRequested,
    codexOauthNeeded: authMode === 'codex-oauth',
    claudeCliNeeded:
      authMode === 'claude-oauth' || hasProviderPrefix(providerHints, 'claude'),
  };
}

function parseProviderList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function providerFromModel(
  providerPrefix: 'codex' | 'claude',
  value: string | undefined
): string | undefined {
  const model = value?.trim();
  if (!model) {
    return undefined;
  }
  return model.startsWith(`${providerPrefix}/`)
    ? model
    : `${providerPrefix}/${model}`;
}

function inferredProviderFromEnv(
  authMode: string,
  env: NodeJS.ProcessEnv
): string | undefined {
  const claudeProvider = providerFromModel('claude', env.CLAUDE_MODEL);
  const codexProvider = providerFromModel('codex', env.CODEX_MODEL);
  switch (authMode) {
    case 'claude-oauth':
      return claudeProvider || 'claude/sonnet';
    case 'codex-oauth':
    case 'openai-api':
      return codexProvider || 'codex/gpt-5.6-sol';
    default:
      return claudeProvider || codexProvider;
  }
}

function hasProviderPrefix(value: string, providerPrefix: string): boolean {
  return value
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .some((part) => part.startsWith(`${providerPrefix}/`));
}
