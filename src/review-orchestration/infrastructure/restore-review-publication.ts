import { ReviewActionV2ClientError } from '../../control-plane/review-action-v2-client';
import { ReviewActionV2OperationId } from '../../control-plane/generated/review-action-v2/review-action-v2';
import {
  canonicalizeReviewProjection,
  hashReviewProjectionCanonicalJson,
} from '../../review-projection/domain/review-projection-canonicalizer';
import type { ReviewProjectionEnvelopeV1 } from '../../review-projection/domain';
import { currentReviewProjectionFromEnvelope } from './current-review-projection-builder-adapter';
import { DeterministicReviewOrchestrationIdentity } from './codex-review-invocation-adapter';
import type { ExecutionDeadline } from '../../review-execution/domain/execution-deadline';
import type { MergeGateConclusion } from '../../review-projection/domain';
import {
  ReviewOrchestrationResultStatus,
  ReviewPublicationState,
  ReviewPublicationRequestOutcomeStatus,
  type RestoredReviewExecution,
  type ReviewActionV2ControlPlanePort,
  type ReviewRunAuthorization,
} from '../application';

/** Runs before new inventory or plan construction, including after a full process restart. */
export async function restoreReviewPublication(input: {
  restored: RestoredReviewExecution | null;
  authorization: ReviewRunAuthorization;
  controlPlane: ReviewActionV2ControlPlanePort;
  deadline: ExecutionDeadline;
  signal?: AbortSignal;
  sleep(ms: number): Promise<void>;
}): Promise<{
  status: ReviewOrchestrationResultStatus;
  publicationAttemptId?: string;
  canonicalReceiptSetHash?: string;
  failureCode?: string;
  mergeGateConclusion?: MergeGateConclusion;
} | null> {
  const artifact = input.restored?.persistedPlan?.artifact;
  if (!artifact) return null;
  if (
    artifact.reviewedHeadSha !== input.authorization.facts.headSha ||
    artifact.reviewRevisionHash !== input.authorization.facts.reviewRevisionHash
  )
    throw new Error('review_restore_artifact_revision_mismatch');
  const envelope = JSON.parse(artifact.projectionEnvelopeCanonicalJson) as {
    mergeGate: { conclusion: MergeGateConclusion };
    coverage: { state?: string; complete?: boolean };
  };
  let publicationRequested = false;
  const expires =
    Date.now() + input.authorization.limits.maxReconciliationDurationMs;
  for (;;) {
    input.signal?.throwIfAborted();
    const timeoutMs = Math.floor(
      input.deadline.clampProviderTimeout(Math.max(1, expires - Date.now()))
    );
    if (timeoutMs <= 0 || Date.now() >= expires)
      return {
        status: ReviewOrchestrationResultStatus.Failed,
        publicationAttemptId: artifact.publicationAttemptId,
        failureCode: 'publication_restore_deadline',
      };
    let result: Awaited<
      ReturnType<ReviewActionV2ControlPlanePort['readPublicationStatus']>
    >;
    try {
      result = await input.controlPlane.readPublicationStatus({
        authorization: input.authorization,
        publicationAttemptId: artifact.publicationAttemptId,
        timeoutMs,
      });
    } catch (error) {
      if (
        publicationRequested ||
        !(error instanceof ReviewActionV2ClientError) ||
        error.httpStatus !== 404 ||
        error.operationId !== ReviewActionV2OperationId.ReviewPublicationStatus
      )
        throw error;
      // A persisted artifact is not proof that publication was requested. Resume
      // the existing finalize/request protocol with exactly its frozen bytes.
      publicationRequested = true;
      const restored = input.restored!;
      const frozen = JSON.parse(
        artifact.projectionEnvelopeCanonicalJson
      ) as ReviewProjectionEnvelopeV1;
      if (
        canonicalizeReviewProjection(frozen) !==
          artifact.projectionEnvelopeCanonicalJson ||
        hashReviewProjectionCanonicalJson(
          artifact.projectionEnvelopeCanonicalJson
        ) !== artifact.projectionHash
      )
        throw new Error('review_restore_frozen_projection_changed');
      const projection = currentReviewProjectionFromEnvelope(
        frozen,
        artifact.projectionEnvelopeCanonicalJson,
        artifact.projectionHash
      );
      if (
        projection.artifactId !== artifact.artifactId ||
        projection.lifecycleStateHash !== artifact.lifecycleStateHash ||
        projection.commandLedgerWatermark !== artifact.commandLedgerWatermark
      )
        throw new Error('review_restore_frozen_artifact_changed');
      const identities = new DeterministicReviewOrchestrationIdentity();
      const finalized = await input.controlPlane.finalizeExecution({
        authorization: input.authorization,
        idempotencyKey: identities.deterministicId('idempotency-finalize', [
          restored.executionId,
          artifact.projectionHash,
        ]),
        execution: {
          executionId: restored.executionId,
          generation: restored.generation,
          streamVersion: restored.streamVersion,
          executionVersion: restored.version,
          restoredExecution: restored,
        },
        projection,
        allowPartial: !projection.coverageComplete,
      });
      const requested = await input.controlPlane.requestPublication({
        authorization: input.authorization,
        idempotencyKey: identities.deterministicId('idempotency-publication', [
          finalized.publicationPermit,
          artifact.projectionHash,
        ]),
        publicationPermit: finalized.publicationPermit,
        projection,
      });
      if (
        requested.status === ReviewPublicationRequestOutcomeStatus.Requested
      ) {
        if (requested.publicationAttemptId !== artifact.publicationAttemptId)
          throw new Error('review_restore_publication_identity_changed');
        continue;
      }
      return {
        status:
          requested.status === ReviewPublicationRequestOutcomeStatus.Stale
            ? ReviewOrchestrationResultStatus.PublicationStale
            : requested.status ===
                ReviewPublicationRequestOutcomeStatus.Conflict
              ? ReviewOrchestrationResultStatus.PublicationNotApplied
              : ReviewOrchestrationResultStatus.Failed,
        publicationAttemptId: artifact.publicationAttemptId,
        failureCode: 'publication_restore_not_requested',
      };
    }
    if (!result.terminal) {
      await input.sleep(Math.min(60_000, Math.max(1_000, result.pollAfterMs)));
      continue;
    }
    const outcome = result.outcome;
    const status =
      outcome.state === ReviewPublicationState.Succeeded
        ? envelope.coverage.complete === false ||
          envelope.coverage.state === 'partial'
          ? ReviewOrchestrationResultStatus.PartialCompleted
          : ReviewOrchestrationResultStatus.Completed
        : outcome.state === ReviewPublicationState.NotApplied
          ? ReviewOrchestrationResultStatus.PublicationNotApplied
          : [
                ReviewPublicationState.StaleCompensated,
                ReviewPublicationState.StaleVisible,
              ].includes(outcome.state)
            ? ReviewOrchestrationResultStatus.PublicationStale
            : ReviewOrchestrationResultStatus.Failed;
    return {
      status,
      publicationAttemptId: artifact.publicationAttemptId,
      canonicalReceiptSetHash: outcome.canonicalReceiptSetHash,
      mergeGateConclusion: envelope.mergeGate.conclusion,
      ...(status === ReviewOrchestrationResultStatus.Failed
        ? { failureCode: 'publication_terminal_unknown' }
        : {}),
    };
  }
}
