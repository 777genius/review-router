import { ProviderRegistry } from '../../../src/providers/registry';
import { ClaudeCodeProvider } from '../../../src/providers/claude-code';
import { CodexProvider } from '../../../src/providers/codex';
import { GeminiProvider } from '../../../src/providers/gemini';
import { ReviewConfig } from '../../../src/types';
import { DEFAULT_CONFIG } from '../../../src/config/defaults';

describe('ProviderRegistry - New CLI Providers', () => {
  let registry: ProviderRegistry;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    registry = new ProviderRegistry();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('Provider Instantiation', () => {
    it('should instantiate Claude Code providers', async () => {
      const config: ReviewConfig = {
        ...DEFAULT_CONFIG,
        providers: ['claude/sonnet', 'claude/opus'],
      };

      // Use the private instantiate method via reflection
      const providers = (registry as any).instantiate(config.providers, config);

      expect(providers).toHaveLength(2);
      expect(providers[0]).toBeInstanceOf(ClaudeCodeProvider);
      expect(providers[0].name).toBe('claude/sonnet');
      expect(providers[1]).toBeInstanceOf(ClaudeCodeProvider);
      expect(providers[1].name).toBe('claude/opus');
    });

    it('should instantiate Codex providers', async () => {
      const config: ReviewConfig = {
        ...DEFAULT_CONFIG,
        providers: ['codex/gpt-5.5'],
      };

      const providers = (registry as any).instantiate(config.providers, config);

      expect(providers).toHaveLength(1);
      expect(providers[0]).toBeInstanceOf(CodexProvider);
      expect(providers[0].name).toBe('codex/gpt-5.5');
    });

    it('should instantiate OpenRouter-backed Codex providers', async () => {
      const config: ReviewConfig = {
        ...DEFAULT_CONFIG,
        providers: ['codex-openrouter/openai/gpt-5.3-codex'],
      };

      const providers = (registry as any).instantiate(config.providers, config);

      expect(providers).toHaveLength(1);
      expect(providers[0]).toBeInstanceOf(CodexProvider);
      expect(providers[0].name).toBe('codex-openrouter/openai/gpt-5.3-codex');
    });

    it('should instantiate OpenRouter providers through Codex agent runtime', async () => {
      process.env.OPENROUTER_API_KEY = 'or-key';
      const config: ReviewConfig = {
        ...DEFAULT_CONFIG,
        providers: ['openrouter/openai/gpt-oss-120b:free#8'],
      };

      const providers = (registry as any).instantiate(config.providers, config);

      expect(providers).toHaveLength(1);
      expect(providers[0]).toBeInstanceOf(CodexProvider);
      expect(providers[0].name).toBe('openrouter/openai/gpt-oss-120b:free#8');
    });

    it('should instantiate Gemini providers', async () => {
      const config: ReviewConfig = {
        ...DEFAULT_CONFIG,
        providers: ['gemini/gemini-2.0-flash', 'gemini/gemini-1.5-pro'],
      };

      const providers = (registry as any).instantiate(config.providers, config);

      expect(providers).toHaveLength(2);
      expect(providers[0]).toBeInstanceOf(GeminiProvider);
      expect(providers[0].name).toBe('gemini/gemini-2.0-flash');
      expect(providers[1]).toBeInstanceOf(GeminiProvider);
      expect(providers[1].name).toBe('gemini/gemini-1.5-pro');
    });

    it('should instantiate mixed provider types', async () => {
      const config: ReviewConfig = {
        ...DEFAULT_CONFIG,
        providers: [
          'claude/sonnet',
          'codex/gpt-5.5',
          'gemini/gemini-2.0-flash',
        ],
      };

      const providers = (registry as any).instantiate(config.providers, config);

      expect(providers).toHaveLength(3);
      expect(providers[0]).toBeInstanceOf(ClaudeCodeProvider);
      expect(providers[1]).toBeInstanceOf(CodexProvider);
      expect(providers[2]).toBeInstanceOf(GeminiProvider);
    });

    it('should skip invalid provider names', async () => {
      const config: ReviewConfig = {
        ...DEFAULT_CONFIG,
        providers: [
          'claude/sonnet',
          'invalid/provider',
          'gemini/gemini-2.0-flash',
        ],
      };

      const providers = (registry as any).instantiate(config.providers, config);

      // Only valid providers should be instantiated
      expect(providers).toHaveLength(2);
      expect(providers[0].name).toBe('claude/sonnet');
      expect(providers[1].name).toBe('gemini/gemini-2.0-flash');
    });
  });
});
