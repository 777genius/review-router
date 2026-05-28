import {
  CODEX_ROTATING_AUTH_INPUT_ENV_NAMES,
  clearCodexRotatingOidcRequestEnv,
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
});
