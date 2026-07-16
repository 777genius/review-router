import { setupComponents } from '../../src/setup';
import { DEFAULT_CONFIG } from '../../src/config/defaults';
import { Provider } from '../../src/providers/base';
import { ProviderRegistry } from '../../src/providers/registry';
import { ReviewResult } from '../../src/types';

class ConcurrencyCaptureProvider extends Provider {
  active = 0;
  maxActive = 0;

  async review(): Promise<ReviewResult> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    this.active -= 1;
    return {
      content: '{"findings":[]}',
      findings: [],
      durationSeconds: 0.01,
    };
  }
}

describe('large PR provider parallelism setup', () => {
  const originalParallelism = process.env.REVIEWROUTER_LARGE_PR_MAX_PARALLEL;
  const originalDeadline = process.env.REVIEWROUTER_EXECUTION_DEADLINE_EPOCH_MS;

  afterEach(() => {
    if (originalParallelism === undefined) {
      delete process.env.REVIEWROUTER_LARGE_PR_MAX_PARALLEL;
    } else {
      process.env.REVIEWROUTER_LARGE_PR_MAX_PARALLEL = originalParallelism;
    }
    if (originalDeadline === undefined) {
      delete process.env.REVIEWROUTER_EXECUTION_DEADLINE_EPOCH_MS;
    } else {
      process.env.REVIEWROUTER_EXECUTION_DEADLINE_EPOCH_MS = originalDeadline;
    }
    jest.restoreAllMocks();
  });

  async function captureParallelism(): Promise<number> {
    const components = await setupComponents({
      cliMode: true,
      config: {
        ...DEFAULT_CONFIG,
        providerMaxParallel: 1,
        analyticsEnabled: false,
      },
    });
    const provider = new ConcurrencyCaptureProvider('codex/test');

    await Promise.all([
      components.llmExecutor.execute([provider], 'one'),
      components.llmExecutor.execute([provider], 'two'),
      components.llmExecutor.execute([provider], 'three'),
    ]);

    return provider.maxActive;
  }

  it('preserves configured providerMaxParallel when the override is absent', async () => {
    delete process.env.REVIEWROUTER_LARGE_PR_MAX_PARALLEL;

    await expect(captureParallelism()).resolves.toBe(1);
  });

  it('applies an explicit override within the supported bound', async () => {
    process.env.REVIEWROUTER_LARGE_PR_MAX_PARALLEL = '2';

    await expect(captureParallelism()).resolves.toBe(2);
  });

  it('rejects an explicit override outside the supported bound', async () => {
    process.env.REVIEWROUTER_LARGE_PR_MAX_PARALLEL = '4';

    await expect(
      setupComponents({
        cliMode: true,
        config: { ...DEFAULT_CONFIG, analyticsEnabled: false },
      })
    ).rejects.toThrow(
      'REVIEWROUTER_LARGE_PR_MAX_PARALLEL must be an integer from 1 to 3'
    );
  });

  it('stops additional provider discovery waves near the deadline', async () => {
    delete process.env.REVIEWROUTER_LARGE_PR_MAX_PARALLEL;
    process.env.REVIEWROUTER_EXECUTION_DEADLINE_EPOCH_MS = String(
      Date.now() + 1_000
    );
    const discover = jest
      .spyOn(ProviderRegistry.prototype, 'discoverAdditionalFreeProviders')
      .mockResolvedValue([]);
    const components = await setupComponents({
      cliMode: true,
      config: { ...DEFAULT_CONFIG, analyticsEnabled: false },
    });

    await expect(
      components.providerRegistry.discoverAdditionalFreeProviders([])
    ).resolves.toEqual([]);
    expect(discover).not.toHaveBeenCalled();
  });
});
