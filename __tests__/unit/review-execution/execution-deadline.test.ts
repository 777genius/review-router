import {
  EpochClock,
  ExecutionDeadline,
} from '../../../src/review-execution/domain/execution-deadline';

describe('ExecutionDeadline', () => {
  let now: number;
  let clock: EpochClock;

  beforeEach(() => {
    now = 6_000;
    clock = { now: () => now };
  });

  function deadline(): ExecutionDeadline {
    return new ExecutionDeadline(
      10_000,
      {
        completionReserveMs: 1_000,
        minimumBatchStartWindowMs: 2_000,
        minimumOptionalRetryStartWindowMs: 3_000,
      },
      clock
    );
  }

  it('uses inclusive minimum-start boundaries', () => {
    const value = deadline();

    expect(value.remainingMs()).toBe(4_000);
    expect(value.canStartOptionalRetry()).toBe(true);

    now = 7_000;
    expect(value.canStartBatch()).toBe(true);
    expect(value.canStartOptionalRetry()).toBe(false);

    now = 7_001;
    expect(value.canStartBatch()).toBe(false);
  });

  it('clamps provider timeouts before the completion reserve', () => {
    const value = deadline();

    expect(value.clampProviderTimeout(5_000)).toBe(3_000);
    expect(value.clampProviderTimeout(1_000)).toBe(1_000);

    now = 9_000;
    expect(value.clampProviderTimeout(5_000)).toBe(0);
  });

  it('represents an absent deadline without constraining work', () => {
    const value = new ExecutionDeadline(
      undefined,
      {
        completionReserveMs: 1_000,
        minimumBatchStartWindowMs: 2_000,
        minimumOptionalRetryStartWindowMs: 3_000,
      },
      clock
    );

    expect(value.remainingMs()).toBe(Number.POSITIVE_INFINITY);
    expect(value.canStartBatch()).toBe(true);
    expect(value.canStartOptionalRetry()).toBe(true);
    expect(value.clampProviderTimeout(12_345)).toBe(12_345);
  });
});
