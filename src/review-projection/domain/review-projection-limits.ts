export interface ReviewProjectionLimits {
  readonly maxProjectionBytes: number;
  readonly maxFindings: number;
  readonly maxReferencesPerFinding: number;
  readonly maxLineageHints: number;
  readonly maxLifecycleTargets: number;
  readonly maxRevisionFiles: number;
  readonly maxDiffBytes: number;
  readonly maxSummaryBytes: number;
  readonly maxCheckSummaryBytes: number;
  readonly maxInlineComments: number;
  readonly maxInlineCommentsPerChunk: number;
  readonly maxInlineChunks: number;
  readonly maxInlineCommentBodyBytes: number;
  readonly maxStringBytes: number;
}

export const REVIEW_PROJECTION_ABSOLUTE_LIMITS: ReviewProjectionLimits = {
  maxProjectionBytes: 2_000_000,
  maxFindings: 1_000,
  maxReferencesPerFinding: 100,
  maxLineageHints: 2_000,
  maxLifecycleTargets: 2_000,
  maxRevisionFiles: 5_000,
  maxDiffBytes: 2_000_000,
  maxSummaryBytes: 65_000,
  maxCheckSummaryBytes: 65_000,
  maxInlineComments: 500,
  maxInlineCommentsPerChunk: 50,
  maxInlineChunks: 20,
  maxInlineCommentBodyBytes: 65_000,
  maxStringBytes: 65_000,
};

export class ReviewProjectionLimitError extends Error {
  constructor(
    readonly limitName: keyof ReviewProjectionLimits,
    readonly actual: number,
    readonly maximum: number
  ) {
    super(
      `review projection ${limitName} exceeded: ${actual} is greater than ${maximum}`
    );
    this.name = 'ReviewProjectionLimitError';
  }
}

export function validateReviewProjectionLimits(
  limits: ReviewProjectionLimits
): ReviewProjectionLimits {
  for (const key of Object.keys(REVIEW_PROJECTION_ABSOLUTE_LIMITS) as Array<
    keyof ReviewProjectionLimits
  >) {
    const value = limits[key];
    const absoluteMaximum = REVIEW_PROJECTION_ABSOLUTE_LIMITS[key];
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`review projection ${key} must be a positive integer`);
    }
    if (value > absoluteMaximum) {
      throw new ReviewProjectionLimitError(key, value, absoluteMaximum);
    }
  }
  return Object.freeze({ ...limits });
}

export function assertWithinProjectionLimit(
  limitName: keyof ReviewProjectionLimits,
  actual: number,
  limits: ReviewProjectionLimits
): void {
  const maximum = limits[limitName];
  if (actual > maximum) {
    throw new ReviewProjectionLimitError(limitName, actual, maximum);
  }
}
