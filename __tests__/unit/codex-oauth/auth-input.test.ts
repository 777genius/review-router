import {
  CODEX_ROTATING_AUTH_INPUT_ENV_NAMES,
  applyCodexRotatingProviderSecretInputs,
  clearCodexRotatingOidcRequestEnv,
  clearCodexRotatingProcessAuthEnv,
  readCodexRotatingProviderSecretInputs,
  readCodexRotatingAuthInput,
} from '../../../src/codex-oauth/auth-input';

describe('Codex OAuth rotating auth input', () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('reads auth-json as exact env bytes, masks tokens, and deletes input env', () => {
    const authJsonBytes = JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        refresh_token: 'refresh-token-secret',
        access_token: 'access-token-secret',
      },
    });
    const env: NodeJS.ProcessEnv = {
      'INPUT_AUTH-JSON': authJsonBytes,
      INPUT_AUTH_JSON: 'stale-copy',
    };

    const result = readCodexRotatingAuthInput(env);

    expect(result.authJsonBytes).toBe(authJsonBytes);
    for (const name of CODEX_ROTATING_AUTH_INPUT_ENV_NAMES) {
      expect(env[name]).toBeUndefined();
    }
    expect(logSpy.mock.calls.map((call) => call[0]).join('\n')).toContain(
      'refresh-token-secret'
    );
    expect(logSpy.mock.calls.map((call) => call[0]).join('\n')).toContain(
      'access-token-secret'
    );
  });

  it('clears OIDC request env separately from auth input deletion', () => {
    const env: NodeJS.ProcessEnv = {
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token',
      ACTIONS_ID_TOKEN_REQUEST_URL:
        'https://token.actions.githubusercontent.com',
    };

    clearCodexRotatingOidcRequestEnv(env);

    expect(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined();
    expect(env.ACTIONS_ID_TOKEN_REQUEST_URL).toBeUndefined();
  });

  it('reads, masks, and deletes explicit hybrid provider secret inputs', () => {
    const env: NodeJS.ProcessEnv = {
      'INPUT_CLAUDE-CODE-OAUTH-TOKEN': 'sk-ant-oat01-oauth-secret',
      INPUT_OPENROUTER_API_KEY: 'sk-or-secret',
    };

    const result = readCodexRotatingProviderSecretInputs(env);

    expect(result).toEqual({
      claudeCodeOAuthToken: 'sk-ant-oat01-oauth-secret',
      openRouterApiKey: 'sk-or-secret',
    });
    expect(env['INPUT_CLAUDE-CODE-OAUTH-TOKEN']).toBeUndefined();
    expect(env.INPUT_OPENROUTER_API_KEY).toBeUndefined();
    expect(logSpy.mock.calls.map((call) => call[0]).join('\n')).toContain(
      'sk-ant-oat01-oauth-secret'
    );
    expect(logSpy.mock.calls.map((call) => call[0]).join('\n')).toContain(
      'sk-or-secret'
    );
  });

  it('injects only explicit provider secrets and prunes inherited auth env', () => {
    const env: NodeJS.ProcessEnv = {
      CLAUDE_CODE_OAUTH_TOKEN: 'inherited-claude',
      OPENROUTER_API_KEY: 'inherited-openrouter',
    };

    applyCodexRotatingProviderSecretInputs(
      { openRouterApiKey: 'explicit-openrouter' },
      env
    );

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).toBe('explicit-openrouter');
  });

  it('clears provider secrets with other rotating auth material', () => {
    const env: NodeJS.ProcessEnv = {
      CLAUDE_CODE_OAUTH_TOKEN: 'claude-token',
      OPENROUTER_API_KEY: 'openrouter-key',
      'INPUT_CLAUDE-CODE-OAUTH-TOKEN': 'claude-input',
      INPUT_OPENROUTER_API_KEY: 'openrouter-input',
      CODEX_HOME: '/tmp/codex-home',
    };

    clearCodexRotatingProcessAuthEnv(env);

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(env['INPUT_CLAUDE-CODE-OAUTH-TOKEN']).toBeUndefined();
    expect(env.INPUT_OPENROUTER_API_KEY).toBeUndefined();
    expect(env.CODEX_HOME).toBeUndefined();
  });
});
