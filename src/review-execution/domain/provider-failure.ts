import { confirmedProviderQuota } from './provider-quota';

/** Display only closed failure/effect facts, never upstream error prose. */
export type ProviderFailureNotice =
  | 'upstream_failure'
  | 'upstream_failure_unknown'
  | 'request_outcome_unknown'
  | 'output_truncated'
  | 'request_budget_reached'
  | 'output_invalid';

export function confirmedProviderFailure(
  fact: unknown
): ProviderFailureNotice | undefined {
  if (!fact || typeof fact !== 'object') return undefined;
  const value = fact as Record<string, unknown>;
  if (value.code === 'output_truncated' && value.effect === 'completed')
    return 'output_truncated';
  if (
    value.code === 'model_dispatch_budget_exhausted' &&
    value.effect === 'not_dispatched'
  )
    return 'request_budget_reached';
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

/** A known stop that ends only the rest of a run: one model turn hit the
 * output limit, or the run used its whole request allowance. What the earlier
 * requests produced stays usable; the review is reported as incomplete. */
export function partialRunStop(
  fact: unknown
): 'output_truncated' | 'request_budget_reached' | undefined {
  const notice = confirmedProviderFailure(fact);
  return notice === 'output_truncated' || notice === 'request_budget_reached'
    ? notice
    : undefined;
}

export function providerFailureMessage(
  notice: unknown,
  incompleteReview = false
): string | undefined {
  if (notice === 'output_invalid')
    return 'A verification response did not satisfy the required format or evidence checks. The affected findings remain unverified and are not confirmed as fixed.';
  if (notice === 'output_truncated')
    return incompleteReview
      ? 'The provider reached its output token limit before producing a complete result. This review is incomplete and does not approve the changes.'
      : 'The provider reached its output token limit before completing a response. The affected result is incomplete.';
  if (notice === 'request_budget_reached')
    return incompleteReview
      ? 'The review used its whole allowance of model requests before it reached every file, so its findings cover only part of the changes. This review is incomplete and does not approve the changes.'
      : 'The review used its whole allowance of model requests before it finished. The result is incomplete.';
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
