import { z } from 'zod';
import { FindingSeverity, type PriorLineageHint } from './review-projection';
import { deepFreezeProjection } from './review-projection-canonicalizer';
import { REVIEW_PROJECTION_ABSOLUTE_LIMITS as limits } from './review-projection-limits';

const boundedText = z
  .string()
  .min(1)
  .refine((value) => Buffer.byteLength(value) <= limits.maxStringBytes);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const line = z.number().int().positive().safe();
const hintSchema = z
  .object({
    lineageId: z.string().regex(/^rrl_[a-f0-9]{32}$/),
    category: boundedText,
    normalizedFailureModeHash: digest,
    symbolAnchor: boundedText.optional(),
    trustedMarker: z
      .string()
      .regex(/^(?:rrl_[a-f0-9]{32}|[a-f0-9]{24,64})$/)
      .optional(),
    severity: z.nativeEnum(FindingSeverity),
    title: boundedText,
    message: boundedText,
    filePath: boundedText,
    startLine: line.optional(),
    line: line.optional(),
    endLine: line.optional(),
    firstSeenHeadSha: sha,
    lastSeenHeadSha: sha,
    active: z.boolean(),
  })
  .strict();
const appliedResolutionSchema = z
  .object({
    lineageId: z.string().regex(/^rrl_[a-f0-9]{32}$/),
    targetId: boundedText,
    threadId: boundedText,
    markerFingerprint: z
      .string()
      .regex(/^(?:rrl_[a-f0-9]{32}|[a-f0-9]{24,64})$/),
    resolvedAt: z.string().refine((value) => {
      const date = new Date(value);
      return Number.isFinite(date.getTime()) && date.toISOString() === value;
    }),
  })
  .strict();

export interface AppliedReviewResolution {
  readonly lineageId: string;
  readonly targetId: string;
  readonly threadId: string;
  readonly markerFingerprint: string;
  readonly resolvedAt: string;
}

const baselineSchema = z
  .object({
    schemaVersion: z.literal('comparison_baseline.v1'),
    sourceReviewedHeadSha: sha,
    sourceReviewRevisionHash: digest,
    sourceExecutionGeneration: z
      .string()
      .regex(/^[1-9][0-9]{0,18}$/)
      .refine((value) => BigInt(value) <= 9223372036854775807n),
    snapshotVersion: z.number().int().positive().safe(),
    projectionPolicyVersion: z.enum([
      'review-projection-policy.v5-t0',
      'review-projection-policy.v6-comparison',
    ]),
    projectionEnvelopeVersion: z.literal('review_projection.v1'),
    priorLineageHints: z.array(hintSchema).max(limits.maxLineageHints),
    appliedResolutions: z
      .array(appliedResolutionSchema)
      .max(limits.maxLifecycleTargets),
  })
  .strict();

export interface ReviewComparisonBaseline {
  readonly schemaVersion: 'comparison_baseline.v1';
  readonly sourceReviewedHeadSha: string;
  readonly sourceReviewRevisionHash: string;
  readonly sourceExecutionGeneration: string;
  readonly snapshotVersion: number;
  readonly projectionPolicyVersion:
    | 'review-projection-policy.v5-t0'
    | 'review-projection-policy.v6-comparison';
  readonly projectionEnvelopeVersion: 'review_projection.v1';
  readonly priorLineageHints: readonly PriorLineageHint[];
  readonly appliedResolutions: readonly AppliedReviewResolution[];
}

/** Only authenticated snapshot transport calls this parser; malformed history is unavailable. */
export function parseReviewComparisonBaseline(
  value: unknown
): ReviewComparisonBaseline | null {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value) > limits.maxProjectionBytes
  )
    return null;
  try {
    const parsed = baselineSchema.safeParse(JSON.parse(value));
    if (!parsed.success) return null;
    const hints = parsed.data.priorLineageHints;
    const resolutions = parsed.data.appliedResolutions;
    if (
      new Set(
        resolutions.map((item) =>
          JSON.stringify([item.lineageId, item.threadId, item.targetId])
        )
      ).size !== resolutions.length
    )
      return null;
    if (
      resolutions.some(
        (item) =>
          !hints.some((hint) => hint.lineageId === item.lineageId) ||
          item.markerFingerprint !== item.lineageId
      )
    )
      return null;
    if (new Set(hints.map((hint) => hint.lineageId)).size !== hints.length)
      return null;
    if (
      hints.some(
        (hint) =>
          hint.startLine !== undefined &&
          hint.endLine !== undefined &&
          hint.startLine > hint.endLine
      )
    )
      return null;
    return deepFreezeProjection(parsed.data);
  } catch {
    return null;
  }
}
