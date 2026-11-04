/** Display evidence from a closed upstream failure fact, never error prose. */
export type ProviderFailureNotice =
  | 'upstream_failure'
  | 'upstream_failure_unknown';

export function confirmedProviderFailure(
  fact: unknown
): ProviderFailureNotice | undefined {
  if (!fact || typeof fact !== 'object') return undefined;
  const value = fact as Record<string, unknown>;
  if (value.code !== 'upstream_failure') return undefined;
  if (
    value.effect === 'effect_unknown' ||
    value.effect === 'dispatch_started' ||
    value.effect === 'response_started'
  )
    return 'upstream_failure_unknown';
  return value.effect === 'not_dispatched' ||
    value.effect === 'rejected_before_dispatch'
    ? 'upstream_failure'
    : undefined;
}

export function providerFailureMessage(
  notice: unknown,
  incompleteReview = false
): string | undefined {
  if (notice !== 'upstream_failure' && notice !== 'upstream_failure_unknown')
    return undefined;
  return (
    'The review provider could not return a usable result. ' +
    (notice === 'upstream_failure_unknown'
      ? 'The outcome of the failed provider request is unknown. '
      : '') +
    (incompleteReview
      ? 'This review is incomplete and does not approve the changes. '
      : 'An incomplete review does not approve the changes. ') +
    'Wait for this run to finish, then start a new review.'
  );
}
