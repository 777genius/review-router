import { resolveProviderCliPlan } from '../../../src/control-plane/provider-cli-plan';

describe('resolveProviderCliPlan', () => {
  it('requires Codex CLI for Codex OAuth runtime config', () => {
    expect(
      resolveProviderCliPlan({
        REVIEW_AUTH_MODE: 'codex-oauth',
      }).codexCliNeeded
    ).toBe(true);
  });

  it('requires Codex CLI for OpenAI API-key runtime config', () => {
    expect(
      resolveProviderCliPlan({
        REVIEW_AUTH_MODE: 'openai-api',
      }).codexCliNeeded
    ).toBe(true);
  });

  it('requires Claude CLI for Claude OAuth runtime config', () => {
    const plan = resolveProviderCliPlan({
      REVIEW_AUTH_MODE: 'claude-oauth',
    });

    expect(plan.claudeCliNeeded).toBe(true);
    expect(plan.codexCliNeeded).toBe(false);
  });

  it('detects explicit provider lists and synthesis models', () => {
    const plan = resolveProviderCliPlan({
      REVIEW_PROVIDERS: 'openrouter/free, claude/sonnet',
      SYNTHESIS_MODEL: 'codex/gpt-5.5',
    });

    expect(plan.codexCliNeeded).toBe(true);
    expect(plan.claudeCliNeeded).toBe(true);
  });

  it('does not require CLI tooling for pure OpenRouter config', () => {
    const plan = resolveProviderCliPlan({
      REVIEW_AUTH_MODE: 'openrouter-api',
      REVIEW_PROVIDERS: 'openrouter/anthropic/claude-sonnet-4.5',
      SYNTHESIS_MODEL: 'openrouter/anthropic/claude-sonnet-4.5',
    });

    expect(plan.codexCliNeeded).toBe(false);
    expect(plan.claudeCliNeeded).toBe(false);
  });
});
