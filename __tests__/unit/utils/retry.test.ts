import { withRetry } from '../../../src/utils/retry';

describe('withRetry per-error delay', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('applies the per-error delay floor on every retry', async () => {
    let calls = 0;
    const result = withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('synthetic transient lane');
        return 'recovered';
      },
      {
        retries: 2,
        minTimeout: 0,
        maxTimeout: 0,
        retryOn: () => true,
        retryDelayMs: () => 120,
      }
    );

    await jest.advanceTimersByTimeAsync(119);
    expect(calls).toBe(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(calls).toBe(2);
    await jest.advanceTimersByTimeAsync(119);
    expect(calls).toBe(2);
    await jest.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe('recovered');
    expect(calls).toBe(3);
  });

  it('keeps the existing exponential timing when no per-error delay is provided', async () => {
    let calls = 0;
    const result = withRetry(
      async () => {
        calls += 1;
        if (calls < 2) throw new Error('synthetic transient');
        return 'ok';
      },
      { retries: 1, minTimeout: 50, maxTimeout: 50, retryOn: () => true }
    );

    await jest.advanceTimersByTimeAsync(49);
    expect(calls).toBe(1);
    await jest.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe('ok');
    expect(calls).toBe(2);
  });

  it('applies the per-error delay floor when retryOn is omitted', async () => {
    let calls = 0;
    const result = withRetry(
      async () => {
        calls += 1;
        if (calls < 2) throw new Error('transient');
        return 'ok';
      },
      { retries: 2, minTimeout: 0, maxTimeout: 0, retryDelayMs: () => 120 }
    );

    await jest.advanceTimersByTimeAsync(119);
    expect(calls).toBe(1);
    await jest.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe('ok');
    expect(calls).toBe(2);
  });
});
