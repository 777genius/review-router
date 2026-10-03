import { resolveProviderCliPlan } from '../../../src/control-plane/provider-cli-plan';

describe('resolveProviderCliPlan', () => {
  it('requires Codex CLI for Codex OAuth runtime config', () => {
    const plan = resolveProviderCliPlan({
      REVIEW_AUTH_MODE: 'codex-oauth',
    });

    expect(plan.codexCliNeeded).toBe(true);
    expect(plan.codexOauthNeeded).toBe(true);
  });

  it('requires Codex CLI for OpenAI API-key runtime config', () => {
    const plan = resolveProviderCliPlan({
      REVIEW_AUTH_MODE: 'openai-api',
    });

    expect(plan.codexCliNeeded).toBe(true);
    expect(plan.codexOauthNeeded).toBe(false);
  });

  it('requires Claude CLI for Claude OAuth runtime config', () => {
    const plan = resolveProviderCliPlan({
      REVIEW_AUTH_MODE: 'claude-oauth',
    });

    expect(plan.claudeCliNeeded).toBe(true);
    expect(plan.codexCliNeeded).toBe(false);
    expect(plan.codexOauthNeeded).toBe(false);
  });

  it('requires Codex CLI for MiMo auth without explicit provider hints', () => {
    const plan = resolveProviderCliPlan({
      REVIEW_AUTH_MODE: 'mimo-token-plan-api',
      CLAUDE_MODEL: 'sonnet',
    });

    expect(plan.codexCliNeeded).toBe(true);
    expect(plan.codexOauthNeeded).toBe(false);
    expect(plan.claudeCliNeeded).toBe(false);
  });

  it.each([
    ['explicit review providers', 'REVIEW_PROVIDERS'],
    ['fallback providers', 'FALLBACK_PROVIDERS'],
    ['synthesis model', 'SYNTHESIS_MODEL'],
  ] as const)(
    'requires Codex CLI for MiMo selected through %s',
    (_description, variable) => {
      const plan = resolveProviderCliPlan({
        [variable]: 'codex-mimo/mimo-v2.6-pro',
      });

      expect(plan.codexCliNeeded).toBe(true);
      expect(plan.codexOauthNeeded).toBe(false);
      expect(plan.claudeCliNeeded).toBe(false);
    }
  );

  it('does not require Codex CLI for Claude-only selection with a MiMo secret', () => {
    const plan = resolveProviderCliPlan({
      REVIEW_AUTH_MODE: 'claude-oauth',
      REVIEW_PROVIDERS: 'claude/sonnet',
      MIMO_TOKEN_PLAN_API_KEY: 'test-only-placeholder',
      MIMO_TOKEN_PLAN_API_KEY_PRESENT: '1',
    });

    expect(plan.codexCliNeeded).toBe(false);
    expect(plan.codexOauthNeeded).toBe(false);
    expect(plan.claudeCliNeeded).toBe(true);
  });

  it('detects explicit provider lists and synthesis models', () => {
    const plan = resolveProviderCliPlan({
      REVIEW_PROVIDERS: 'openrouter/free, claude/sonnet',
      SYNTHESIS_MODEL: 'codex/gpt-5.5',
    });

    expect(plan.codexCliNeeded).toBe(true);
    expect(plan.codexOauthNeeded).toBe(false);
    expect(plan.claudeCliNeeded).toBe(true);
  });

  it('does not let stale static model env override explicit runtime providers', () => {
    const plan = resolveProviderCliPlan({
      REVIEW_AUTH_MODE: 'codex-oauth',
      REVIEW_PROVIDERS: 'codex/gpt-5.5',
      SYNTHESIS_MODEL: 'codex/gpt-5.5',
      CLAUDE_MODEL: 'sonnet',
    });

    expect(plan.codexCliNeeded).toBe(true);
    expect(plan.codexOauthNeeded).toBe(true);
    expect(plan.claudeCliNeeded).toBe(false);
  });

  it('requires Codex CLI but not Codex OAuth for OpenRouter config', () => {
    const plan = resolveProviderCliPlan({
      REVIEW_AUTH_MODE: 'openrouter-api',
      REVIEW_PROVIDERS: 'openrouter/anthropic/claude-sonnet-4.5',
      SYNTHESIS_MODEL: 'openrouter/anthropic/claude-sonnet-4.5',
    });

    expect(plan.codexCliNeeded).toBe(true);
    expect(plan.codexOauthNeeded).toBe(false);
    expect(plan.claudeCliNeeded).toBe(false);
  });
});
