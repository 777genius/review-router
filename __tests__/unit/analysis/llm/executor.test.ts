import { LLMExecutor } from '../../../../src/analysis/llm/executor';
import { DEFAULT_CONFIG } from '../../../../src/config/defaults';
import { Provider, RateLimitError } from '../../../../src/providers/base';
import { ReviewResult } from '../../../../src/types';

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

describe('LLMExecutor', () => {
  it('waits for queued health checks before returning', async () => {
    const provider = new DelayedProvider('codex/gpt-5.5');
    const executor = new LLMExecutor(DEFAULT_CONFIG);

    const result = await executor.filterHealthyProviders([provider], 1000);

    expect(provider.healthCompleted).toBe(true);
    expect(result.healthy).toEqual([provider]);
    expect(result.healthCheckResults).toHaveLength(1);
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
});
