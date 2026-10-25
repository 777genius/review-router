import {
  ReviewTaskKind,
  type RestoredReviewExecution,
  type PreparedReviewInvocation,
  type PreparedReviewInvocationPort,
  type ProviderInvocationManifestAssemblerPort,
  type PreparedReviewInvocationManifestFacts,
} from '../application';
import {
  createReviewPromptCoverageManifest,
  type StableReviewWorkPlan,
} from '../domain';
import type { ReviewConfig } from '../../types';
import type { TargetWitness, VerifyPacket } from '../../finding-revalidation';
import type { ProductionLifecycleVerificationPlan } from './production-review-projection';
import { restorePersistedWorkPlan } from './lifecycle-verification-invocation';

/** Uses stored witness/assignment ownership; current inventory is consulted only by projection guards. */
export function restoreProductionLifecycleVerification(
  restored: RestoredReviewExecution,
  original: StableReviewWorkPlan,
  config: ReviewConfig
) {
  const plan = restorePersistedWorkPlan(restored, original);
  const manifest = JSON.parse(plan.assignmentManifestCanonicalJson) as {
    lifecyclePlan?: {
      participantRoster: { providerVoteIdentityHash: string }[];
      targets: TargetWitness[];
      assignments: {
        workSlotId: string;
        targetIds: string[];
        liveLifecycleStateHash: string;
      }[];
    };
  };
  const frozen = manifest.lifecyclePlan;
  const lifecycleVerification: ProductionLifecycleVerificationPlan | undefined =
    frozen
      ? {
          plannedProviderVoteKeys: frozen.participantRoster.map(
            (value) => value.providerVoteIdentityHash
          ),
          mode:
            config.reviewThreadLifecycle === 'resolve' ? 'resolve' : 'report',
          witnessesByTargetId: Object.fromEntries(
            frozen.targets.map((witness) => [
              witness.targetId,
              {
                threadId: witness.threadId,
                fingerprint: witness.fingerprint,
                parentUpdatedAt: witness.parentUpdatedAt,
                commentStateHash: witness.commentStateHash,
              },
            ])
          ),
          assignedTargetIdsByWorkSlotId: Object.fromEntries(
            frozen.assignments.map((value) => [
              value.workSlotId,
              value.targetIds,
            ])
          ),
        }
      : undefined;
  return {
    plan,
    packetsByWorkSlotId: new Map<string, VerifyPacket>(),
    outputCap: 0,
    liveLifecycleStateHash:
      frozen?.assignments[0]?.liveLifecycleStateHash ?? '0'.repeat(64),
    lifecycleVerification,
  };
}

/** Restored lifecycle evidence never rebuilds a packet, reads source, or becomes runnable inference. */
export function restoredLifecycleInvocations(
  restored: RestoredReviewExecution,
  discovery: PreparedReviewInvocationPort
): PreparedReviewInvocationPort {
  const manifests = new Map(
    restored.persistedPlan?.acceptedManifests?.map((value) => [
      value.workSlotId,
      value,
    ]) ?? []
  );
  return {
    async prepare(input): Promise<PreparedReviewInvocation> {
      if (input.workSlot.taskKind !== ReviewTaskKind.LifecycleRevalidation)
        return discovery.prepare(input);
      const original = manifests.get(input.workSlot.workSlotId);
      if (!original || input.attemptOrdinal !== 1)
        throw new Error('review_restore_accepted_manifest_unavailable');
      const wire = JSON.parse(
        original.manifestCanonicalJson
      ) as PreparedReviewInvocationManifestFacts & { requestedModel: string };
      if (
        wire.taskKindSet.length !== 1 ||
        wire.taskKindSet[0] !== ReviewTaskKind.LifecycleRevalidation ||
        wire.providerKind !== input.workSlot.providerKind ||
        original.providerVoteIdentityHash !==
          input.workSlot.providerVoteIdentityHash
      )
        throw new Error('review_restore_accepted_manifest_scope_mismatch');
      return Object.freeze({
        workSlotId: input.workSlot.workSlotId,
        attemptOrdinal: 1,
        provider: `restored-lifecycle/${input.workSlot.providerKind}`,
        requestedModel: wire.requestedModel,
        reviewPrompt: '',
        investigationContextPrompt: null,
        immutableRequest: null,
        manifestFacts: wire,
        coverageManifest: createReviewPromptCoverageManifest({
          workSlotId: input.workSlot.workSlotId,
          reviewRevisionHash: restored.reviewRevisionHash,
          assignedPaths: [],
          pathCoverage: [],
        }),
        investigationProbePlan: null,
      });
    },
    async execute(input) {
      if (
        input.invocation.manifestFacts.taskKindSet.length === 1 &&
        input.invocation.manifestFacts.taskKindSet[0] ===
          ReviewTaskKind.LifecycleRevalidation
      )
        throw new Error('review_restore_inference_forbidden');
      return discovery.execute(input);
    },
  };
}

export function restoredLifecycleManifestAssembler(
  restored: RestoredReviewExecution | null,
  discovery: ProviderInvocationManifestAssemblerPort
): ProviderInvocationManifestAssemblerPort {
  if (!restored?.persistedPlan) return discovery;
  const manifests = new Map(
    restored?.persistedPlan?.acceptedManifests?.map((value) => [
      value.workSlotId,
      value,
    ]) ?? []
  );
  return {
    async assemble(invocation) {
      if (
        invocation.manifestFacts.taskKindSet.length !== 1 ||
        invocation.manifestFacts.taskKindSet[0] !==
          ReviewTaskKind.LifecycleRevalidation
      )
        return discovery.assemble(invocation);
      const original = manifests.get(invocation.workSlotId);
      if (!original)
        throw new Error('review_restore_accepted_manifest_unavailable');
      return original;
    },
  };
}
