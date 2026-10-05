import {
  prepareRuntimePreflight,
  resolveProviderCliPlan,
  resolveRuntimePreflightPlan,
} from '../../../src/control-plane/provider-cli-plan';
import type { RuntimeConfigResult } from '../../../src/control-plane/runtime-config';

describe('resolveProviderCliPlan', () => {
  it('requires applied gateway config and prevents static or provider downgrade', () => {
    const env: NodeJS.ProcessEnv = {
      RR_CODEX_SESSION_MODE: 'account-gateway',
      REVIEWROUTER_RUNTIME_CONFIG_MODE: 'oidc',
      REVIEWROUTER_STATIC_CONFIG_FALLBACK: 'false',
      REVIEW_AUTH_MODE: 'codex-account-gateway',
      REVIEW_PROVIDERS: 'claude/sonnet',
    };
    const applied: RuntimeConfigResult = {
      status: 'applied',
      apiUrl: '',
      actionVersion: '',
      configVersion: 1,
      sessionToken: '',
    };
    prepareRuntimePreflight(env);
    expect(env.REVIEW_AUTH_MODE).toBeUndefined();
    for (const auth of ['', 'codex-oauth', 'openai-api', 'openrouter-api']) {
      env.REVIEW_AUTH_MODE = auth;
      expect(() => resolveRuntimePreflightPlan(applied, env)).toThrow(
        'account_gateway_requires_authenticated_applied_config'
      );
    }
    env.REVIEW_AUTH_MODE = 'codex-account-gateway';
    expect(resolveRuntimePreflightPlan(applied, env)).toEqual({
      accountGatewayNeeded: true,
      codexCliNeeded: true,
      codexOauthNeeded: false,
      claudeCliNeeded: false,
    });
    expect(() =>
      resolveRuntimePreflightPlan({ status: 'skipped' }, env)
    ).toThrow('account_gateway_requires_authenticated_applied_config');
    expect(() =>
      prepareRuntimePreflight({
        ...env,
        REVIEWROUTER_STATIC_CONFIG_FALLBACK: 'true',
      })
    ).toThrow('account_gateway_requires_oidc_without_static_fallback');
    expect(() =>
      resolveRuntimePreflightPlan(applied, {
        ...env,
        RR_CODEX_SESSION_MODE: '',
      })
    ).toThrow('account_gateway_workflow_mode_mismatch');
  });

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
