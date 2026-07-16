import {
  AdaptiveBatchScheduler,
  BatchDeferralReason,
  BatchExecutionStatus,
} from '../../../src/review-execution/application/adaptive-batch-scheduler';
import { CapacitySignal } from '../../../src/review-execution/domain/capacity-signal';

interface ControlledResult {
  readonly item: number;
  readonly signal: CapacitySignal;
}

interface ControlledExecutor {
  readonly execute: (item: number) => Promise<ControlledResult>;
  readonly started: number[];
  readonly maxActive: () => number;
  readonly resolve: (item: number, signal: CapacitySignal) => void;
}

function controlledExecutor(): ControlledExecutor {
  const started: number[] = [];
  const resolvers = new Map<number, (result: ControlledResult) => void>();
  let active = 0;
  let maximumActive = 0;

  return {
    execute: (item) =>
      new Promise((resolve) => {
        started.push(item);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        resolvers.set(item, resolve);
      }),
    started,
    maxActive: () => maximumActive,
    resolve: (item, signal) => {
      const resolve = resolvers.get(item);
      if (resolve === undefined) throw new Error(`Item ${item} is not running`);
      resolvers.delete(item);
      active -= 1;
      resolve({ item, signal });
    },
  };
}

async function flushScheduler(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

const classify = (result: ControlledResult): CapacitySignal => result.signal;

describe('AdaptiveBatchScheduler', () => {
  it('starts at two, promotes to three, and never exceeds the hard maximum', async () => {
    const controlled = controlledExecutor();
    const scheduler = new AdaptiveBatchScheduler({ canStartBatch: () => true });
    const scheduled = scheduler.schedule(
      [0, 1, 2, 3, 4],
      controlled.execute,
      classify
    );

    await flushScheduler();
    expect(controlled.started).toEqual([0, 1]);

    controlled.resolve(0, CapacitySignal.Healthy);
    await flushScheduler();
    expect(controlled.started).toEqual([0, 1, 2, 3]);
    expect(controlled.maxActive()).toBe(3);

    controlled.resolve(1, CapacitySignal.Healthy);
    controlled.resolve(2, CapacitySignal.Healthy);
    controlled.resolve(3, CapacitySignal.Healthy);
    await flushScheduler();
    expect(controlled.started).toEqual([0, 1, 2, 3, 4]);

    controlled.resolve(4, CapacitySignal.Healthy);
    const result = await scheduled;
    expect(result.completed.map((entry) => entry.index)).toEqual([
      0, 1, 2, 3, 4,
    ]);
    expect(
      result.completed.every(
        (entry) => entry.status === BatchExecutionStatus.Fulfilled
      )
    ).toBe(true);
    expect(result.deferred).toEqual([]);
  });

  it('drops to one on capacity pressure without cancelling in-flight work', async () => {
    const controlled = controlledExecutor();
    const scheduler = new AdaptiveBatchScheduler({ canStartBatch: () => true });
    const scheduled = scheduler.schedule(
      [0, 1, 2, 3, 4],
      controlled.execute,
      classify
    );

    await flushScheduler();
    controlled.resolve(0, CapacitySignal.CapacityPressure);
    await flushScheduler();
    expect(controlled.started).toEqual([0, 1]);

    controlled.resolve(1, CapacitySignal.Healthy);
    await flushScheduler();
    expect(controlled.started).toEqual([0, 1, 2]);

    controlled.resolve(2, CapacitySignal.Healthy);
    await flushScheduler();
    expect(controlled.started).toEqual([0, 1, 2, 3]);

    controlled.resolve(3, CapacitySignal.Healthy);
    await flushScheduler();
    expect(controlled.started).toEqual([0, 1, 2, 3, 4]);

    controlled.resolve(4, CapacitySignal.Healthy);
    const result = await scheduled;
    expect(controlled.maxActive()).toBe(2);
    expect(result.completed.map((entry) => entry.item)).toEqual([
      0, 1, 2, 3, 4,
    ]);
  });

  it('defers unstarted items at the deadline and waits for in-flight work', async () => {
    const controlled = controlledExecutor();
    const canStartBatch = jest
      .fn<boolean, []>()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    const scheduler = new AdaptiveBatchScheduler({ canStartBatch });
    const scheduled = scheduler.schedule(
      [0, 1, 2, 3],
      controlled.execute,
      classify
    );
    let settled = false;
    void scheduled.then(() => {
      settled = true;
    });

    await flushScheduler();
    expect(controlled.started).toEqual([0, 1]);

    controlled.resolve(0, CapacitySignal.Healthy);
    await flushScheduler();
    expect(controlled.started).toEqual([0, 1]);
    expect(settled).toBe(false);

    controlled.resolve(1, CapacitySignal.Healthy);
    const result = await scheduled;
    expect(result.completed.map((entry) => entry.index)).toEqual([0, 1]);
    expect(result.deferred).toEqual([
      { index: 2, item: 2, reason: BatchDeferralReason.InsufficientDeadline },
      { index: 3, item: 3, reason: BatchDeferralReason.InsufficientDeadline },
    ]);
    expect(canStartBatch).toHaveBeenCalledTimes(3);
  });
});
