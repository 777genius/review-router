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
  const resetAt = quota.resetAt
    .replace('T', ' ')
    .replace(/:00\.000Z$/, ' UTC')
    .replace(/Z$/, ' UTC');
  return `OpenRouter request quota exhausted (0 of ${quota.limit} requests remaining). Try again after ${resetAt}.`;
}

/** A reviewer left out of required coverage because its provider quota ran out. */
export type ProviderQuotaSkippedReviewer = Readonly<{
  model: string;
  providerQuota: ProviderQuota;
}>;

export function providerQuotaSkipMessage(
  reviewer: ProviderQuotaSkippedReviewer
): string {
  return `Reviewer \`${reviewer.model}\` was skipped: ${providerQuotaMessage(reviewer.providerQuota)}`;
}

/**
 * Required work of a reviewer stopped by confirmed provider quota is skipped
 * only while another reviewer finished all of its required work. Every other
 * failure, or a run where no reviewer finished, keeps coverage partial. The
 * SaaS mirrors this rule in `deriveCoverageState` with its own recorded fact.
 */
export function providerQuotaSkippedVotes(input: {
  readonly requiredWorkSlots: readonly Readonly<{
    workSlotId: string;
    providerVoteIdentityHash: string;
  }>[];
  readonly acceptedWorkSlotIds: ReadonlySet<string>;
  readonly quotaVotes: ReadonlySet<string>;
}): ReadonlySet<string> {
  const openVotes = new Set(
    input.requiredWorkSlots
      .filter((slot) => !input.acceptedWorkSlotIds.has(slot.workSlotId))
      .map((slot) => slot.providerVoteIdentityHash)
  );
  const anotherReviewerCompleted = input.requiredWorkSlots.some(
    (slot) => !openVotes.has(slot.providerVoteIdentityHash)
  );
  return new Set(
    anotherReviewerCompleted
      ? [...openVotes].filter((vote) => input.quotaVotes.has(vote))
      : []
  );
}
