import { resolveRevalidationConfidenceThresholds } from '../../finding-revalidation/domain/resolve-confidence-policy';
import {
  CurrentLifecycleInventory,
  LifecycleTargetDisposition,
  LifecycleRevalidationVerdict,
  LifecycleVerificationContext,
  LifecycleVerificationFact,
  PriorLineageHint,
  ProjectionCoverageState,
  ReviewCoverageFact,
} from './review-projection';

/** Rebind accepted evidence to this projection's fresh, exact-head inventory. */
export function projectLifecycleVerification(input: {
  readonly context: LifecycleVerificationContext;
  readonly inventory: CurrentLifecycleInventory;
  readonly coverage: ReviewCoverageFact;
  readonly priorLineageHints: readonly PriorLineageHint[];
  readonly authoritativeObservationIds: readonly string[];
  readonly recurrenceVetoTargetIds: readonly string[];
}): readonly LifecycleVerificationFact[] {
  const { context, inventory } = input;
  const roster = new Set(context.plannedProviderVoteKeys);
  if (
    roster.size !== context.plannedProviderVoteKeys.length ||
    [...roster].some((key) => !key)
  ) {
    throw new Error('lifecycle verification roster invalid');
  }
  const verificationTargets = inventory.targets.filter(
    (target) =>
      target.disposition !== LifecycleTargetDisposition.CommandSuppressed
  );
  return verificationTargets.map((target) => {
    const hints = input.priorLineageHints.filter(
      (hint) => hint.active && hint.lineageId === target.trustedMarker
    );
    const accepted = context.observations.filter(
      (observation) =>
        observation.targetId === target.targetId &&
        roster.has(observation.providerVoteKey) &&
        input.authoritativeObservationIds.includes(observation.observationId) &&
        observation.reviewedHeadSha === inventory.loadedForHeadSha &&
        observation.threadId === target.threadId &&
        observation.fingerprint === target.trustedMarker &&
        observation.threadStateHash === target.threadStateHash &&
        observation.parentCommentUpdatedAt === target.parentCommentUpdatedAt
    );
    // More than one response by one identity must never manufacture quorum.
    const byIdentity = new Map<string, typeof accepted>();
    for (const observation of accepted) {
      byIdentity.set(observation.providerVoteKey, [
        ...(byIdentity.get(observation.providerVoteKey) ?? []),
        observation,
      ]);
    }
    const votes = [...byIdentity.values()]
      .filter((items) => items.length === 1)
      .flat();
    const veto = input.recurrenceVetoTargetIds.includes(target.targetId);
    const safe =
      inventory.complete &&
      target.disposition === LifecycleTargetDisposition.Active;
    const threshold = resolveRevalidationConfidenceThresholds(
      context.resolveConfidence
    )[target.severity];
    const resolved =
      safe &&
      !veto &&
      roster.size > 0 &&
      votes.length === roster.size &&
      votes.every(
        (vote) =>
          vote.verdict === LifecycleRevalidationVerdict.Resolved &&
          (vote.confidence ?? 0) >= threshold
      );
    const open =
      safe &&
      votes.some(
        (vote) => vote.verdict === LifecycleRevalidationVerdict.StillValid
      );
    const semanticVerdict = resolved
      ? LifecycleRevalidationVerdict.Resolved
      : open
        ? LifecycleRevalidationVerdict.StillValid
        : LifecycleRevalidationVerdict.Uncertain;
    const partial = input.coverage.state === ProjectionCoverageState.Partial;
    return {
      targetId: target.targetId,
      ...(hints.length === 1 ? { lineageId: hints[0].lineageId } : {}),
      semanticVerdict,
      confirmationState: resolved
        ? 'fix_confirmed_thread_open'
        : open
          ? 'confirmed_open'
          : 'unverified',
      severity: target.severity,
      observationIds: [
        ...new Set(votes.map((vote) => vote.observationId)),
      ].sort(),
      providerVoteKeys: [
        ...new Set(votes.map((vote) => vote.providerVoteKey)),
      ].sort(),
      reasonCodes: [
        ...new Set([
          ...(context.targetReasonCodes?.[target.targetId] ?? []),
          ...votes.flatMap((vote) => vote.reasonCodes),
          ...(veto ? ['current_finding_present'] : []),
          ...(!safe
            ? [
                target.disposition === LifecycleTargetDisposition.HumanReply
                  ? 'human_reply'
                  : 'verification_ineligible',
              ]
            : []),
          ...(!resolved && !open
            ? [
                votes.length
                  ? 'verification_uncertain'
                  : 'missing_or_stale_verification',
              ]
            : []),
        ]),
      ].sort(),
      mutationStatus: resolved
        ? partial
          ? 'blocked_partial_review'
          : context.mode === 'report'
            ? 'report_only'
            : target.viewerCanResolve
              ? 'pending'
              : 'not_eligible'
        : 'not_eligible',
    } satisfies LifecycleVerificationFact;
  });
}
