import { createHash } from 'crypto';
import {
  BuildCurrentReviewProjection,
  type BuildCurrentReviewProjectionCommand,
} from '../../review-projection/application';
import { ProjectionCoverageState } from '../../review-projection/domain';
import type {
  ReviewComparisonBaseline,
  ReviewProjectionEnvelopeV1,
} from '../../review-projection/domain';
import {
  canonicalizeReviewProjection,
  hashReviewProjectionCanonicalJson,
} from '../../review-projection/domain/review-projection-canonicalizer';
import type {
  AcceptedReviewWorkSlotEvidence,
  CurrentReviewProjection,
  CurrentReviewProjectionBuilderPort,
  ReviewProtocolLimits,
} from '../application';

export interface ReviewProjectionCommandFactoryPort {
  create(input: {
    readonly comparisonBaseline?: ReviewComparisonBaseline | null;
    readonly acceptedEvidence: readonly AcceptedReviewWorkSlotEvidence[];
    readonly exhaustedWorkSlotIds: readonly string[];
    readonly exhaustedWorkSlotReasons?: ReadonlyMap<string, string>;
    readonly reviewRevisionHash: string;
  }): Promise<BuildCurrentReviewProjectionCommand>;
}

/**
 * Maps the projection context's immutable result into the transport artifact.
 * Finding selection, lineage, lifecycle, placement and merge-gate policy stay
 * exclusively inside BuildCurrentReviewProjection.
 */
export class CurrentReviewProjectionBuilderAdapter implements CurrentReviewProjectionBuilderPort {
  constructor(
    private readonly projection: BuildCurrentReviewProjection,
    private readonly commands: ReviewProjectionCommandFactoryPort,
    private readonly description?: {
      limits: ReviewProtocolLimits;
      unavailable(): void;
    }
  ) {}

  async build(
    input: Parameters<CurrentReviewProjectionBuilderPort['build']>[0]
  ): Promise<CurrentReviewProjection> {
    const command = await this.commands.create(input);
    if (command.scope.reviewRevisionHash !== input.reviewRevisionHash) {
      throw new Error('review_projection_command_revision_mismatch');
    }
    const built = await this.projection.execute(command);
    let envelope = built.envelope;
    let projectionCanonicalJson = built.canonicalJson;
    let projectionHash = built.projectionHash;
    if (input.prDescription && this.description) {
      const candidate = {
        ...envelope,
        publishing: {
          ...envelope.publishing,
          prDescription: input.prDescription,
        },
      };
      const candidateJson = canonicalizeReviewProjection(candidate);
      const candidateOperations = canonicalJson(candidate.publishing);
      const count =
        3 +
        candidate.publishing.inlineReviewChunks.length +
        candidate.publishing.lifecycle.length;
      if (
        Buffer.byteLength(candidateJson, 'utf8') <=
          this.description.limits.maxProjectionBytes &&
        Buffer.byteLength(candidateOperations, 'utf8') <=
          this.description.limits.maxPublicationBodyBytes &&
        count <= this.description.limits.maxPublicationOperations
      ) {
        envelope = candidate;
        projectionCanonicalJson = candidateJson;
        projectionHash = hashReviewProjectionCanonicalJson(candidateJson);
      } else this.description.unavailable();
    }
    return currentReviewProjectionFromEnvelope(
      envelope,
      projectionCanonicalJson,
      projectionHash,
      built.findingCount
    );
  }
}

/** Shared immutable transport mapping, also used when resuming a persisted artifact. */
export function currentReviewProjectionFromEnvelope(
  envelope: ReviewProjectionEnvelopeV1,
  projectionCanonicalJson = canonicalizeReviewProjection(envelope),
  projectionHash = hashReviewProjectionCanonicalJson(projectionCanonicalJson),
  findingCount = envelope.occurrences.length
): CurrentReviewProjection {
  const operationsCanonicalJson = canonicalJson(envelope.publishing);
  const artifactHash = sha256(
    `rr.review-artifact.v1\0${canonicalJson({
      operationsCanonicalJson,
      projectionHash,
    })}`
  );
  return Object.freeze({
    artifactId: `rr:artifact:${artifactHash}`,
    artifactHash,
    projectionEnvelopeVersion: 1,
    projectionEnvelopeCanonicalJson: projectionCanonicalJson,
    projectionHash,
    lifecycleStateHash: envelope.lifecycleStateHash,
    commandLedgerWatermark: envelope.commandLedgerWatermark,
    operationsCanonicalJson,
    findingCount,
    mergeGateConclusion: envelope.mergeGate.conclusion,
    publicationOperationCount:
      2 +
      (envelope.publishing.prDescription ? 1 : 0) +
      envelope.publishing.inlineReviewChunks.length +
      envelope.publishing.lifecycle.length,
    publicationChunkCount: envelope.publishing.inlineReviewChunks.length,
    coverageComplete:
      envelope.coverage.state === ProjectionCoverageState.Complete,
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
