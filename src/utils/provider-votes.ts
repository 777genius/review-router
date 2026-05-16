import type { Finding, ProviderModelAttribution } from '../types';

const INSTANCE_SUFFIX = /#\d+$/;

export function stripProviderInstanceSuffix(value: string): string {
  return value.trim().replace(INSTANCE_SUFFIX, '');
}

export function normalizeProviderVoteKey(
  provider: string | undefined | null,
  actualModel?: string | null
): string | null {
  const normalizedProvider = provider
    ? stripProviderInstanceSuffix(provider)
    : undefined;
  if (!normalizedProvider) return null;

  if (normalizedProvider.startsWith('openrouter/')) {
    const normalizedActual = actualModel
      ? stripProviderInstanceSuffix(actualModel)
      : undefined;
    if (normalizedActual) {
      return normalizedActual.startsWith('openrouter/')
        ? normalizedActual
        : `openrouter/${normalizedActual}`;
    }
    return normalizedProvider;
  }

  return normalizedProvider;
}

export function getProviderVoteKeys(finding: Finding): string[] {
  const keys = new Set<string>();

  for (const key of finding.providerVoteKeys || []) {
    const normalized = normalizeProviderVoteKey(key);
    if (normalized) keys.add(normalized);
  }
  if (keys.size > 0) return Array.from(keys);

  const attributedProviders = new Set(
    (finding.providerModels || []).map((item) => item.provider)
  );

  for (const item of finding.providerModels || []) {
    const key = normalizeProviderVoteKey(item.provider, item.actualModel);
    if (key) keys.add(key);
  }

  for (const provider of finding.providers || []) {
    if (attributedProviders.has(provider)) continue;
    const key = normalizeProviderVoteKey(provider);
    if (key) keys.add(key);
  }

  if (!finding.provider || !attributedProviders.has(finding.provider)) {
    const primaryKey = normalizeProviderVoteKey(
      finding.provider,
      finding.actualModel
    );
    if (primaryKey) keys.add(primaryKey);
  }

  if (keys.size === 0) keys.add('static');
  return Array.from(keys);
}

export function getProviderVoteCount(finding: Finding): number {
  return getProviderVoteKeys(finding).length;
}

export function countProviderVotePool(
  providers: Array<string | { readonly name: string }>
): number {
  const keys = new Set<string>();

  for (const provider of providers) {
    const name = typeof provider === 'string' ? provider : provider.name;
    const key = normalizeProviderVoteKey(name);
    if (key) keys.add(key);
  }

  return keys.size;
}

export function mergeProviderModels(
  left: readonly ProviderModelAttribution[] | undefined,
  right: readonly ProviderModelAttribution[] | undefined
): ProviderModelAttribution[] {
  const merged = new Map<string, ProviderModelAttribution>();
  for (const item of [...(left || []), ...(right || [])]) {
    const key = `${item.provider}\0${item.actualModel || ''}`;
    merged.set(key, item);
  }
  return Array.from(merged.values());
}
