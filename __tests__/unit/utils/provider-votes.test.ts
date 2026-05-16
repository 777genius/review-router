import {
  countProviderVotePool,
  getProviderVoteKeys,
  normalizeProviderVoteKey,
} from '../../../src/utils/provider-votes';

describe('provider vote keys', () => {
  it('normalizes OpenRouter instance suffixes into one vote', () => {
    expect(
      normalizeProviderVoteKey('openrouter/openai/gpt-oss-120b:free#5')
    ).toBe('openrouter/openai/gpt-oss-120b:free');
  });

  it('uses actual routed OpenRouter model when available', () => {
    expect(
      normalizeProviderVoteKey('openrouter/free#2', 'openai/gpt-oss-120b:free')
    ).toBe('openrouter/openai/gpt-oss-120b:free');
  });

  it('counts cloned provider instances as one provider pool vote', () => {
    expect(
      countProviderVotePool([
        'openrouter/openai/gpt-oss-120b:free',
        'openrouter/openai/gpt-oss-120b:free#5',
        'codex/gpt-5.5',
      ])
    ).toBe(2);
  });

  it('derives vote keys from provider model attribution', () => {
    expect(
      getProviderVoteKeys({
        file: 'test.ts',
        line: 1,
        severity: 'major',
        title: 'Issue',
        message: 'Message',
        providerModels: [
          {
            provider: 'openrouter/free#2',
            actualModel: 'openai/gpt-oss-120b:free',
          },
        ],
      })
    ).toEqual(['openrouter/openai/gpt-oss-120b:free']);
  });
});
