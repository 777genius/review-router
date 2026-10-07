import { ProviderRegistry } from '../../../src/providers/registry';
import { ReliabilityTracker } from '../../../src/providers/reliability-tracker';
import { ReviewConfig } from '../../../src/types';
import { DEFAULT_CONFIG } from '../../../src/config/defaults';

jest.mock('../../../src/providers/openrouter-models', () => ({
  PREFERRED_OPENROUTER_FREE_MODELS: [],
  getBestFreeModelsCached: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../../src/providers/opencode-models', () => ({
  getBestFreeOpenCodeModelsCached: jest.fn().mockResolvedValue([]),
}));

function createReliabilityTracker(
  scores: Record<string, number>
): ReliabilityTracker {
  return {
    getReliabilityScore: jest
      .fn()
      .mockImplementation(async (name: string) => scores[name] ?? 0.5),
    recordResult: jest.fn(),
    recordFalsePositive: jest.fn(),
    getStats: jest.fn(),
    getAllStats: jest.fn(),
    rankProviders: jest.fn(),
    getRecommendations: jest.fn(),
    clearHistory: jest.fn(),
    aggregateStats: jest.fn(),
    clear: jest.fn(),
    getSummary: jest.fn(),
    isCircuitOpen: jest.fn().mockResolvedValue(false),
  } as unknown as ReliabilityTracker;
}

describe('ProviderRegistry configured fallbacks', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('keeps a healthy MiMo primary ahead of a configured fallback', async () => {
    process.env.MIMO_TOKEN_PLAN_API_KEY = 'test-only-mimo-key';
    const config: ReviewConfig = {
      ...DEFAULT_CONFIG,
      providers: ['codex-mimo/mimo-v2.6-pro'],
      fallbackProviders: ['claude/high-reliability-fallback'],
      providerDiscoveryLimit: 2,
      providerLimit: 2,
    };
    const registry = new ProviderRegistry(
      undefined,
      createReliabilityTracker({
        'codex-mimo/mimo-v2.6-pro': 0.1,
        'claude/high-reliability-fallback': 0.99,
      })
    );

    const providers = await registry.createProviders(config);

    expect(providers.map((provider) => provider.name)).toEqual([
      'codex-mimo/mimo-v2.6-pro',
    ]);
  });

  it('exposes configured fallbacks during recovery after primary failure', async () => {
    process.env.MIMO_TOKEN_PLAN_API_KEY = 'test-only-mimo-key';
    delete process.env.OPENROUTER_API_KEY;
    const config: ReviewConfig = {
      ...DEFAULT_CONFIG,
      providers: ['codex-mimo/mimo-v2.6-pro'],
      fallbackProviders: ['claude/configured-recovery'],
    };
    const registry = new ProviderRegistry();

    const providers = await registry.discoverAdditionalFreeProviders(
      ['codex-mimo/mimo-v2.6-pro'],
      2,
      config
    );

    expect(providers.map((provider) => provider.name)).toEqual([
      'claude/configured-recovery',
    ]);
  });
});
