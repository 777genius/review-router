import { LLMExecutor } from '../../../../src/analysis/llm/executor';
import { DEFAULT_CONFIG } from '../../../../src/config/defaults';
import { Provider, RateLimitError } from '../../../../src/providers/base';
import { ReviewResult } from '../../../../src/types';
import { ExecutionDeadline } from '../../../../src/review-execution/domain/execution-deadline';

class DelayedProvider extends Provider {
  healthCompleted = false;
  reviewCompleted = false;

  constructor(name: string) {
    super(name);
  }

  async healthCheck(): Promise<boolean> {
    await new Promise((resolve) => setTimeout(resolve, 10));
    this.healthCompleted = true;
    return true;
  }

  async review(): Promise<ReviewResult> {
    await new Promise((resolve) => setTimeout(resolve, 10));
    this.reviewCompleted = true;
    return {
      content: '{"findings":[]}',
      findings: [],
      durationSeconds: 0.01,
    };
  }
}

class SequenceProvider extends Provider {
  prompts: string[] = [];

  constructor(
    name: string,
    private readonly responses: Array<ReviewResult | Error>
  ) {
    super(name);
  }

  async review(prompt: string): Promise<ReviewResult> {
    this.prompts.push(prompt);
    const next = this.responses.shift();
    if (next instanceof Error) {
      throw next;
    }
    return (
      next ?? {
        content: '{"findings":[]}',
        findings: [],
        durationSeconds: 0.01,
      }
    );
  }
}

class TimeoutCaptureProvider extends Provider {
  timeoutMs?: number;

  async review(_prompt: string, timeoutMs: number): Promise<ReviewResult> {
    this.timeoutMs = timeoutMs;
    return {
      content: '{"findings":[]}',
      findings: [],
      durationSeconds: 0.01,
    };
  }
}

class ConcurrencyCaptureProvider extends Provider {
  active = 0;
  maxActive = 0;

  async review(): Promise<ReviewResult> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    this.active -= 1;
    return {
      content: '{"findings":[]}',
      findings: [],
      durationSeconds: 0.02,
    };
  }
}

class HealthTimeoutCaptureProvider extends Provider {
  healthTimeouts: number[] = [];

  constructor(
    name: string,
    private readonly onHealthCheck: (timeoutMs: number) => Promise<boolean>
  ) {
    super(name);
  }

  async healthCheck(timeoutMs: number): Promise<boolean> {
    this.healthTimeouts.push(timeoutMs);
    return this.onHealthCheck(timeoutMs);
  }

  async review(): Promise<ReviewResult> {
    return {
      content: '{"findings":[]}',
      findings: [],
      durationSeconds: 0,
    };
  }
}

describe('LLMExecutor', () => {
  it('waits for queued health checks before returning', async () => {
    const provider = new DelayedProvider('openrouter/test-model');
    const executor = new LLMExecutor(DEFAULT_CONFIG);

    const result = await executor.filterHealthyProviders([provider], 1000);

    expect(provider.healthCompleted).toBe(true);
    expect(result.healthy).toEqual([provider]);
    expect(result.healthCheckResults).toHaveLength(1);
  });

  it('skips brittle health probes for Codex CLI providers', async () => {
    const provider = new DelayedProvider('codex/gpt-5.5');
    const executor = new LLMExecutor(DEFAULT_CONFIG);

    const result = await executor.filterHealthyProviders([provider], 1000);

    expect(provider.healthCompleted).toBe(false);
    expect(result.healthy).toEqual([provider]);
    expect(result.healthCheckResults[0]).toMatchObject({
      name: 'codex/gpt-5.5',
      status: 'success',
    });
  });

  it('clamps health checks to the execution deadline reserve', async () => {
    const provider = new HealthTimeoutCaptureProvider(
      'openrouter/test-model',
      async () => true
    );
    const deadline = new ExecutionDeadline(
      10_000,
      {
        completionReserveMs: 1_000,
        minimumBatchStartWindowMs: 1_000,
        minimumOptionalRetryStartWindowMs: 1_000,
      },
      { now: () => 6_000 }
    );
    const executor = new LLMExecutor(DEFAULT_CONFIG, { deadline });

    const result = await executor.filterHealthyProviders([provider], 8_000);

    expect(provider.healthTimeouts).toEqual([3_000]);
    expect(result.healthy).toEqual([provider]);
  });

  it('does not start queued health checks after the deadline reserve is reached', async () => {
    let now = 0;
    const first = new HealthTimeoutCaptureProvider(
      'openrouter/first',
      async () => {
        now = 80;
        return true;
      }
    );
    const second = new HealthTimeoutCaptureProvider(
      'openrouter/second',
      async () => true
    );
    const deadline = new ExecutionDeadline(
      100,
      {
        completionReserveMs: 20,
        minimumBatchStartWindowMs: 10,
        minimumOptionalRetryStartWindowMs: 10,
      },
      { now: () => now }
    );
    const executor = new LLMExecutor(
      { ...DEFAULT_CONFIG, providerMaxParallel: 1 },
      { deadline }
    );

    const result = await executor.filterHealthyProviders([first, second], 100);

    expect(first.healthTimeouts).toEqual([80]);
    expect(second.healthTimeouts).toEqual([]);
    expect(result.healthy).toEqual([first]);
    expect(result.healthCheckResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'openrouter/second',
          status: 'timeout',
          error: expect.objectContaining({
            code: 'REVIEW_DEADLINE_REACHED',
          }),
        }),
      ])
    );
  });

  it('bounds a health check that ignores its supplied timeout', async () => {
    jest.useFakeTimers();
    const provider = new HealthTimeoutCaptureProvider(
      'openrouter/stalled',
      () => new Promise<boolean>(() => undefined)
    );
    const executor = new LLMExecutor(DEFAULT_CONFIG);

    const resultPromise = executor.filterHealthyProviders([provider], 25);
    await jest.advanceTimersByTimeAsync(25);
    const result = await resultPromise;

    expect(result.healthy).toEqual([]);
    expect(result.healthCheckResults[0]).toMatchObject({
      name: 'openrouter/stalled',
      status: 'timeout',
    });
    jest.useRealTimers();
  });

  it('exposes a deadline guard and timeout clamp for provider discovery waves', () => {
    let now = 6_000;
    const deadline = new ExecutionDeadline(
      10_000,
      {
        completionReserveMs: 1_000,
        minimumBatchStartWindowMs: 2_000,
        minimumOptionalRetryStartWindowMs: 1_000,
      },
      { now: () => now }
    );
    const executor = new LLMExecutor(DEFAULT_CONFIG, { deadline });

    expect(executor.canStartProviderDiscovery()).toBe(true);
    expect(executor.clampProviderDiscoveryTimeout(10_000)).toBe(3_000);

    now = 7_001;
    expect(executor.canStartProviderDiscovery()).toBe(false);
  });

  it('does not invoke another provider discovery wave near the deadline', async () => {
    const deadline = new ExecutionDeadline(
      10_000,
      {
        completionReserveMs: 1_000,
        minimumBatchStartWindowMs: 2_000,
        minimumOptionalRetryStartWindowMs: 1_000,
      },
      { now: () => 7_001 }
    );
    const executor = new LLMExecutor(DEFAULT_CONFIG, { deadline });
    const operation = jest.fn<Promise<string[]>, []>();

    const result = await executor.runProviderDiscoveryWave(operation, 5_000);

    expect(result).toBeUndefined();
    expect(operation).not.toHaveBeenCalled();
  });

  it('bounds a provider discovery wave that ignores its timeout', async () => {
    jest.useFakeTimers();
    const executor = new LLMExecutor(DEFAULT_CONFIG);
    const operation = jest.fn(() => new Promise<string[]>(() => undefined));

    const resultPromise = executor.runProviderDiscoveryWave(operation, 25);
    await jest.advanceTimersByTimeAsync(25);

    await expect(resultPromise).resolves.toBeUndefined();
    expect(operation).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('waits for queued reviews before returning', async () => {
    const provider = new DelayedProvider('codex/gpt-5.5');
    const executor = new LLMExecutor(DEFAULT_CONFIG);

    const results = await executor.execute([provider], 'prompt', 1000);

    expect(provider.reviewCompleted).toBe(true);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('success');
  });

  it('retries invalid review JSON up to configured total attempts and succeeds', async () => {
    const provider = new SequenceProvider('codex/gpt-5.5', [
      new Error(
        'Codex CLI returned invalid review JSON: response was not valid JSON'
      ),
      new Error(
        'Codex CLI returned invalid review JSON: expected an object with a findings array'
      ),
      {
        content: '{"findings":[],"revalidations":[]}',
        findings: [],
        revalidations: [],
        durationSeconds: 0.01,
      },
    ]);
    const executor = new LLMExecutor({
      ...DEFAULT_CONFIG,
      providerRetries: 3,
    });

    const results = await executor.execute([provider], 'base prompt', 1000);

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('success');
    expect(provider.prompts).toHaveLength(3);
    expect(provider.prompts[0]).toBe('base prompt');
    expect(provider.prompts[1]).toContain('JSON OUTPUT RETRY NOTICE');
    expect(provider.prompts[1]).toContain('Return ONLY one valid JSON object');
    expect(provider.prompts[2]).toContain(
      'previous response was rejected because it did not produce valid ReviewRouter JSON'
    );
  });

  it('does not retry timeout errors', async () => {
    const provider = new SequenceProvider('codex/gpt-5.5', [
      new Error('Provider timed out after 600000ms'),
      {
        content: '{"findings":[]}',
        findings: [],
        durationSeconds: 0.01,
      },
    ]);
    const executor = new LLMExecutor({
      ...DEFAULT_CONFIG,
      providerRetries: 3,
    });

    const results = await executor.execute([provider], 'prompt', 1000);

    expect(provider.prompts).toHaveLength(1);
    expect(results[0].status).toBe('timeout');
  });

  it('does not retry rate-limit errors', async () => {
    const provider = new SequenceProvider('codex/gpt-5.5', [
      new RateLimitError('Rate limited'),
      {
        content: '{"findings":[]}',
        findings: [],
        durationSeconds: 0.01,
      },
    ]);
    const executor = new LLMExecutor({
      ...DEFAULT_CONFIG,
      providerRetries: 3,
    });

    const results = await executor.execute([provider], 'prompt', 1000);

    expect(provider.prompts).toHaveLength(1);
    expect(results[0].status).toBe('rate-limited');
  });

  it('does not retry auth errors', async () => {
    const provider = new SequenceProvider('codex/gpt-5.5', [
      new Error('401 Unauthorized access token could not be refreshed'),
      {
        content: '{"findings":[]}',
        findings: [],
        durationSeconds: 0.01,
      },
    ]);
    const executor = new LLMExecutor({
      ...DEFAULT_CONFIG,
      providerRetries: 3,
    });

    const results = await executor.execute([provider], 'prompt', 1000);

    expect(provider.prompts).toHaveLength(1);
    expect(results[0].status).toBe('error');
  });

  it('caps OpenRouter provider timeout without changing Codex timeout', async () => {
    const openrouter = new TimeoutCaptureProvider('openrouter/free');
    const codex = new TimeoutCaptureProvider('codex/gpt-5.5');
    const executor = new LLMExecutor({
      ...DEFAULT_CONFIG,
      runTimeoutSeconds: 600,
      openrouterTimeoutSeconds: 300,
    });

    const results = await executor.execute([openrouter, codex], 'prompt');

    expect(results).toHaveLength(2);
    expect(openrouter.timeoutMs).toBe(300000);
    expect(codex.timeoutMs).toBe(600000);
  });

  it('keeps lower explicit timeout for OpenRouter providers', async () => {
    const openrouter = new TimeoutCaptureProvider('openrouter/free');
    const executor = new LLMExecutor({
      ...DEFAULT_CONFIG,
      openrouterTimeoutSeconds: 300,
    });

    await executor.execute([openrouter], 'prompt', 120000);

    expect(openrouter.timeoutMs).toBe(120000);
  });

  it('clamps provider timeout to the shared execution deadline', async () => {
    const provider = new TimeoutCaptureProvider('codex/gpt-5.5');
    const deadline = new ExecutionDeadline(
      10_000,
      {
        completionReserveMs: 1_000,
        minimumBatchStartWindowMs: 1_000,
        minimumOptionalRetryStartWindowMs: 2_000,
      },
      { now: () => 6_000 }
    );
    const executor = new LLMExecutor(DEFAULT_CONFIG, { deadline });

    await executor.execute([provider], 'prompt', 8_000);

    expect(provider.timeoutMs).toBe(3_000);
  });

  it('suppresses optional structured-output retries near the deadline', async () => {
    const provider = new SequenceProvider('codex/gpt-5.5', [
      new Error(
        'Codex CLI returned invalid review JSON: response was not valid JSON'
      ),
      {
        content: '{"findings":[]}',
        findings: [],
        durationSeconds: 0.01,
      },
    ]);
    const deadline = new ExecutionDeadline(
      10_000,
      {
        completionReserveMs: 1_000,
        minimumBatchStartWindowMs: 1_000,
        minimumOptionalRetryStartWindowMs: 3_000,
      },
      { now: () => 7_000 }
    );
    const executor = new LLMExecutor(
      { ...DEFAULT_CONFIG, providerRetries: 3 },
      { deadline }
    );

    const results = await executor.execute([provider], 'prompt', 1_000);

    expect(provider.prompts).toHaveLength(1);
    expect(results[0].status).toBe('error');
  });

  it('enforces one aggregate provider-call limit across concurrent batches', async () => {
    const provider = new ConcurrencyCaptureProvider('codex/gpt-5.5');
    const executor = new LLMExecutor(DEFAULT_CONFIG, { maxParallelCalls: 2 });

    await Promise.all([
      executor.execute([provider], 'batch-1'),
      executor.execute([provider], 'batch-2'),
      executor.execute([provider], 'batch-3'),
      executor.execute([provider], 'batch-4'),
    ]);

    expect(provider.maxActive).toBe(2);
  });

  it('does not start a queued paid call after its start window closes', async () => {
    let now = 0;
    const first = new SequenceProvider('codex/first', [
      {
        content: '{"findings":[]}',
        findings: [],
        durationSeconds: 0,
      },
    ]);
    const firstReview = first.review.bind(first);
    first.review = async (prompt: string) => {
      const result = await firstReview(prompt);
      now = 80;
      return result;
    };
    const second = new SequenceProvider('codex/second', [
      {
        content: '{"findings":[]}',
        findings: [],
        durationSeconds: 0,
      },
    ]);
    const deadline = new ExecutionDeadline(
      100,
      {
        completionReserveMs: 20,
        minimumBatchStartWindowMs: 10,
        minimumOptionalRetryStartWindowMs: 10,
      },
      { now: () => now }
    );
    const executor = new LLMExecutor(
      { ...DEFAULT_CONFIG, providerMaxParallel: 1 },
      { deadline }
    );

    const results = await executor.execute([first, second], 'prompt', 100);

    expect(first.prompts).toHaveLength(1);
    expect(second.prompts).toHaveLength(0);
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'codex/second', status: 'timeout' }),
      ])
    );
  });
});
