import { createHash } from 'crypto';
import {
  ReviewExecutionProviderKind,
  ReviewTaskKind,
  type ReviewWorkSlotPlan,
} from '../application/review-orchestration-ports';

export type StableReviewProviderLane = {
  readonly providerName: string;
  readonly providerKind: ReviewExecutionProviderKind;
  readonly providerVoteIdentityHash: string;
  readonly required: boolean;
  readonly attemptBudget: number;
  readonly retryPolicyVersion: string;
};

export type StableReviewBatch = {
  readonly batchId: string;
  readonly taskKind: ReviewTaskKind;
  readonly required: boolean;
  readonly schedulingOrdinal?: number;
};

export type StableReviewBatchMember = {
  readonly filename: string;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
  readonly patch?: string;
  readonly previousFilename?: string;
  readonly language?: string;
};

export type StableReviewWorkAssignment = {
  readonly workSlot: ReviewWorkSlotPlan;
  readonly providerName: string;
  readonly batchId: string;
  readonly schedulingOrdinal: number;
};

export type StableReviewWorkPlan = {
  readonly planHash: string;
  readonly workSlotsCanonicalJson: string;
  readonly assignments: readonly StableReviewWorkAssignment[];
};

export function createStableReviewBatchId(input: {
  readonly taskKind: ReviewTaskKind;
  readonly members: readonly StableReviewBatchMember[];
}): string {
  if (!Object.values(ReviewTaskKind).includes(input.taskKind)) {
    throw new Error('review_batch_task_kind_invalid');
  }
  assertUnique(
    input.members.map((member) => member.filename),
    'review_batch_member_duplicate'
  );
  const members = input.members
    .map((member) => ({
      additions: member.additions,
      changes: member.changes,
      deletions: member.deletions,
      filename: member.filename,
      language: member.language ?? null,
      patch: member.patch ?? null,
      previousFilename: member.previousFilename ?? null,
      status: member.status,
    }))
    .sort(
      (left, right) =>
        compareCodePoints(left.filename, right.filename) ||
        compareCodePoints(canonicalJson(left), canonicalJson(right))
    );
  return sha256(
    `rr.review-batch.v2\0${canonicalJson({
      members,
      taskKind: input.taskKind,
    })}`
  );
}

export function createStableReviewWorkPlan(input: {
  readonly reviewRevisionHash: string;
  readonly compatibilityKey: string;
  readonly providers: readonly StableReviewProviderLane[];
  readonly batches: readonly StableReviewBatch[];
  readonly maxWorkSlots: number;
  readonly maxAttemptsPerSlot: number;
}): StableReviewWorkPlan {
  requireDigest(input.reviewRevisionHash, 'review_revision_hash');
  requireDigest(input.compatibilityKey, 'compatibility_key');
  requirePositiveInteger(input.maxWorkSlots, 'max_work_slots');
  requirePositiveInteger(input.maxAttemptsPerSlot, 'max_attempts_per_slot');
  if (input.providers.length === 0 || input.batches.length === 0) {
    throw new Error('review_work_plan_empty');
  }

  const providers = [...input.providers].sort((left, right) =>
    compareCodePoints(left.providerName, right.providerName)
  );
  const batches = input.batches
    .map((batch, inputOrdinal) => ({
      ...batch,
      schedulingOrdinal: batch.schedulingOrdinal ?? inputOrdinal,
    }))
    .sort(
      (left, right) =>
        left.schedulingOrdinal - right.schedulingOrdinal ||
        compareCodePoints(left.batchId, right.batchId)
    );
  assertUnique(
    providers.map((provider) => provider.providerName),
    'review_work_plan_provider_duplicate'
  );
  assertUnique(
    providers.map((provider) => provider.providerVoteIdentityHash),
    'review_work_plan_vote_lane_duplicate'
  );
  assertUnique(
    batches.map((batch) => batch.batchId),
    'review_work_plan_batch_duplicate'
  );
  assertUnique(
    batches.map((batch) => String(batch.schedulingOrdinal)),
    'review_work_plan_scheduling_ordinal_duplicate'
  );

  const assignments: StableReviewWorkAssignment[] = [];
  for (const batch of batches) {
    requireIdentity(batch.batchId, 'batch_id');
    requireNonNegativeInteger(
      batch.schedulingOrdinal,
      'batch_scheduling_ordinal'
    );
    for (const provider of providers) {
      requireIdentity(provider.providerName, 'provider_name');
      requireIdentity(provider.retryPolicyVersion, 'retry_policy_version');
      if (
        !Object.values(ReviewExecutionProviderKind).includes(
          provider.providerKind
        )
      ) {
        throw new Error('provider_kind_invalid');
      }
      requireDigest(
        provider.providerVoteIdentityHash,
        'provider_vote_identity_hash'
      );
      if (
        !Number.isSafeInteger(provider.attemptBudget) ||
        provider.attemptBudget < 1 ||
        provider.attemptBudget > input.maxAttemptsPerSlot
      ) {
        throw new Error('review_work_plan_attempt_limit_exceeded');
      }
      const workSlotId = sha256(
        `rr.review-work-slot.v1\0${canonicalJson({
          batchId: batch.batchId,
          compatibilityKey: input.compatibilityKey,
          providerName: provider.providerName,
          providerKind: provider.providerKind,
          providerVoteIdentityHash: provider.providerVoteIdentityHash,
          taskKind: batch.taskKind,
          reviewRevisionHash: input.reviewRevisionHash,
        })}`
      );
      assignments.push({
        providerName: provider.providerName,
        batchId: batch.batchId,
        schedulingOrdinal: batch.schedulingOrdinal,
        workSlot: {
          workSlotId,
          taskKind: batch.taskKind,
          providerKind: provider.providerKind,
          providerVoteIdentityHash: provider.providerVoteIdentityHash,
          shardKey: batch.batchId,
          required: batch.required && provider.required,
          attemptBudget: provider.attemptBudget,
          retryPolicyVersion: provider.retryPolicyVersion,
        },
      });
    }
  }
  if (assignments.length > input.maxWorkSlots) {
    throw new Error('review_work_plan_slot_limit_exceeded');
  }
  assignments.sort(
    (left, right) =>
      left.schedulingOrdinal - right.schedulingOrdinal ||
      compareCodePoints(left.providerName, right.providerName) ||
      compareCodePoints(left.workSlot.workSlotId, right.workSlot.workSlotId)
  );

  const canonicalAssignments = [...assignments].sort((left, right) =>
    compareCodePoints(left.workSlot.workSlotId, right.workSlot.workSlotId)
  );
  const workSlotsCanonicalJson = canonicalJson(
    canonicalAssignments.map((assignment) => assignment.workSlot)
  );
  const planHash = sha256(
    `rr.review-work-plan.v1\0${canonicalJson({
      compatibilityKey: input.compatibilityKey,
      reviewRevisionHash: input.reviewRevisionHash,
      workSlots: canonicalAssignments.map((assignment) => ({
        batchId: assignment.batchId,
        providerName: assignment.providerName,
        ...assignment.workSlot,
      })),
    })}`
  );
  return Object.freeze({
    planHash,
    workSlotsCanonicalJson,
    assignments: Object.freeze(
      assignments.map((assignment) =>
        Object.freeze({
          ...assignment,
          workSlot: Object.freeze({ ...assignment.workSlot }),
        })
      )
    ),
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort(compareCodePoints)
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function compareCodePoints(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function requireDigest(value: string, field: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${field}_invalid`);
}

function requireIdentity(value: string, field: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value)) {
    throw new Error(`${field}_invalid`);
  }
}

function requirePositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field}_invalid`);
  }
}

function requireNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field}_invalid`);
  }
}

function assertUnique(values: readonly string[], errorCode: string): void {
  if (new Set(values).size !== values.length) throw new Error(errorCode);
}
