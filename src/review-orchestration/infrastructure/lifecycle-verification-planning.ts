import { createConfiguredTrivialDetector } from '../../analysis/trivial-detector';
import {
  lifecycleVerificationContract,
  type LifecycleVerificationCapabilityV1,
} from '../../control-plane/generated/review-action-v2/companion-contracts';
import {
  createGitImmutableSourceReader,
  planFindingRevalidation,
  resolveRevalidationConfidenceThresholds,
  type PriorResolutionFact,
  type RevalidationScope,
  type RevalidationTarget,
} from '../../finding-revalidation';
import type { ReviewConfig } from '../../types';
import type { ReviewRunAuthorization } from '../application';
import type { StableReviewWorkPlan } from '../domain';
import {
  appendLifecycleWorkPlan,
  lifecycleHash,
} from './lifecycle-verification-invocation';
import { sensitivePath } from './pr-description-generation';

/** History is native/retained state; unknown history never becomes no-prior. */
export function priorResolutionFact(
  target: RevalidationTarget,
  facts: readonly unknown[]
): PriorResolutionFact {
  const bound = facts.find(
    (value) =>
      value &&
      typeof value === 'object' &&
      (value as { targetId?: unknown }).targetId === target.targetId
  ) as
    | {
        threadId?: string;
        parentCommentId?: string;
        parentCreatedAt?: string;
        parentBodyHash?: string;
        history?: {
          threadId?: string;
          version?: number;
          historyCut?: {
            activatedAt?: string;
            activationVersion?: number;
            writerDigest?: string;
            bootstrap?: {
              qualificationSource?: string;
              executorSetHash?: string;
              proofHash?: string;
              retiredAt?: string;
              activationCut?: string;
            };
          } | null;
          confirmed?: unknown;
          pending?: readonly unknown[];
        };
      }
    | undefined;
  const history = bound?.history;
  const unavailable: PriorResolutionFact = {
    historyCut: history?.historyCut?.activatedAt ?? 'unavailable',
    guardVersion: String(history?.version ?? 0),
    state: 'unavailable',
  };
  if (
    !bound ||
    bound.threadId !== target.threadId ||
    bound.parentCommentId !== target.parentId ||
    bound.parentBodyHash !== target.parentBodyHash ||
    bound.parentCreatedAt !== target.parentCreatedAt ||
    !history ||
    history.threadId !== target.threadId ||
    !Number.isSafeInteger(history.version) ||
    (history.version ?? -1) < 0 ||
    !Array.isArray(history.pending) ||
    !(
      history.confirmed === null ||
      (!!history.confirmed && typeof history.confirmed === 'object')
    )
  )
    return unavailable;
  // Retained positive facts remain blockers even before a qualified cut exists.
  if (history.confirmed)
    return { ...unavailable, state: 'previously_resolved' };
  if (history.pending.length)
    return { ...unavailable, state: 'effect_unknown' };
  const cut = history.historyCut;
  if (
    !cut?.activatedAt ||
    !Number.isSafeInteger(cut.activationVersion) ||
    (cut.activationVersion ?? 0) < 1 ||
    typeof cut.writerDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(cut.writerDigest) ||
    !Number.isFinite(Date.parse(cut.activatedAt)) ||
    new Date(cut.activatedAt).toISOString() !== cut.activatedAt
  )
    return unavailable;
  if (cut.bootstrap !== undefined) {
    const bootstrap = cut.bootstrap;
    const canonicalTimestamp = (value: unknown): value is string =>
      typeof value === 'string' &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value;
    if (
      !bootstrap ||
      bootstrap.qualificationSource !==
        'retired_legacy_writers_quarantine.v1' ||
      typeof bootstrap.executorSetHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(bootstrap.executorSetHash) ||
      typeof bootstrap.proofHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(bootstrap.proofHash) ||
      !canonicalTimestamp(bootstrap.retiredAt) ||
      !canonicalTimestamp(bootstrap.activationCut) ||
      bootstrap.activationCut !== cut.activatedAt ||
      Date.parse(bootstrap.retiredAt) > Date.parse(bootstrap.activationCut)
    )
      return unavailable;
    // Retirement proves no future old writer; it cannot settle pre-cut effects.
    // Late-visible parents are quarantined by their native creation timestamp too.
    if (
      Date.parse(target.parentCreatedAt) <= Date.parse(bootstrap.activationCut)
    )
      return { ...unavailable, state: 'effect_unknown' };
  }
  const state =
    Date.parse(target.parentCreatedAt) >= Date.parse(cut.activatedAt)
      ? 'no_prior_since_creation'
      : 'before_cut_unobserved';
  return { ...unavailable, state };
}

export async function planProductionLifecycleVerification(input: {
  capability: LifecycleVerificationCapabilityV1;
  authorization: ReviewRunAuthorization;
  plan: StableReviewWorkPlan;
  repository: string;
  checkoutRoot: string;
  compatibilityKey: string;
  config: ReviewConfig;
  inventory: {
    complete: boolean;
    lifecycleStateHash: string;
    commandLedgerWatermark: string;
  };
  targets: readonly RevalidationTarget[];
  resolutionHistory: readonly unknown[];
  renames: readonly { previousFilename: string; filename: string }[];
}) {
  const facts = input.authorization.facts;
  const scope: RevalidationScope = {
    workspaceId: facts.workspaceId,
    repositoryConnectionId: facts.repositoryConnectionId,
    repository: input.repository,
    pullRequestNumber: facts.pullRequestNumber,
    baseSha: facts.baseSha,
    mergeBaseSha: facts.mergeBaseSha,
    headSha: facts.headSha,
    reviewRevisionHash: facts.reviewRevisionHash,
  };
  const policyDigest = lifecycleHash({
    version: lifecycleVerificationContract.policyVersion,
    thresholds: resolveRevalidationConfidenceThresholds(
      input.config.reviewThreadLifecycleResolveConfidence
    ),
  });
  const lane = facts.providerVoteLanes.find(
    (value) => value.providerKind === input.capability.providerKind
  );
  if (!lane) throw new Error('lifecycle_verification_vote_lane_missing');
  const repositoryExclusions = createConfiguredTrivialDetector(input.config);
  const revalidation = await planFindingRevalidation(
    {
      scope,
      participant: {
        model: input.capability.model,
        capabilityDigest: lifecycleHash(input.capability),
        voteIdentityHash: lane.providerVoteIdentityHash,
      },
      inventoryComplete: input.inventory.complete,
      targets: input.targets,
      limits: {
        gatewayOutputTokens: input.capability.maxOutputTokens,
        modelOutputTokens: input.capability.maxOutputTokens,
        remainingWorkSlots: Math.max(
          0,
          input.authorization.limits.maxWorkSlots -
            input.plan.assignments.filter(
              (item) => item.workSlot.taskKind !== 'pr_description'
            ).length
        ),
        maxRequestBytes: input.capability.maxPromptBytes,
        maxResponseBytes: input.capability.maxResponseBytes,
      },
      policyDigest,
      resolveConfidenceThresholds:
        input.config.reviewThreadLifecycleResolveConfidence,
      renames: input.renames,
    },
    {
      sourceReader: createGitImmutableSourceReader({
        repositoryRoot: input.checkoutRoot,
      }),
      priorResolutionHistory: {
        read: async (target) =>
          priorResolutionFact(target, input.resolutionHistory),
      },
      isPathAllowed: (value) =>
        !sensitivePath(value) &&
        (input.config.skipTrivialChanges === false ||
          !repositoryExclusions.isFileTrivial({
            filename: value,
            status: 'modified',
            additions: 0,
            deletions: 0,
            changes: 0,
          })),
    }
  );
  const liveLifecycleStateHash = lifecycleHash({
    inventoryHash: input.inventory.lifecycleStateHash,
    commandLedgerWatermark: input.inventory.commandLedgerWatermark,
    resolutionHistory: input.resolutionHistory,
  });
  const appended = appendLifecycleWorkPlan({
    plan: input.plan,
    revalidation,
    capability: input.capability,
    reviewRevisionHash: facts.reviewRevisionHash,
    compatibilityKey: input.compatibilityKey,
    maxWorkSlots: input.authorization.limits.maxWorkSlots,
    maxAttemptsPerSlot: input.authorization.limits.maxAttemptsPerSlot,
    policyDigest,
    liveLifecycleStateHash,
  });
  return {
    ...appended,
    outputCap: revalidation.outputCap,
    liveLifecycleStateHash,
    ...(appended.lifecycleVerification
      ? {
          lifecycleVerification: {
            ...appended.lifecycleVerification,
            mode:
              input.config.reviewThreadLifecycle === 'resolve'
                ? ('resolve' as const)
                : ('report' as const),
          },
        }
      : {}),
  };
}
