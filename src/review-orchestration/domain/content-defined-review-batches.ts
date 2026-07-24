import { createHash } from 'crypto';

export type ContentDefinedReviewUnit<T> = {
  readonly value: T;
  readonly routeKey: string;
  readonly canonicalIdentity: string;
  readonly tokenCost: number;
  readonly schedulingPriority: number;
};

export type ContentDefinedReviewBatch<T> = {
  readonly units: readonly ContentDefinedReviewUnit<T>[];
  readonly routePrefix: string;
  readonly splitDepth: number;
  readonly tokenCost: number;
  readonly schedulingOrdinal: number;
  readonly oversizedSingleUnit: boolean;
};

export type ContentDefinedReviewBatchLimits = {
  readonly maxFilesPerBatch: number;
  readonly maxTokensPerBatch: number;
};

type RoutedReviewUnit<T> = ContentDefinedReviewUnit<T> & {
  readonly routeHash: string;
};

type UnscheduledReviewBatch<T> = Omit<
  ContentDefinedReviewBatch<T>,
  'schedulingOrdinal'
>;

const ROUTE_HASH_BITS = 256;

/**
 * Partitions review units by stable route hashes. An overloaded bucket is split
 * by the next hash bit, so a local change can only invalidate its own hash path.
 */
export function createContentDefinedReviewBatches<T>(
  units: readonly ContentDefinedReviewUnit<T>[],
  limits: ContentDefinedReviewBatchLimits
): readonly ContentDefinedReviewBatch<T>[] {
  requirePositiveInteger(limits.maxFilesPerBatch, 'max_files_per_batch');
  requirePositiveInteger(limits.maxTokensPerBatch, 'max_tokens_per_batch');
  if (units.length === 0) return Object.freeze([]);

  const routeKeys = new Set<string>();
  const canonicalIdentities = new Set<string>();
  const schedulingPriorities = new Set<number>();
  const routed = units.map((unit) => {
    requireNonEmpty(unit.routeKey, 'route_key');
    requireNonEmpty(unit.canonicalIdentity, 'canonical_identity');
    requireNonNegativeInteger(unit.tokenCost, 'token_cost');
    requireNonNegativeInteger(unit.schedulingPriority, 'scheduling_priority');
    if (routeKeys.has(unit.routeKey)) {
      throw new Error('content_defined_batch_route_key_duplicate');
    }
    if (canonicalIdentities.has(unit.canonicalIdentity)) {
      throw new Error('content_defined_batch_identity_duplicate');
    }
    if (schedulingPriorities.has(unit.schedulingPriority)) {
      throw new Error('content_defined_batch_scheduling_priority_duplicate');
    }
    routeKeys.add(unit.routeKey);
    canonicalIdentities.add(unit.canonicalIdentity);
    schedulingPriorities.add(unit.schedulingPriority);
    return Object.freeze({
      ...unit,
      routeHash: sha256(`rr.review-unit-route.v1\0${unit.routeKey}`),
    });
  });

  const batches = splitBucket(routed, '', limits)
    .sort(compareBatchSchedulingPriority)
    .map((batch, schedulingOrdinal) =>
      Object.freeze({
        ...batch,
        schedulingOrdinal,
      })
    );
  return Object.freeze(batches);
}

function splitBucket<T>(
  units: readonly RoutedReviewUnit<T>[],
  routePrefix: string,
  limits: ContentDefinedReviewBatchLimits
): UnscheduledReviewBatch<T>[] {
  const tokenCost = totalTokenCost(units);
  if (
    units.length <= limits.maxFilesPerBatch &&
    tokenCost <= limits.maxTokensPerBatch
  ) {
    return [createBatch(units, routePrefix, tokenCost, false)];
  }
  if (units.length === 1) {
    return [createBatch(units, routePrefix, tokenCost, true)];
  }
  if (routePrefix.length >= ROUTE_HASH_BITS) {
    throw new Error('content_defined_batch_hash_space_exhausted');
  }

  const zero: RoutedReviewUnit<T>[] = [];
  const one: RoutedReviewUnit<T>[] = [];
  for (const unit of units) {
    (routeBit(unit.routeHash, routePrefix.length) === 0 ? zero : one).push(
      unit
    );
  }

  return [
    ...(zero.length > 0 ? splitBucket(zero, `${routePrefix}0`, limits) : []),
    ...(one.length > 0 ? splitBucket(one, `${routePrefix}1`, limits) : []),
  ];
}

function createBatch<T>(
  units: readonly RoutedReviewUnit<T>[],
  routePrefix: string,
  tokenCost: number,
  oversizedSingleUnit: boolean
): UnscheduledReviewBatch<T> {
  const canonicalUnits = [...units]
    .sort((left, right) =>
      compareCodePoints(left.canonicalIdentity, right.canonicalIdentity)
    )
    .map(({ routeHash: _routeHash, ...unit }) => Object.freeze(unit));
  return Object.freeze({
    units: Object.freeze(canonicalUnits),
    routePrefix,
    splitDepth: routePrefix.length,
    tokenCost,
    oversizedSingleUnit,
  });
}

function compareBatchSchedulingPriority<T>(
  left: UnscheduledReviewBatch<T>,
  right: UnscheduledReviewBatch<T>
): number {
  const priorityDifference =
    minimumSchedulingPriority(left.units) -
    minimumSchedulingPriority(right.units);
  return priorityDifference !== 0
    ? priorityDifference
    : compareCodePoints(left.routePrefix, right.routePrefix);
}

function minimumSchedulingPriority<T>(
  units: readonly ContentDefinedReviewUnit<T>[]
): number {
  return units.reduce(
    (minimum, unit) => Math.min(minimum, unit.schedulingPriority),
    Number.MAX_SAFE_INTEGER
  );
}

function totalTokenCost<T>(units: readonly RoutedReviewUnit<T>[]): number {
  let total = 0;
  for (const unit of units) {
    total += unit.tokenCost;
    if (!Number.isSafeInteger(total)) {
      throw new Error('content_defined_batch_token_cost_overflow');
    }
  }
  return total;
}

function routeBit(hash: string, bitIndex: number): 0 | 1 {
  const nibble = Number.parseInt(hash[Math.floor(bitIndex / 4)], 16);
  const shift = 3 - (bitIndex % 4);
  return ((nibble >> shift) & 1) as 0 | 1;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function compareCodePoints(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
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

function requireNonEmpty(value: string, field: string): void {
  if (value.length === 0) throw new Error(`${field}_invalid`);
}
