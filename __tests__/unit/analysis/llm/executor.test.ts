import { LLMExecutor } from '../../../../src/analysis/llm/executor';
import { DEFAULT_CONFIG } from '../../../../src/config/defaults';
import { Provider } from '../../../../src/providers/base';
import { ReviewResult } from '../../../../src/types';

class DelayedProvider extends Provider {
  healthCompleted = false;
  reviewCompleted = false;

  constructor(name: string) {
    super(name);
  }

  async healthCheck(): Promise<boolean> {
    await new Promise(resolve => setTimeout(resolve, 10));
    this.healthCompleted = true;
    return true;
  }

  async review(): Promise<ReviewResult> {
    await new Promise(resolve => setTimeout(resolve, 10));
    this.reviewCompleted = true;
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
});
