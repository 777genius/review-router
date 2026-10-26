import { createHash } from 'node:crypto';
import {
  RestoredReviewWorkSlotState,
  ReviewExecutionProviderKind,
  ReviewTaskKind,
  type RestoredReviewExecution,
  type PreparedReviewInvocation,
  type PreparedReviewInvocationPort,
  type ProviderInvocationManifestAssemblerPort,
  type PreparedReviewInvocationManifestFacts,
} from '../application';
import {
  createReviewPromptCoverageManifest,
  createProviderVisibleReviewCoverage,
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
  const satisfied = new Set(
    restored.workSlots
      .filter((slot) => slot.state === RestoredReviewWorkSlotState.Satisfied)
      .map((slot) => slot.workSlotId)
  );
  return {
    async prepare(input): Promise<PreparedReviewInvocation> {
      const original = manifests.get(input.workSlot.workSlotId);
      if (
        input.workSlot.taskKind !== ReviewTaskKind.LifecycleRevalidation &&
        !satisfied.has(input.workSlot.workSlotId)
      )
        return discovery.prepare(input);
      if (!original || input.attemptOrdinal !== 1)
        throw new Error('review_restore_accepted_manifest_unavailable');
      const wire = JSON.parse(
        original.manifestCanonicalJson
      ) as PreparedReviewInvocationManifestFacts & { requestedModel: string };
      if (
        !wire.taskKindSet.includes(input.workSlot.taskKind) ||
        wire.providerKind !== input.workSlot.providerKind ||
        original.providerVoteIdentityHash !==
          input.workSlot.providerVoteIdentityHash
      )
        throw new Error('review_restore_accepted_manifest_scope_mismatch');
      const coverage =
        input.workSlot.taskKind === ReviewTaskKind.LifecycleRevalidation
          ? createReviewPromptCoverageManifest({
              workSlotId: input.workSlot.workSlotId,
              reviewRevisionHash: restored.reviewRevisionHash,
              assignedPaths: [],
              pathCoverage: [],
            })
          : await restoreDiscoveryCoverage(discovery, input, wire);
      return Object.freeze({
        workSlotId: input.workSlot.workSlotId,
        attemptOrdinal: 1,
        provider: `restored-lifecycle/${input.workSlot.providerKind}`,
        requestedModel: wire.requestedModel,
        reviewPrompt: '',
        investigationContextPrompt: null,
        immutableRequest: null,
        manifestFacts: wire,
        coverageManifest: coverage,
        investigationProbePlan: null,
      });
    },
    async execute(input) {
      if (
        satisfied.has(input.invocation.workSlotId) ||
        (input.invocation.manifestFacts.taskKindSet.length === 1 &&
          input.invocation.manifestFacts.taskKindSet[0] ===
            ReviewTaskKind.LifecycleRevalidation)
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
      const satisfied = restored.workSlots.some(
        (slot) =>
          slot.workSlotId === invocation.workSlotId &&
          slot.state === RestoredReviewWorkSlotState.Satisfied
      );
      if (
        !satisfied &&
        (invocation.manifestFacts.taskKindSet.length !== 1 ||
          invocation.manifestFacts.taskKindSet[0] !==
            ReviewTaskKind.LifecycleRevalidation)
      )
        return discovery.assemble(invocation);
      const original = manifests.get(invocation.workSlotId);
      if (!original)
        throw new Error('review_restore_accepted_manifest_unavailable');
      return original;
    },
  };
}

/** Rebuild only memory-independent coverage and verify its original commitments.
 * The previous prompt/body is never reconstructed or passed to inference. */
async function restoreDiscoveryCoverage(
  discovery: PreparedReviewInvocationPort,
  input: Parameters<PreparedReviewInvocationPort['prepare']>[0],
  original: PreparedReviewInvocationManifestFacts
) {
  const rebuilt = await discovery.prepare(input);
  const preimages = (
    rebuilt as PreparedReviewInvocation & {
      readonly manifestPreimages?: {
        readonly filePatchManifestHash?: unknown;
        readonly contextManifestHash?: unknown;
      };
    }
  ).manifestPreimages;
  if (
    rebuilt.manifestFacts.memoryBundleHash != null ||
    typeof preimages?.filePatchManifestHash !== 'string' ||
    typeof preimages.contextManifestHash !== 'string' ||
    hash(preimages.filePatchManifestHash) !== original.filePatchManifestHash ||
    rebuilt.manifestFacts.filePatchManifestHash !==
      original.filePatchManifestHash ||
    hash(preimages.contextManifestHash) !==
      rebuilt.manifestFacts.contextManifestHash
  )
    throw new Error('review_restore_coverage_commitment_mismatch');
  const context = JSON.parse(preimages.contextManifestHash) as Record<
    string,
    unknown
  >;
  if (
    !context ||
    typeof context !== 'object' ||
    Array.isArray(context) ||
    context.memoryBundleHash != null
  )
    throw new Error('review_restore_coverage_commitment_mismatch');
  const coverageHash =
    rebuilt.manifestFacts.providerKind === ReviewExecutionProviderKind.Ocr
      ? rebuilt.coverageManifest.coverageHash
      : createProviderVisibleReviewCoverage(rebuilt.coverageManifest)
          .coverageHash;
  if (context.coverageHash !== coverageHash)
    throw new Error('review_restore_coverage_commitment_mismatch');
  if (original.memoryBundleHash != null)
    context.memoryBundleHash = original.memoryBundleHash;
  if (hash(canonicalJson(context)) !== original.contextManifestHash)
    throw new Error('review_restore_coverage_commitment_mismatch');
  return rebuilt.coverageManifest;
}
function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
      )
      .join(',')}}`;
  return JSON.stringify(value);
}
