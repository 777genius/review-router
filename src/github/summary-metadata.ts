import { ReviewThreadLifecycleMode } from '../types';

export const REVIEW_THREAD_LIFECYCLE_SCHEMA_VERSION =
  'review-thread-lifecycle-v1';

const SUMMARY_METADATA_RE =
  /<!--\s*review-router-summary:([A-Za-z0-9+/=]+)\s*-->/;

export interface ReviewSummaryMetadata {
  reviewedHeadSha?: string;
  workflowRunId?: string;
  workflowRunAttempt?: number;
  lifecycleMode?: ReviewThreadLifecycleMode;
  lifecycleSchemaVersion?: string;
  summaryGeneratedAt?: string;
}

export interface SummaryWriteGuardResult {
  shouldSkip: boolean;
  reason?: 'head_sha_changed' | 'newer_summary_exists';
}

export function buildReviewSummaryMetadata(input: {
  reviewedHeadSha?: string;
  lifecycleMode?: ReviewThreadLifecycleMode;
}): ReviewSummaryMetadata {
  const attempt = Number.parseInt(process.env.GITHUB_RUN_ATTEMPT || '', 10);
  return {
    reviewedHeadSha: input.reviewedHeadSha,
    workflowRunId: process.env.GITHUB_RUN_ID || undefined,
    workflowRunAttempt: Number.isFinite(attempt) ? attempt : undefined,
    lifecycleMode: input.lifecycleMode,
    lifecycleSchemaVersion: REVIEW_THREAD_LIFECYCLE_SCHEMA_VERSION,
    summaryGeneratedAt: new Date().toISOString(),
  };
}

export function appendReviewSummaryMetadata(
  body: string,
  metadata?: ReviewSummaryMetadata
): string {
  if (!metadata) return body;
  const encoded = Buffer.from(JSON.stringify(metadata), 'utf8').toString(
    'base64'
  );
  const cleanBody = body.replace(SUMMARY_METADATA_RE, '').trimEnd();
  return `${cleanBody}\n\n<!-- review-router-summary:${encoded} -->`;
}

export function extractReviewSummaryMetadata(
  body?: string | null
): ReviewSummaryMetadata | undefined {
  const encoded = body?.match(SUMMARY_METADATA_RE)?.[1];
  if (!encoded) return undefined;
  try {
    const parsed = JSON.parse(
      Buffer.from(encoded, 'base64').toString('utf8')
    ) as ReviewSummaryMetadata;
    if (!parsed || typeof parsed !== 'object') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function shouldSkipSummaryWriteForExisting(
  existingBody: string | undefined,
  current: ReviewSummaryMetadata | undefined
): SummaryWriteGuardResult {
  if (!current) return { shouldSkip: false };
  const existing = extractReviewSummaryMetadata(existingBody);
  if (!existing) return { shouldSkip: false };

  if (existing.reviewedHeadSha && current.reviewedHeadSha) {
    if (existing.reviewedHeadSha === current.reviewedHeadSha) {
      if (isExistingRunNewer(existing, current)) {
        return { shouldSkip: true, reason: 'newer_summary_exists' };
      }
    } else if (isExistingRunNewer(existing, current)) {
      return { shouldSkip: true, reason: 'newer_summary_exists' };
    }
  }

  return { shouldSkip: false };
}

function isExistingRunNewer(
  existing: ReviewSummaryMetadata,
  current: ReviewSummaryMetadata
): boolean {
  const existingRun = numberFromString(existing.workflowRunId);
  const currentRun = numberFromString(current.workflowRunId);
  if (existingRun !== undefined && currentRun !== undefined) {
    if (existingRun > currentRun) return true;
    if (existingRun < currentRun) return false;
  }

  if (
    existing.workflowRunId &&
    current.workflowRunId &&
    existing.workflowRunId === current.workflowRunId
  ) {
    const existingAttempt = existing.workflowRunAttempt ?? 0;
    const currentAttempt = current.workflowRunAttempt ?? 0;
    if (existingAttempt > currentAttempt) return true;
    if (existingAttempt < currentAttempt) return false;
  }

  const existingGenerated = Date.parse(existing.summaryGeneratedAt || '');
  const currentGenerated = Date.parse(current.summaryGeneratedAt || '');
  return (
    Number.isFinite(existingGenerated) &&
    Number.isFinite(currentGenerated) &&
    existingGenerated > currentGenerated
  );
}

function numberFromString(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
