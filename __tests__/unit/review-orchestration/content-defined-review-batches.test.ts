import {
  createContentDefinedReviewBatches,
  type ContentDefinedReviewBatch,
  type ContentDefinedReviewUnit,
} from '../../../src/review-orchestration/domain';

describe('createContentDefinedReviewBatches', () => {
  it('is membership-invariant across deterministic input permutations', () => {
    const values = Array.from({ length: 173 }, (_, index) => `src/${index}.ts`);
    const expected = membershipSignatures(plan(values, 11, 37));

    for (let seed = 1; seed <= 24; seed += 1) {
      expect(
        membershipSignatures(plan(permutation(values, seed), 11, 37))
      ).toEqual(expected);
    }
  });

  it('confines a local addition or content change to one existing leaf', () => {
    const values = Array.from({ length: 211 }, (_, index) => `src/${index}.ts`);
    const before = plan(values, 9, 50);
    const afterAddition = plan([...values, 'src/new-local-file.ts'], 9, 50);
    const changedUnits = units(values);
    changedUnits[77] = {
      ...changedUnits[77],
      canonicalIdentity: `${changedUnits[77].canonicalIdentity}:changed`,
    };
    const afterContentChange = createContentDefinedReviewBatches(changedUnits, {
      maxFilesPerBatch: 9,
      maxTokensPerBatch: 50,
    });

    expect(
      unchangedSignatureCount(before, afterAddition)
    ).toBeGreaterThanOrEqual(before.length - 1);
    expect(
      unchangedSignatureCount(before, afterContentChange)
    ).toBeGreaterThanOrEqual(before.length - 1);
  });

  it('recursively splits deterministically and enforces both hard limits', () => {
    const values = Array.from({ length: 257 }, (_, index) => `src/${index}.ts`);
    const first = plan(values, 7, 19);
    const second = plan(values, 7, 19);

    expect(batchSnapshot(second)).toEqual(batchSnapshot(first));
    expect(first.some((batch) => batch.splitDepth > 1)).toBe(true);
    expect(
      first.every(
        (batch) =>
          batch.units.length <= 7 &&
          batch.tokenCost <= 19 &&
          !batch.oversizedSingleUnit
      )
    ).toBe(true);
  });

  it('never duplicates or loses review units', () => {
    const values = Array.from({ length: 503 }, (_, index) => `src/${index}.ts`);
    const batches = plan(values, 13, 41);
    const observed = batches.flatMap((batch) =>
      batch.units.map((unit) => unit.value)
    );

    expect(observed).toHaveLength(values.length);
    expect(new Set(observed)).toEqual(new Set(values));
  });

  it('keeps an individually oversized unit for coverage without weakening other batches', () => {
    const planned = createContentDefinedReviewBatches(
      [
        ...units(['src/small-a.ts', 'src/small-b.ts']),
        {
          value: 'src/oversized.ts',
          routeKey: 'src/oversized.ts',
          canonicalIdentity: 'src/oversized.ts:v1',
          tokenCost: 100,
          schedulingPriority: 2,
        },
      ],
      {
        maxFilesPerBatch: 2,
        maxTokensPerBatch: 10,
      }
    );
    const oversized = planned.find((batch) =>
      batch.units.some((unit) => unit.value === 'src/oversized.ts')
    );

    expect(oversized).toMatchObject({
      oversizedSingleUnit: true,
      tokenCost: 100,
    });
    expect(oversized?.units).toHaveLength(1);
    expect(
      planned
        .filter((batch) => batch !== oversized)
        .every((batch) => batch.units.length <= 2 && batch.tokenCost <= 10)
    ).toBe(true);
  });
});

function plan(
  values: readonly string[],
  maxFilesPerBatch: number,
  maxTokensPerBatch: number
) {
  return createContentDefinedReviewBatches(units(values), {
    maxFilesPerBatch,
    maxTokensPerBatch,
  });
}

function units(values: readonly string[]): ContentDefinedReviewUnit<string>[] {
  return values.map((value, schedulingPriority) => ({
    value,
    routeKey: value,
    canonicalIdentity: `${value}:v1`,
    tokenCost: 3,
    schedulingPriority,
  }));
}

function membershipSignatures(
  batches: readonly ContentDefinedReviewBatch<string>[]
): string[] {
  return batches
    .map((batch) =>
      batch.units.map((unit) => unit.canonicalIdentity).join('\0')
    )
    .sort();
}

function unchangedSignatureCount(
  before: readonly ContentDefinedReviewBatch<string>[],
  after: readonly ContentDefinedReviewBatch<string>[]
): number {
  const afterSignatures = new Set(membershipSignatures(after));
  return membershipSignatures(before).filter((signature) =>
    afterSignatures.has(signature)
  ).length;
}

function batchSnapshot(batches: readonly ContentDefinedReviewBatch<string>[]) {
  return batches.map((batch) => ({
    members: batch.units.map((unit) => unit.canonicalIdentity),
    routePrefix: batch.routePrefix,
    schedulingOrdinal: batch.schedulingOrdinal,
    splitDepth: batch.splitDepth,
    tokenCost: batch.tokenCost,
  }));
}

function permutation<T>(values: readonly T[], seed: number): T[] {
  const result = [...values];
  let state = seed >>> 0;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const swapIndex = state % (index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}
