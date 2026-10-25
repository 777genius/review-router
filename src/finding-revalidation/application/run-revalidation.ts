import {
  AcceptedRevalidation,
  LifecycleInference,
  RevalidationPlan,
  RevalidationReason,
} from '../domain/contracts';
import { prepareLifecycleRequest, REVALIDATION_LIMITS } from '../domain/packet';
import { validateLifecycleResponse } from '../domain/validate-response';

export type RevalidationRunResult = Readonly<{
  plan: RevalidationPlan;
  accepted: readonly Readonly<{
    packetHash: string;
    voteIdentityHash: string;
    result: AcceptedRevalidation;
  }>[];
  unverified: readonly Readonly<{
    targetId: string;
    reason: RevalidationReason;
  }>[];
}>;
/** Executes each immutable assignment once. Retries and re-selection are deliberately absent. */
export async function runFindingRevalidation(
  plan: RevalidationPlan,
  inference: LifecycleInference,
  signal: AbortSignal,
  maxResponseBytes = plan.maxResponseBytes
): Promise<RevalidationRunResult> {
  const accepted: {
    packetHash: string;
    voteIdentityHash: string;
    result: AcceptedRevalidation;
  }[] = [];
  const unverified = plan.dispositions
    .filter(
      (item) =>
        item.disposition !== 'eligible' && item.disposition !== 'resolved'
    )
    .map((item) => ({ targetId: item.targetId, reason: item.reason }));
  // A responder never creates or shrinks the declared participant roster.
  if (
    plan.participantRoster.length !== 1 ||
    plan.packets.length > REVALIDATION_LIMITS.packets ||
    new Set(
      plan.packets.flatMap((packet) =>
        packet.targets.map((target) => target.witness.targetId)
      )
    ).size !== plan.packets.reduce((n, packet) => n + packet.targets.length, 0)
  ) {
    for (const packet of plan.packets)
      for (const target of packet.targets)
        unverified.push({
          targetId: target.witness.targetId,
          reason: 'missing_or_invalid_verdict',
        });
    return { plan, accepted, unverified };
  }
  for (const packet of plan.packets) {
    let reason: RevalidationReason = 'verification_failed';
    try {
      if (
        signal.aborted ||
        packet.participant.voteIdentityHash !==
          plan.participantRoster[0]!.voteIdentityHash ||
        packet.participant.model !== plan.participantRoster[0]!.model ||
        packet.participant.capabilityDigest !==
          plan.participantRoster[0]!.capabilityDigest
      )
        throw new Error('verification_failed');
      const prepared = prepareLifecycleRequest(packet, plan.outputCap);
      const callSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(REVALIDATION_LIMITS.timeoutMs),
      ]);
      const response = await inference.infer(prepared, callSignal);
      const validation = validateLifecycleResponse(
        response.body,
        prepared,
        response.actualModel,
        response.requestHash,
        Math.min(maxResponseBytes, plan.maxResponseBytes)
      );
      if (validation.valid) {
        for (const result of validation.results)
          accepted.push({
            packetHash: packet.packetHash,
            voteIdentityHash: packet.participant.voteIdentityHash,
            result,
          });
        continue;
      }
      reason = validation.reason;
    } catch {
      // Safe reason only: adapter/provider exceptions can contain raw credentials.
    }
    for (const target of packet.targets)
      unverified.push({ targetId: target.witness.targetId, reason });
  }
  return { plan, accepted, unverified };
}
