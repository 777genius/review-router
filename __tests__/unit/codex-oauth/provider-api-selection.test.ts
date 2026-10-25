import * as core from '../../../src/actions/core';
import {
  providerApiAuthModes,
  providerApiDescriptors,
  type ProviderApiAuthMode,
} from '../../../src/control-plane/generated/review-action-v2/companion-contracts';
import {
  providerApiSecretInputNames,
  readDirectProviderSelection,
  readProviderApiSecret,
} from '../../../src/codex-oauth/provider-api-selection';

function environment(mode: ProviderApiAuthMode): Record<string, string> {
  const descriptor = providerApiDescriptors[mode];
  const provider = `${descriptor.runtimePrefix}/${mode === 'openrouter-api' ? 'vendor/model' : descriptor.defaultModel}`;
  return {
    REVIEW_AUTH_MODE: mode,
    REVIEW_PROVIDERS: provider,
    REQUIRED_HEALTHY_PROVIDERS: provider,
    SYNTHESIS_MODEL: provider,
    PROVIDER_LIMIT: '1',
    PROVIDER_MAX_PARALLEL: '1',
    INLINE_MIN_AGREEMENT: '1',
  };
}

describe('captured direct provider selection and key custody', () => {
  beforeEach(() =>
    jest.spyOn(core, 'setSecret').mockImplementation(() => undefined)
  );
  afterEach(() => jest.restoreAllMocks());

  it.each(providerApiAuthModes)(
    'selects %s without reading a credential into runtime configuration',
    (mode) => {
      const selected = readDirectProviderSelection(environment(mode));
      expect(selected.mode).toBe(mode);
      expect(selected.providerName).toBe(environment(mode).REVIEW_PROVIDERS);
      expect(selected.model).toBe(
        mode === 'openrouter-api'
          ? 'vendor/model'
          : providerApiDescriptors[mode].defaultModel
      );
      expect(core.setSecret).not.toHaveBeenCalled();
    }
  );

  it.each(providerApiAuthModes)(
    'reads only the %s Action input then clears every input and raw key',
    (mode) => {
      const env: NodeJS.ProcessEnv = {};
      const names = providerApiSecretInputNames(mode);
      for (const name of names) env[name] = 'synthetic-selected-key';
      for (const descriptor of Object.values(providerApiDescriptors))
        env[descriptor.secretName] = 'untrusted-ambient-key';
      expect(readProviderApiSecret(mode, env)).toBe('synthetic-selected-key');
      expect(core.setSecret).toHaveBeenCalledWith('synthetic-selected-key');
      expect(env).toEqual({});
    }
  );

  it.each(providerApiAuthModes)(
    'refuses another provider credential alongside %s and scrubs both',
    (mode) => {
      const env: NodeJS.ProcessEnv = {};
      for (const candidate of providerApiAuthModes) {
        const name = providerApiSecretInputNames(candidate)[0];
        if (name) env[name] = `synthetic-${candidate}`;
      }
      expect(() => readProviderApiSecret(mode, env)).toThrow(
        'provider_api_alternate_auth_input'
      );
      expect(env).toEqual({});
    }
  );

  it('does not infer the provider from a present key or accept conflicting input aliases', () => {
    expect(() =>
      readProviderApiSecret('kimi-code-api', {
        INPUT_OPENROUTER_API_KEY: 'synthetic-or',
      })
    ).toThrow('provider_api_alternate_auth_input');
    expect(() => readProviderApiSecret('kimi-code-api', {})).toThrow(
      'provider_api_credential_missing'
    );
    const aliases = {
      INPUT_KIMI_CODE_API_KEY: 'synthetic-a',
      'INPUT_KIMI-CODE-API-KEY': 'synthetic-b',
    };
    expect(() => readProviderApiSecret('kimi-code-api', aliases)).toThrow(
      'provider_api_alternate_auth_input'
    );
    expect(aliases).toEqual({});
  });

  it('rejects unsupported models, provider/mode mismatch and Kimi reasoning or fast settings', () => {
    const kimi = environment('kimi-code-api');
    const overrides: Record<string, string>[] = [
      { REVIEW_AUTH_MODE: 'openrouter-api' },
      { REVIEW_PROVIDERS: 'kimi/other-model' },
      { CODEX_REASONING_EFFORT: 'high' },
      { CODEX_FAST_MODE: 'true' },
      { INLINE_MIN_AGREEMENT: '2' },
      { FALLBACK_PROVIDERS: 'openrouter/vendor/fallback' },
    ];
    for (const override of overrides)
      expect(() =>
        readDirectProviderSelection({ ...kimi, ...override })
      ).toThrow();
  });

  it('rejects unsupported direct MiMo fast mode while retaining ordinary MiMo and OpenRouter policy', () => {
    expect(() =>
      readDirectProviderSelection({
        ...environment('mimo-token-plan-api'),
        CODEX_FAST_MODE: 'true',
      })
    ).toThrow('provider_api_mimo_fast_unsupported');
    expect(
      readDirectProviderSelection({
        ...environment('mimo-token-plan-api'),
        CODEX_FAST_MODE: 'false',
      }).mode
    ).toBe('mimo-token-plan-api');
    expect(
      readDirectProviderSelection({
        ...environment('openrouter-api'),
        CODEX_FAST_MODE: 'true',
      }).mode
    ).toBe('openrouter-api');
  });
});
