import { createHash } from 'crypto';
import type { FileChange } from '../../types';

export enum ReviewBatchPlanVersion {
  V1 = 'v1',
}

export interface CreateReviewBatchPlanInput {
  readonly batches: ReadonlyArray<ReadonlyArray<FileChange>>;
  readonly baseSha: string;
  readonly headSha: string;
  readonly compatibilityKey: string;
  readonly providerNames: readonly string[];
}

export interface PlannedReviewBatch {
  readonly id: string;
  readonly index: number;
  readonly files: ReadonlyArray<Readonly<FileChange>>;
}

export interface ReviewBatchPlan {
  readonly version: ReviewBatchPlanVersion;
  readonly planHash: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly compatibilityKey: string;
  readonly providerNames: readonly string[];
  readonly batches: readonly PlannedReviewBatch[];
}

interface CanonicalFileChange {
  readonly filename: string;
  readonly status: FileChange['status'];
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
  readonly patch: string | null;
  readonly previousFilename: string | null;
  readonly language: string | null;
}

interface CanonicalPlanPayload {
  readonly version: ReviewBatchPlanVersion;
  readonly baseSha: string;
  readonly headSha: string;
  readonly compatibilityKey: string;
  readonly providerNames: readonly string[];
  readonly batches: ReadonlyArray<ReadonlyArray<CanonicalFileChange>>;
}

function compareCodePoints(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function requireNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${field} must not be empty`);
  }
}

function canonicalFile(file: Readonly<FileChange>): CanonicalFileChange {
  return {
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    patch: file.patch ?? null,
    previousFilename: file.previousFilename ?? null,
    language: file.language ?? null,
  };
}

function cloneFile(file: Readonly<FileChange>): Readonly<FileChange> {
  return Object.freeze({ ...file });
}

export function createReviewBatchPlan(
  input: CreateReviewBatchPlanInput
): ReviewBatchPlan {
  requireNonEmpty(input.baseSha, 'baseSha');
  requireNonEmpty(input.headSha, 'headSha');
  requireNonEmpty(input.compatibilityKey, 'compatibilityKey');
  input.providerNames.forEach((name) => requireNonEmpty(name, 'providerName'));

  const providerNames = Object.freeze(
    [...input.providerNames].sort(compareCodePoints)
  );
  const canonicalBatches = input.batches.map((batch) =>
    batch.map(canonicalFile)
  );
  const payload: CanonicalPlanPayload = {
    version: ReviewBatchPlanVersion.V1,
    baseSha: input.baseSha,
    headSha: input.headSha,
    compatibilityKey: input.compatibilityKey,
    providerNames,
    batches: canonicalBatches,
  };
  const planHash = createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');

  const batches = Object.freeze(
    input.batches.map((batch, index) => {
      const id = createHash('sha256')
        .update(
          JSON.stringify({
            version: ReviewBatchPlanVersion.V1,
            planHash,
            index,
            files: canonicalBatches[index],
          })
        )
        .digest('hex');
      return Object.freeze({
        id,
        index,
        files: Object.freeze(batch.map(cloneFile)),
      });
    })
  );

  return Object.freeze({
    version: ReviewBatchPlanVersion.V1,
    planHash,
    baseSha: input.baseSha,
    headSha: input.headSha,
    compatibilityKey: input.compatibilityKey,
    providerNames,
    batches,
  });
}
