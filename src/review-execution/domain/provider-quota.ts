/** Safe provider quota evidence, independent of transport and error prose. */
export type ProviderQuota = Readonly<{
  provider: 'openrouter';
  limit: number;
  remaining: 0;
  resetAt: string;
}>;

export function parseProviderQuota(value: unknown): ProviderQuota | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const quota = value as Record<string, unknown>;
  if (
    quota.provider !== 'openrouter' ||
    !Number.isSafeInteger(quota.limit) ||
    (quota.limit as number) <= 0 ||
    quota.remaining !== 0 ||
    typeof quota.resetAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(quota.resetAt) ||
    !Number.isFinite(Date.parse(quota.resetAt)) ||
    new Date(quota.resetAt).toISOString() !== quota.resetAt
  )
    return undefined;
  return {
    provider: 'openrouter',
    limit: quota.limit as number,
    remaining: 0,
    resetAt: quota.resetAt,
  };
}

export function confirmedProviderQuota(
  fact: unknown
): ProviderQuota | undefined {
  if (!fact || typeof fact !== 'object') return undefined;
  const value = fact as Record<string, unknown>;
  return value.code === 'provider_quota_exhausted'
    ? parseProviderQuota(value.providerQuota)
    : undefined;
}

export function providerQuotaMessage(quota: ProviderQuota): string {
  return `Provider request quota exhausted; try after ${quota.resetAt}.`;
}
