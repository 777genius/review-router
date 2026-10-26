import { createHash } from 'crypto';
import {
  lifecycleVerificationContract as contract,
  lifecycleVerificationDescriptorDigest,
  type LifecycleVerificationCapabilityV1,
} from '../../control-plane/generated/review-action-v2/companion-contracts';
import {
  parseLifecycleVerificationCapabilityV2,
  type LifecycleVerificationCapability,
} from '../../control-plane/generated/review-action-v2/review-lifecycle-verification-v2';
import type { ReviewModelDispatchCapabilityV2 } from '../../control-plane/generated/review-action-v2/review-model-dispatch-contract';
import {
  canonicalRevalidationJson as canonicalJson,
  prepareLifecycleRequest,
  validateLifecycleResponse,
  type RevalidationPlan,
  type VerifyPacket,
} from '../../finding-revalidation';
import {
  ReviewTaskKind,
  type PreparedReviewInvocation,
  type PreparedReviewInvocationPort,
  type ReviewExecutionProviderKind,
} from '../application';
import {
  createStableReviewWorkPlan,
  createReviewPromptCoverageManifest,
  type StableReviewWorkPlan,
} from '../domain';
import type { LocalGatewayModelTransport } from './account-gateway-model-transport';
import { normalizeReviewObservation } from './review-observation-normalizer';
import type { ProductionLifecycleVerificationPlan } from './production-review-projection';

export const lifecycleTargetWitnesses = (packet: VerifyPacket) =>
  packet.targets
    .map((target) => target.witness)
    .sort((left, right) => left.targetId.localeCompare(right.targetId));

export const lifecycleHash = (value: unknown): string =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');

export function readLifecycleCapability(
  json: string | undefined,
  model: string,
  providerKind: ReviewExecutionProviderKind,
  route?: ReviewModelDispatchCapabilityV2
): LifecycleVerificationCapability | undefined {
  if (!json || Buffer.byteLength(json, 'utf8') > 4096) return undefined;
  try {
    const raw = JSON.parse(json);
    if (raw?.extensionId === 'lifecycle-verification.v2') {
      const capability = parseLifecycleVerificationCapabilityV2(raw);
      if (
        !route ||
        capability.model !== model ||
        capability.providerKind !== providerKind ||
        capability.routeIdentityHash !== route.routeIdentityHash ||
        capability.modelTransport !== route.transport ||
        capability.model !== route.model
      )
        return undefined;
      return capability;
    }
    const value = raw as LifecycleVerificationCapabilityV1;
    if (
      value.extensionId !== contract.extensionId ||
      value.descriptorDigest !== lifecycleVerificationDescriptorDigest ||
      value.executor !== contract.executor ||
      value.modelTransport !== 'account_gateway' ||
      value.providerIndex !== 0 ||
      value.providerKind !== providerKind ||
      value.model !== model ||
      value.maxDispatches !== 2 ||
      value.attemptBudget !== 1
    )
      return undefined;
    for (const [key, limit] of Object.entries({
      maxPromptBytes: contract.maxPromptBytes,
      maxResponseBytes: contract.maxResponseBytes,
      maxOutputTokens: contract.maxOutputTokens,
      deadlineMs: contract.deadlineMs,
    })) {
      const bound = value[key as keyof LifecycleVerificationCapabilityV1];
      if (
        typeof bound !== 'number' ||
        !Number.isSafeInteger(bound) ||
        bound <= 0 ||
        bound > limit
      )
        return undefined;
    }
    return Object.freeze(value);
  } catch {
    return undefined;
  }
}

/** Adds bounded optional slots after every discovery slot. Failure leaves original discovery intact. */
export function appendLifecycleWorkPlan(input: {
  plan: StableReviewWorkPlan;
  revalidation: RevalidationPlan;
  capability: LifecycleVerificationCapability;
  reviewRevisionHash: string;
  compatibilityKey: string;
  maxWorkSlots: number;
  maxAttemptsPerSlot: number;
  policyDigest: string;
  liveLifecycleStateHash: string;
}): {
  plan: StableReviewWorkPlan;
  packetsByWorkSlotId: ReadonlyMap<string, VerifyPacket>;
  lifecycleVerification?: ProductionLifecycleVerificationPlan;
} {
  const original = input.plan;
  const empty = {
    plan: original,
    packetsByWorkSlotId: new Map<string, VerifyPacket>(),
  };
  const first = original.assignments[0];
  if (!first) return empty;
  const manifest = JSON.parse(original.assignmentManifestCanonicalJson) as {
    assignments: { workSlotId: string; paths: string[] }[];
    eligiblePaths: string[];
    excludedPaths: string[];
    uncoveredPaths: string[];
  };
  const paths = new Map(
    manifest.assignments.map((item) => [item.workSlotId, item.paths])
  );
  const discovery = original.assignments.filter(
    (item) => item.workSlot.taskKind !== ReviewTaskKind.PrDescription
  );
  const packets = input.revalidation.packets.slice(
    0,
    Math.max(0, input.maxWorkSlots - discovery.length)
  );
  const batches = discovery.map((item, schedulingOrdinal) => ({
    batchId: item.batchId,
    taskKind: item.workSlot.taskKind,
    required: item.workSlot.required,
    paths: paths.get(item.workSlot.workSlotId) ?? [],
    schedulingOrdinal,
  }));
  packets.forEach((packet, index) =>
    batches.push({
      batchId: packet.packetHash,
      taskKind: ReviewTaskKind.LifecycleRevalidation,
      required: false,
      paths: [],
      schedulingOrdinal: discovery.length + index,
    })
  );
  const description = original.assignments.find(
    (item) => item.workSlot.taskKind === ReviewTaskKind.PrDescription
  );
  if (description && batches.length < input.maxWorkSlots)
    batches.push({
      batchId: description.batchId,
      taskKind: ReviewTaskKind.PrDescription,
      required: false,
      paths: [],
      schedulingOrdinal: batches.length,
    });
  const selected = packets.flatMap((packet) =>
    packet.targets.map((target) => target.witness)
  );
  const packetByHash = new Map(
    packets.map((packet) => [packet.packetHash, packet])
  );
  try {
    const plan = createStableReviewWorkPlan({
      reviewRevisionHash: input.reviewRevisionHash,
      compatibilityKey: input.compatibilityKey,
      providers: [
        {
          providerName: first.providerName,
          providerKind: first.workSlot.providerKind,
          providerVoteIdentityHash: first.workSlot.providerVoteIdentityHash,
          required: true,
          attemptBudget: first.workSlot.attemptBudget,
          retryPolicyVersion: first.workSlot.retryPolicyVersion,
        },
      ],
      batches,
      eligiblePaths: manifest.eligiblePaths,
      uncoveredPaths: manifest.uncoveredPaths,
      excludedPaths: manifest.excludedPaths,
      maxWorkSlots: input.maxWorkSlots,
      maxAttemptsPerSlot: input.maxAttemptsPerSlot,
      lifecyclePlan: (assignments) => ({
        version: 1,
        capabilityHash: lifecycleHash(input.capability),
        descriptorDigest: input.capability.descriptorDigest,
        policyDigest: input.policyDigest,
        inventoryHash: input.revalidation.inventoryHash,
        inventoryCount: input.revalidation.inventoryCount,
        dispositionCounts: Object.fromEntries(
          [
            'eligible',
            'manual',
            'unsupported',
            'capped',
            'unavailable',
            'resolved',
          ].map((disposition) => [
            disposition,
            input.revalidation.dispositions.filter(
              (item) => item.disposition === disposition
            ).length,
          ])
        ),
        participantRoster: input.revalidation.participantRoster.map(
          (participant) => ({
            providerVoteIdentityHash: participant.voteIdentityHash,
          })
        ),
        targets: selected,
        assignments: assignments
          .filter(
            (item) =>
              item.workSlot.taskKind === ReviewTaskKind.LifecycleRevalidation
          )
          .map((item) => ({
            workSlotId: item.workSlot.workSlotId,
            packetHash: item.batchId,
            targetIds: lifecycleTargetWitnesses(
              packetByHash.get(item.batchId)!
            ).map((target) => target.targetId),
            lifecycleTargetSetHash: lifecycleHash(
              lifecycleTargetWitnesses(packetByHash.get(item.batchId)!)
            ),
            liveLifecycleStateHash: input.liveLifecycleStateHash,
          })),
      }),
    });
    const packetsByWorkSlotId = new Map(
      plan.assignments
        .filter(
          (item) =>
            item.workSlot.taskKind === ReviewTaskKind.LifecycleRevalidation
        )
        .map((item) => [
          item.workSlot.workSlotId,
          packetByHash.get(item.batchId)!,
        ])
    );
    return {
      plan,
      packetsByWorkSlotId,
      lifecycleVerification: {
        plannedProviderVoteKeys: input.revalidation.participantRoster.map(
          (item) => item.voteIdentityHash
        ),
        mode: 'report',
        targetReasonCodes: Object.fromEntries(
          input.revalidation.dispositions.map((item) => [
            item.targetId,
            [item.reason],
          ])
        ),
        witnessesByTargetId: Object.fromEntries(
          selected.map((witness) => [
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
          [...packetsByWorkSlotId].map(([id, packet]) => [
            id,
            packet.targets.map((target) => target.witness.targetId),
          ])
        ),
      },
    };
  } catch (error) {
    if (
      error instanceof Error &&
      [
        'review_lifecycle_plan_too_large',
        'review_assignment_manifest_too_large',
      ].includes(error.message)
    )
      return {
        ...empty,
        lifecycleVerification: {
          plannedProviderVoteKeys: input.revalidation.participantRoster.map(
            (participant) => participant.voteIdentityHash
          ),
          mode: 'report',
          witnessesByTargetId: {},
          assignedTargetIdsByWorkSlotId: {},
          targetReasonCodes: Object.fromEntries(
            input.revalidation.dispositions.map((item) => [
              item.targetId,
              ['verification_manifest_capacity'],
            ])
          ),
        },
      };
    throw error;
  }
}

export function compositeLifecycleInvocations(input: {
  discovery: PreparedReviewInvocationPort;
  packetsByWorkSlotId: ReadonlyMap<string, VerifyPacket>;
  capability: LifecycleVerificationCapability;
  outputCap: number;
  reviewRevisionHash: string;
  liveLifecycleStateHash: string;
  transport: LocalGatewayModelTransport;
}): PreparedReviewInvocationPort {
  const prepared = new Map<
    string,
    ReturnType<typeof prepareLifecycleRequest>
  >();
  return {
    async prepare(request) {
      if (request.workSlot.taskKind !== ReviewTaskKind.LifecycleRevalidation)
        return input.discovery.prepare(request);
      const packet = input.packetsByWorkSlotId.get(request.workSlot.workSlotId);
      if (
        !packet ||
        request.attemptOrdinal !== 1 ||
        request.workSlot.required ||
        request.workSlot.attemptBudget !== 1
      )
        throw new Error('lifecycle_verification_work_slot_invalid');
      if (
        'protocol' in input.capability &&
        input.capability.protocol !== 'openai-responses' &&
        !input.transport.encodeLifecycleRequest
      )
        throw new Error('lifecycle_verification_native_encoder_unavailable');
      const value = prepareLifecycleRequest(
        packet,
        input.outputCap,
        input.capability.maxPromptBytes,
        input.transport.encodeLifecycleRequest
      );
      prepared.set(request.workSlot.workSlotId, value);
      return Object.freeze({
        workSlotId: request.workSlot.workSlotId,
        attemptOrdinal: 1,
        provider: `lifecycle/${input.capability.providerKind}`,
        requestedModel: packet.participant.model,
        reviewPrompt: '',
        investigationContextPrompt: null,
        immutableRequest: value.requestBytes,
        manifestFacts: {
          taskKindSet: [ReviewTaskKind.LifecycleRevalidation],
          providerKind: request.workSlot.providerKind,
          providerCapabilityHash: lifecycleHash(input.capability),
          providerRequestEnvelopeHash: value.requestHash,
          outputSchemaHash: lifecycleHash({
            extensionId: contract.extensionId,
            outputSchemaVersion: 1,
          }),
          filePatchManifestHash: lifecycleHash(
            packet.sources.map((source) => ({
              path: source.path,
              blobOid: source.blobOid,
              contentHash: source.contentHash,
            }))
          ),
          contextManifestHash: packet.packetHash,
          lifecycleTargetSetHash: lifecycleHash(
            lifecycleTargetWitnesses(packet)
          ),
          liveLifecycleStateHash: input.liveLifecycleStateHash,
          toolPolicyHash: lifecycleHash({ tools: [], tool_choice: 'none' }),
          executionProfile: 'prompt_only_envelope_v1',
          baseTreeHash: null,
          environmentContractHash: lifecycleHash({
            executor: contract.executor,
            descriptorDigest: input.capability.descriptorDigest,
          }),
        },
        coverageManifest: createReviewPromptCoverageManifest({
          workSlotId: request.workSlot.workSlotId,
          reviewRevisionHash: input.reviewRevisionHash,
          assignedPaths: [],
          pathCoverage: [],
        }),
        investigationProbePlan: null,
      } satisfies PreparedReviewInvocation);
    },
    async execute(request) {
      if (!input.packetsByWorkSlotId.has(request.invocation.workSlotId))
        return input.discovery.execute(request);
      const value = prepared.get(request.invocation.workSlotId);
      if (!value || !input.transport.generateLifecycleVerification)
        throw new Error('lifecycle_verification_unavailable');
      const lease = request.currentLease?.() ?? request.lease;
      const receipt = await input.transport.generateLifecycleVerification({
        requestBody: value.requestBytes,
        dispatch: {
          dispatchId: lifecycleHash({
            executionId: request.sourceExecutionId,
            workSlotId: request.invocation.workSlotId,
            attemptOrdinal: 1,
          }),
          executionId: request.sourceExecutionId,
          workSlotId: request.invocation.workSlotId,
          attemptOrdinal: 1,
          leaseId: lease.leaseId,
          leaseCapability: lease.leaseCapability,
          fencingToken: lease.fencingToken,
          preparedManifestKey: request.manifest.manifestKey,
        },
        signal: request.signal,
        maxResponseBytes: input.capability.maxResponseBytes,
        maxOutputTokens: value.outputCap,
        deadlineMs: input.capability.deadlineMs,
      });
      const result = validateLifecycleResponse(
        receipt.body,
        value,
        receipt.actualModel,
        receipt.providerRequestEnvelopeHash,
        input.capability.maxResponseBytes
      );
      if (!result.valid)
        throw new Error('lifecycle_verification_response_invalid');
      return normalizeReviewObservation({
        workSlotId: request.invocation.workSlotId,
        attemptOrdinal: 1,
        providerName: request.invocation.provider,
        requestedModel: request.invocation.requestedModel,
        transportAttemptCount: 1,
        result: {
          content: '',
          findings: [],
          actualModel: receipt.actualModel,
          revalidations: result.results.map((item) => ({
            targetId: item.targetId,
            fingerprint: item.fingerprint,
            verdict: item.verdict,
            confidence: item.confidence,
            rationale: [item.failureCondition, item.fixExplanation]
              .filter(Boolean)
              .join('\n'),
            evidence: [...item.evidence],
          })),
        },
      });
    },
  };
}

/** Reuses persisted identities. Current inventory can only invalidate frozen witnesses. */
export function restorePersistedWorkPlan(
  restored: import('../application').RestoredReviewExecution | null,
  planned: StableReviewWorkPlan
): StableReviewWorkPlan {
  const persisted = restored?.persistedPlan;
  if (!persisted) return planned;
  if (
    !persisted.assignmentManifestCanonicalJson ||
    !persisted.assignmentManifestHash
  )
    throw new Error('review_restore_plan_unavailable');
  const slots = [...persisted.workSlots].map(
    ({
      workSlotId,
      taskKind,
      providerKind,
      providerVoteIdentityHash,
      shardKey,
      required,
      attemptBudget,
      retryPolicyVersion,
    }) => ({
      workSlotId,
      taskKind,
      providerKind,
      providerVoteIdentityHash,
      shardKey,
      required,
      attemptBudget,
      retryPolicyVersion,
    })
  );
  const assignments = slots.map((workSlot, schedulingOrdinal) => ({
    workSlot,
    schedulingOrdinal,
    batchId: workSlot.shardKey,
    providerName:
      planned.assignments.find(
        (item) => item.workSlot.providerKind === workSlot.providerKind
      )?.providerName ?? workSlot.providerKind,
  }));
  assignments.sort((left, right) => {
    const rank = (kind: ReviewTaskKind) =>
      kind === ReviewTaskKind.FindingDiscovery
        ? 0
        : kind === ReviewTaskKind.LifecycleRevalidation
          ? 1
          : 2;
    return (
      rank(left.workSlot.taskKind) - rank(right.workSlot.taskKind) ||
      left.schedulingOrdinal - right.schedulingOrdinal
    );
  });
  return Object.freeze({
    planHash: persisted.planHash,
    workSlotsCanonicalJson: canonicalJson(
      slots.sort((a, b) =>
        a.workSlotId < b.workSlotId ? -1 : a.workSlotId > b.workSlotId ? 1 : 0
      )
    ),
    assignmentManifestCanonicalJson: persisted.assignmentManifestCanonicalJson,
    assignmentManifestHash: persisted.assignmentManifestHash,
    assignments,
  });
}
