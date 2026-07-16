export interface EpochClock {
  now(): number;
}

export interface ExecutionDeadlineWindows {
  readonly completionReserveMs: number;
  readonly minimumBatchStartWindowMs: number;
  readonly minimumOptionalRetryStartWindowMs: number;
}

const SYSTEM_CLOCK: EpochClock = {
  now: () => Date.now(),
};

function requireNonNegativeFinite(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative finite number`);
  }
}

export class ExecutionDeadline {
  constructor(
    private readonly deadlineEpochMs: number | undefined,
    private readonly windows: ExecutionDeadlineWindows,
    private readonly clock: EpochClock = SYSTEM_CLOCK
  ) {
    if (deadlineEpochMs !== undefined) {
      requireNonNegativeFinite(deadlineEpochMs, 'deadlineEpochMs');
    }
    requireNonNegativeFinite(
      windows.completionReserveMs,
      'completionReserveMs'
    );
    requireNonNegativeFinite(
      windows.minimumBatchStartWindowMs,
      'minimumBatchStartWindowMs'
    );
    requireNonNegativeFinite(
      windows.minimumOptionalRetryStartWindowMs,
      'minimumOptionalRetryStartWindowMs'
    );
  }

  remainingMs(): number {
    if (this.deadlineEpochMs === undefined) return Number.POSITIVE_INFINITY;
    return Math.max(0, this.deadlineEpochMs - this.clock.now());
  }

  canStartBatch(): boolean {
    return (
      this.remainingMs() >=
      this.windows.completionReserveMs + this.windows.minimumBatchStartWindowMs
    );
  }

  canStartInitialInvocation(): boolean {
    return this.canStartBatch();
  }

  clampProviderTimeout(requestedTimeoutMs: number): number {
    requireNonNegativeFinite(requestedTimeoutMs, 'requestedTimeoutMs');
    if (this.deadlineEpochMs === undefined) return requestedTimeoutMs;

    const usableTime = Math.max(
      0,
      this.remainingMs() - this.windows.completionReserveMs
    );
    return Math.min(requestedTimeoutMs, usableTime);
  }

  canStartOptionalRetry(): boolean {
    return (
      this.remainingMs() >=
      this.windows.completionReserveMs +
        this.windows.minimumOptionalRetryStartWindowMs
    );
  }
}
