import {
  REVIEW_CHECKPOINT_PROTOCOL_VERSION,
  ReviewCheckpointBatchPayload,
  ReviewCheckpointBatchResultStatus,
  ReviewCheckpointClientPort,
  ReviewCheckpointFinalizationMarkerWriter,
  ReviewCheckpointFinalizeStatus,
  ReviewCheckpointPlanIdentity,
  ReviewCheckpointRecord,
  ReviewCheckpointRestoreStatus,
  ReviewCheckpointStartStatus,
  checkpointPayloadsMatch,
  checkpointPlansMatch,
  createReviewCheckpointPlanIdentity,
  normalizeReviewCheckpointBatchPayload,
} from '../domain/review-checkpoint';

export enum ReviewCheckpointCommitStatus {
  Accepted = 'accepted',
  Idempotent = 'idempotent',
  Disabled = 'disabled',
}

export enum ReviewCheckpointSessionFinalizeStatus {
  Finalized = 'finalized',
  Idempotent = 'idempotent',
  Incomplete = 'incomplete',
  Disabled = 'disabled',
}

export type ReviewCheckpointSessionLogger = {
  warn(message: string): void;
};

export interface CommitReviewCheckpointBatchInput {
  readonly workKey: string;
  readonly filePaths?: unknown;
  readonly files?: unknown;
  readonly findings?: unknown;
  readonly providerResults?: unknown;
}

export type CommitReviewCheckpointBatchResult =
  | {
      readonly status:
        | ReviewCheckpointCommitStatus.Accepted
        | ReviewCheckpointCommitStatus.Idempotent;
      readonly expectedVersion: number;
      readonly payload: ReviewCheckpointBatchPayload;
    }
  | {
      readonly status: ReviewCheckpointCommitStatus.Disabled;
    };

export type FinalizeReviewCheckpointSessionResult =
  | {
      readonly status:
        | ReviewCheckpointSessionFinalizeStatus.Finalized
        | ReviewCheckpointSessionFinalizeStatus.Idempotent;
      readonly expectedVersion: number;
      readonly markerWritten: boolean;
    }
  | {
      readonly status: ReviewCheckpointSessionFinalizeStatus.Incomplete;
      readonly missingWorkKeys: readonly string[];
    }
  | {
      readonly status: ReviewCheckpointSessionFinalizeStatus.Disabled;
    };

export class ReviewCheckpointSession {
  static async open(input: {
    readonly client: ReviewCheckpointClientPort;
    readonly plan: ReviewCheckpointPlanIdentity;
    readonly markerWriter?: ReviewCheckpointFinalizationMarkerWriter | null;
    readonly logger?: ReviewCheckpointSessionLogger;
  }): Promise<ReviewCheckpointSession | null> {
    const plan = createReviewCheckpointPlanIdentity(input.plan);
    try {
      const restored = await input.client.restore(restoreInput(plan));
      if (
        restored.status === ReviewCheckpointRestoreStatus.Found &&
        checkpointPlansMatch(restored.checkpoint.plan, plan)
      ) {
        const acceptedResults = acceptedResultsInPlanOrder(
          plan,
          restored.checkpoint
        );
        if (
          acceptedResults === null ||
          restored.expectedVersion !== restored.checkpoint.version ||
          (restored.checkpoint.finalized &&
            acceptedResults.size !== plan.workKeys.length)
        ) {
          warnFailOpen(input.logger, 'invalid_restored_checkpoint');
          return null;
        }
        return new ReviewCheckpointSession({
          ...input,
          plan,
          expectedVersion: restored.expectedVersion,
          acceptedResults,
          finalized: restored.checkpoint.finalized,
        });
      }

      const expectedVersion = restored.expectedVersion;
      const started = await input.client.start({ expectedVersion, plan });
      if (started.status === ReviewCheckpointStartStatus.Conflict) {
        warnFailOpen(input.logger, 'start_version_conflict');
        return null;
      }
      if (
        started.headSha.toLowerCase() !== plan.headSha ||
        started.planHash.toLowerCase() !== plan.planHash ||
        !isValidVersionAcknowledgement(
          started.version,
          expectedVersion,
          started.status === ReviewCheckpointStartStatus.Idempotent
        )
      ) {
        warnFailOpen(input.logger, 'invalid_start_acknowledgement');
        return null;
      }
      return new ReviewCheckpointSession({
        ...input,
        plan,
        expectedVersion: started.version,
        acceptedResults: new Map(),
        finalized: false,
      });
    } catch (error) {
      warnFailOpen(input.logger, safeFailureReason(error));
      return null;
    }
  }

  private expectedVersion: number;
  private acceptedResults: Map<string, ReviewCheckpointBatchPayload>;
  private finalized: boolean;
  private disabled = false;
  private operationQueue: Promise<void> = Promise.resolve();
  private readonly client: ReviewCheckpointClientPort;
  private readonly plan: ReviewCheckpointPlanIdentity;
  private readonly markerWriter?: ReviewCheckpointFinalizationMarkerWriter | null;
  private readonly logger?: ReviewCheckpointSessionLogger;

  private constructor(input: {
    readonly client: ReviewCheckpointClientPort;
    readonly plan: ReviewCheckpointPlanIdentity;
    readonly expectedVersion: number;
    readonly acceptedResults: Map<string, ReviewCheckpointBatchPayload>;
    readonly finalized: boolean;
    readonly markerWriter?: ReviewCheckpointFinalizationMarkerWriter | null;
    readonly logger?: ReviewCheckpointSessionLogger;
  }) {
    this.client = input.client;
    this.plan = input.plan;
    this.expectedVersion = input.expectedVersion;
    this.acceptedResults = input.acceptedResults;
    this.finalized = input.finalized;
    this.markerWriter = input.markerWriter;
    this.logger = input.logger;
  }

  get isEnabled(): boolean {
    return !this.disabled;
  }

  get currentExpectedVersion(): number {
    return this.expectedVersion;
  }

  get acceptedBatchResults(): ReadonlyMap<
    string,
    ReviewCheckpointBatchPayload
  > {
    return new Map(this.acceptedResults);
  }

  commitSuccessfulBatch(
    input: CommitReviewCheckpointBatchInput
  ): Promise<CommitReviewCheckpointBatchResult> {
    return this.enqueue(() => this.commitSuccessfulBatchNow(input));
  }

  finalize(input: {
    readonly snapshotAdvancementRequired: boolean;
  }): Promise<FinalizeReviewCheckpointSessionResult> {
    return this.enqueue(() => this.finalizeNow(input));
  }

  private async commitSuccessfulBatchNow(
    input: CommitReviewCheckpointBatchInput
  ): Promise<CommitReviewCheckpointBatchResult> {
    if (this.disabled || this.finalized) return disabledCommit();
    const workKey = input.workKey.toLowerCase();
    if (!this.plan.workKeys.includes(workKey)) {
      this.disable('unplanned_work_key');
      return disabledCommit();
    }

    let payload: ReviewCheckpointBatchPayload;
    try {
      payload = normalizeReviewCheckpointBatchPayload(input);
    } catch {
      this.disable('invalid_batch_payload');
      return disabledCommit();
    }

    const existing = this.acceptedResults.get(workKey);
    if (existing) {
      if (!checkpointPayloadsMatch(existing, payload)) {
        this.disable('non_idempotent_batch_replay');
        return disabledCommit();
      }
      return {
        status: ReviewCheckpointCommitStatus.Idempotent,
        expectedVersion: this.expectedVersion,
        payload: existing,
      };
    }

    try {
      let result = await this.sendBatchResult(workKey, payload);
      if (result.status === ReviewCheckpointBatchResultStatus.Conflict) {
        const reconciled = await this.reconcileAfterConflict(workKey, payload);
        if (reconciled === ReviewCheckpointCommitStatus.Idempotent) {
          return {
            status: reconciled,
            expectedVersion: this.expectedVersion,
            payload,
          };
        }
        if (reconciled === ReviewCheckpointCommitStatus.Disabled) {
          return disabledCommit();
        }
        result = await this.sendBatchResult(workKey, payload);
      }
      if (result.status === ReviewCheckpointBatchResultStatus.Conflict) {
        this.disable('repeated_version_conflict');
        return disabledCommit();
      }
      if (
        !this.isExactBatchAcknowledgement(result, workKey) ||
        !isValidVersionAcknowledgement(
          result.version,
          this.expectedVersion,
          result.status === ReviewCheckpointBatchResultStatus.Idempotent
        )
      ) {
        this.disable('mismatched_batch_acknowledgement');
        return disabledCommit();
      }

      this.expectedVersion = result.version;
      this.setAcceptedResult(workKey, payload);
      return {
        status:
          result.status === ReviewCheckpointBatchResultStatus.Idempotent
            ? ReviewCheckpointCommitStatus.Idempotent
            : ReviewCheckpointCommitStatus.Accepted,
        expectedVersion: this.expectedVersion,
        payload,
      };
    } catch (error) {
      this.disable(safeFailureReason(error));
      return disabledCommit();
    }
  }

  private async finalizeNow(input: {
    readonly snapshotAdvancementRequired: boolean;
  }): Promise<FinalizeReviewCheckpointSessionResult> {
    if (this.disabled) return disabledFinalize();
    const missingWorkKeys = this.plan.workKeys.filter(
      (workKey) => !this.acceptedResults.has(workKey)
    );
    if (missingWorkKeys.length > 0) {
      return {
        status: ReviewCheckpointSessionFinalizeStatus.Incomplete,
        missingWorkKeys,
      };
    }

    try {
      let result = await this.client.finalize({
        expectedVersion: this.expectedVersion,
        pullRequestNumber: this.plan.pullRequestNumber,
        headSha: this.plan.headSha,
        planHash: this.plan.planHash,
      });
      if (result.status === ReviewCheckpointFinalizeStatus.Conflict) {
        const reconciled = await this.reconcileFinalizationConflict();
        if (!reconciled) return disabledFinalize();
        result = await this.client.finalize({
          expectedVersion: this.expectedVersion,
          pullRequestNumber: this.plan.pullRequestNumber,
          headSha: this.plan.headSha,
          planHash: this.plan.planHash,
        });
      }
      if (result.status === ReviewCheckpointFinalizeStatus.Conflict) {
        this.disable('repeated_finalize_version_conflict');
        return disabledFinalize();
      }
      if (
        result.headSha.toLowerCase() !== this.plan.headSha ||
        result.planHash.toLowerCase() !== this.plan.planHash ||
        !isValidVersionAcknowledgement(
          result.version,
          this.expectedVersion,
          result.status === ReviewCheckpointFinalizeStatus.Idempotent
        )
      ) {
        this.disable('mismatched_finalize_acknowledgement');
        return disabledFinalize();
      }

      this.expectedVersion = result.version;
      this.finalized = true;
      const markerWritten = await this.writeFinalizationMarker(
        input.snapshotAdvancementRequired
      );
      return {
        status:
          result.status === ReviewCheckpointFinalizeStatus.Idempotent
            ? ReviewCheckpointSessionFinalizeStatus.Idempotent
            : ReviewCheckpointSessionFinalizeStatus.Finalized,
        expectedVersion: this.expectedVersion,
        markerWritten,
      };
    } catch (error) {
      this.disable(safeFailureReason(error));
      return disabledFinalize();
    }
  }

  private sendBatchResult(
    workKey: string,
    payload: ReviewCheckpointBatchPayload
  ) {
    return this.client.commitBatchResult({
      expectedVersion: this.expectedVersion,
      pullRequestNumber: this.plan.pullRequestNumber,
      headSha: this.plan.headSha,
      planHash: this.plan.planHash,
      workKey,
      batchId: workKey,
      batchIndex: this.plan.workKeys.indexOf(workKey),
      payload,
    });
  }

  private async reconcileAfterConflict(
    workKey: string,
    payload: ReviewCheckpointBatchPayload
  ): Promise<ReviewCheckpointCommitStatus> {
    const restored = await this.client.restore(restoreInput(this.plan));
    if (
      restored.status !== ReviewCheckpointRestoreStatus.Found ||
      !checkpointPlansMatch(restored.checkpoint.plan, this.plan)
    ) {
      this.disable('checkpoint_plan_changed_during_reconcile');
      return ReviewCheckpointCommitStatus.Disabled;
    }
    if (
      !this.applyRestoredCheckpoint(
        restored.checkpoint,
        restored.expectedVersion
      )
    ) {
      this.disable('invalid_reconciled_checkpoint');
      return ReviewCheckpointCommitStatus.Disabled;
    }

    const accepted = this.acceptedResults.get(workKey);
    if (!accepted) {
      if (this.finalized) {
        this.disable('finalized_checkpoint_missing_batch');
        return ReviewCheckpointCommitStatus.Disabled;
      }
      return ReviewCheckpointCommitStatus.Accepted;
    }
    if (!checkpointPayloadsMatch(accepted, payload)) {
      this.disable('checkpoint_batch_payload_changed');
      return ReviewCheckpointCommitStatus.Disabled;
    }
    return ReviewCheckpointCommitStatus.Idempotent;
  }

  private async reconcileFinalizationConflict(): Promise<boolean> {
    const restored = await this.client.restore(restoreInput(this.plan));
    if (
      restored.status !== ReviewCheckpointRestoreStatus.Found ||
      !checkpointPlansMatch(restored.checkpoint.plan, this.plan) ||
      !this.applyRestoredCheckpoint(
        restored.checkpoint,
        restored.expectedVersion
      ) ||
      this.acceptedResults.size !== this.plan.workKeys.length
    ) {
      this.disable('checkpoint_changed_during_finalize');
      return false;
    }
    return true;
  }

  private applyRestoredCheckpoint(
    checkpoint: ReviewCheckpointRecord,
    expectedVersion: number
  ): boolean {
    const acceptedResults = acceptedResultsInPlanOrder(this.plan, checkpoint);
    if (
      acceptedResults === null ||
      checkpoint.version !== expectedVersion ||
      (checkpoint.finalized &&
        acceptedResults.size !== this.plan.workKeys.length)
    ) {
      return false;
    }
    this.expectedVersion = expectedVersion;
    this.acceptedResults = acceptedResults;
    this.finalized = checkpoint.finalized;
    return true;
  }

  private isExactBatchAcknowledgement(
    result: Exclude<
      Awaited<ReturnType<ReviewCheckpointClientPort['commitBatchResult']>>,
      { status: ReviewCheckpointBatchResultStatus.Conflict }
    >,
    workKey: string
  ): boolean {
    return (
      result.headSha.toLowerCase() === this.plan.headSha &&
      result.planHash.toLowerCase() === this.plan.planHash &&
      result.workKey.toLowerCase() === workKey
    );
  }

  private setAcceptedResult(
    workKey: string,
    payload: ReviewCheckpointBatchPayload
  ): void {
    const results = new Map(this.acceptedResults);
    results.set(workKey, payload);
    this.acceptedResults = new Map(
      this.plan.workKeys.flatMap((key) => {
        const accepted = results.get(key);
        return accepted ? [[key, accepted] as const] : [];
      })
    );
  }

  private async writeFinalizationMarker(
    snapshotAdvancementRequired: boolean
  ): Promise<boolean> {
    if (!this.markerWriter) return false;
    try {
      await this.markerWriter.write({
        protocolVersion: REVIEW_CHECKPOINT_PROTOCOL_VERSION,
        pullRequestNumber: this.plan.pullRequestNumber,
        headSha: this.plan.headSha,
        planHash: this.plan.planHash,
        expectedVersion: this.expectedVersion,
        snapshotAdvancementRequired,
      });
      return true;
    } catch {
      warnFailOpen(this.logger, 'finalization_marker_write_failed');
      return false;
    }
  }

  private disable(reason: string): void {
    if (this.disabled) return;
    this.disabled = true;
    warnFailOpen(this.logger, reason);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

function isValidVersionAcknowledgement(
  acknowledgedVersion: number,
  expectedVersion: number,
  idempotent: boolean
): boolean {
  return idempotent
    ? acknowledgedVersion >= expectedVersion
    : acknowledgedVersion === expectedVersion + 1;
}

function acceptedResultsInPlanOrder(
  plan: ReviewCheckpointPlanIdentity,
  checkpoint: ReviewCheckpointRecord
): Map<string, ReviewCheckpointBatchPayload> | null {
  const byWorkKey = new Map<string, ReviewCheckpointBatchPayload>();
  for (const accepted of checkpoint.acceptedResults) {
    const workKey = accepted.workKey.toLowerCase();
    if (!plan.workKeys.includes(workKey) || byWorkKey.has(workKey)) return null;
    byWorkKey.set(workKey, accepted.payload);
  }
  return new Map(
    plan.workKeys.flatMap((workKey) => {
      const payload = byWorkKey.get(workKey);
      return payload ? [[workKey, payload] as const] : [];
    })
  );
}

function restoreInput(plan: ReviewCheckpointPlanIdentity): {
  readonly pullRequestNumber: number;
  readonly baseSha: string;
  readonly headSha: string;
  readonly compatibilityKey: string;
  readonly planHash: string;
} {
  return {
    pullRequestNumber: plan.pullRequestNumber,
    baseSha: plan.baseSha,
    headSha: plan.headSha,
    compatibilityKey: plan.compatibilityKey,
    planHash: plan.planHash,
  };
}

function disabledCommit(): CommitReviewCheckpointBatchResult {
  return { status: ReviewCheckpointCommitStatus.Disabled };
}

function disabledFinalize(): FinalizeReviewCheckpointSessionResult {
  return { status: ReviewCheckpointSessionFinalizeStatus.Disabled };
}

function safeFailureReason(error: unknown): string {
  if (
    error instanceof Error &&
    /^review_checkpoint_[a-z_]+$/.test(error.message)
  ) {
    return error.message;
  }
  return 'unexpected_checkpoint_error';
}

function warnFailOpen(
  logger: ReviewCheckpointSessionLogger | undefined,
  reason: string
): void {
  logger?.warn(
    `Hosted review checkpoint unavailable; continuing without durable batch persistence (${reason.slice(0, 120)}).`
  );
}
