import { withRetry, RetryOptions } from '../../../src/utils/retry';

describe('withRetry per-error delay', () => {
  it('applies the per-error delay floor on every retry', async () => {
    const started = Date.now();
    let calls = 0;
    const result = await withRetry(
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
      } as RetryOptions
    );
    expect(result).toBe('recovered');
    expect(Date.now() - started).toBeGreaterThanOrEqual(240);
  });

  it('keeps the existing exponential timing when no per-error delay is provided', async () => {
    const started = Date.now();
    let calls = 0;
    await withRetry(
      async () => {
        calls += 1;
        if (calls < 2) throw new Error('synthetic transient');
        return 'ok';
      },
      { retries: 1, minTimeout: 50, maxTimeout: 50, retryOn: () => true }
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });
});
