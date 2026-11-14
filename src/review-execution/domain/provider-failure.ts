import { confirmedProviderQuota } from './provider-quota';

/** Display only closed failure/effect facts, never upstream error prose. */
export type ProviderFailureNotice =
  | 'upstream_failure'
  | 'upstream_failure_unknown'
  | 'request_outcome_unknown'
  | 'output_truncated'
  | 'output_invalid';

export function confirmedProviderFailure(
  fact: unknown
): ProviderFailureNotice | undefined {
  if (!fact || typeof fact !== 'object') return undefined;
  const value = fact as Record<string, unknown>;
  if (value.code === 'output_truncated' && value.effect === 'completed')
    return 'output_truncated';
  if (
    value.effect === 'effect_unknown' ||
    value.effect === 'dispatch_started' ||
    value.effect === 'response_started'
  )
    // The effect proves uncertainty, not that the upstream caused it. Never
    // infer a 502, quota exhaustion or permission to replay from this notice.
    return value.code === 'upstream_failure'
      ? 'upstream_failure_unknown'
      : confirmedProviderQuota(fact) !== undefined
        ? undefined
        : 'request_outcome_unknown';
  if (value.code !== 'upstream_failure') return undefined;
  return value.effect === 'not_dispatched' ||
    value.effect === 'rejected_before_dispatch'
    ? 'upstream_failure'
    : undefined;
}

export function providerFailureMessage(
  notice: unknown,
  incompleteReview = false
): string | undefined {
  if (notice === 'output_invalid')
    return 'The provider response did not satisfy the required review format or evidence checks. This review is incomplete and does not approve the changes.';
  if (notice === 'output_truncated')
    return 'The provider reached its output token limit before producing a complete result. This review is incomplete and does not approve the changes.';
  if (
    notice !== 'upstream_failure' &&
    notice !== 'upstream_failure_unknown' &&
    notice !== 'request_outcome_unknown'
  )
    return undefined;
  return (
    (notice === 'request_outcome_unknown'
      ? 'The review request did not produce a confirmed result. '
      : 'The review provider could not return a usable result. ') +
    (notice === 'upstream_failure_unknown'
      ? 'The outcome of the failed provider request is unknown. '
      : notice === 'request_outcome_unknown'
        ? 'The request may have reached the provider. '
        : '') +
    (notice === 'upstream_failure_unknown' ||
    notice === 'request_outcome_unknown'
      ? 'Automatic retry was withheld to avoid running the request twice. '
      : '') +
    (incompleteReview
      ? 'This review is incomplete and does not approve the changes. '
      : 'An incomplete review does not approve the changes. ') +
    'Wait for this run to finish, then start a new review.'
  );
}
