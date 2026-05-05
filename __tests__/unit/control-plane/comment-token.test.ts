import { resolveGitHubCommentToken } from '../../../src/control-plane/comment-token';

describe('resolveGitHubCommentToken', () => {
  const runtimeConfig = {
    status: 'applied' as const,
    apiUrl: 'https://api.reviewrouter.site',
    actionVersion: 'main',
    configVersion: 3,
    sessionToken: 'rr-session',
  };

  it('skips App token fetch when comment token mode is disabled', async () => {
    const fetchImpl = jest.fn();

    await expect(
      resolveGitHubCommentToken({
        fallbackToken: 'github-token',
        runtimeConfig,
        env: { REVIEWROUTER_COMMENT_TOKEN_MODE: 'github-token' },
        fetchImpl,
      })
    ).resolves.toEqual({
      status: 'fallback',
      token: 'github-token',
      reason: 'comment_token_mode_disabled',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fetches a short-lived App token using the action session', async () => {
    const fetchImpl = jest
      .fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>()
      .mockResolvedValueOnce(
        jsonResponse({
          protocolVersion: 1,
          token: 'ghs_reviewrouter_app_token',
          expiresAt: '2026-05-03T13:00:00.000Z',
          repository: '777genius/example',
        })
      );

    const result = await resolveGitHubCommentToken({
      fallbackToken: 'github-token',
      runtimeConfig,
      env: { REVIEWROUTER_COMMENT_TOKEN_MODE: 'app-oidc' },
      fetchImpl,
    });

    expect(result).toEqual({
      status: 'app',
      token: 'ghs_reviewrouter_app_token',
      expiresAt: '2026-05-03T13:00:00.000Z',
      repository: '777genius/example',
    });
    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      'https://api.reviewrouter.site/api/action/v1/comment-token'
    );
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer rr-session',
        'content-type': 'application/json',
      },
    });
  });

  it('falls back to github-actions when OIDC runtime config is unavailable', async () => {
    const warnings: string[] = [];

    await expect(
      resolveGitHubCommentToken({
        fallbackToken: 'github-token',
        runtimeConfig: { status: 'fallback', reason: 'network_down' },
        env: { REVIEWROUTER_COMMENT_TOKEN_MODE: 'app-oidc' },
        logger: { info: jest.fn(), warn: (message) => warnings.push(message) },
      })
    ).resolves.toEqual({
      status: 'fallback',
      token: 'github-token',
      reason: 'runtime_oidc_session_unavailable',
    });
    expect(warnings[0]).toContain('github-actions[bot]');
  });

  it('redacts token-shaped values from fallback warnings', async () => {
    const warnings: string[] = [];
    const fetchImpl = jest
      .fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>()
      .mockRejectedValueOnce(new Error('failed ghs_secret_token_value'));

    await resolveGitHubCommentToken({
      fallbackToken: 'github-token',
      runtimeConfig,
      env: { REVIEWROUTER_COMMENT_TOKEN_MODE: 'app-oidc' },
      fetchImpl,
      logger: { info: jest.fn(), warn: (message) => warnings.push(message) },
    });

    expect(warnings[0]).not.toContain('ghs_secret_token_value');
    expect(warnings[0]).toContain('[redacted-github-token]');
  });

  it('includes safe server error codes in fallback warnings', async () => {
    const warnings: string[] = [];
    const fetchImpl = jest
      .fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: 'comment_token_unavailable',
              message: 'safe message',
            },
          },
          503
        )
      );

    await resolveGitHubCommentToken({
      fallbackToken: 'github-token',
      runtimeConfig,
      env: { REVIEWROUTER_COMMENT_TOKEN_MODE: 'app-oidc' },
      fetchImpl,
      logger: { info: jest.fn(), warn: (message) => warnings.push(message) },
    });

    expect(warnings[0]).toContain(
      'comment_token_fetch_failed:503:comment_token_unavailable'
    );
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}
