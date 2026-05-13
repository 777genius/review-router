export type ProviderCliPlan = {
  readonly codexCliNeeded: boolean;
  readonly claudeCliNeeded: boolean;
};

export function resolveProviderCliPlan(
  env: NodeJS.ProcessEnv = process.env
): ProviderCliPlan {
  const authMode = (env.REVIEW_AUTH_MODE || '').trim();
  const providerHints = [
    env.REVIEW_PROVIDERS,
    env.FALLBACK_PROVIDERS,
    env.SYNTHESIS_MODEL,
    providerFromModel('codex', env.CODEX_MODEL),
    providerFromModel('claude', env.CLAUDE_MODEL),
    inferredProviderFromAuthMode(authMode),
  ]
    .filter((value): value is string => Boolean(value))
    .join(',');

  return {
    codexCliNeeded:
      authMode === 'codex-oauth' ||
      authMode === 'openai-api' ||
      hasProviderPrefix(providerHints, 'codex'),
    claudeCliNeeded:
      authMode === 'claude-oauth' || hasProviderPrefix(providerHints, 'claude'),
  };
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

function inferredProviderFromAuthMode(authMode: string): string | undefined {
  switch (authMode) {
    case 'claude-oauth':
      return 'claude/sonnet';
    case 'codex-oauth':
    case 'openai-api':
      return 'codex/gpt-5.5';
    default:
      return undefined;
  }
}

function hasProviderPrefix(value: string, providerPrefix: string): boolean {
  return value
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .some((part) => part.startsWith(`${providerPrefix}/`));
}
