import * as core from '../actions/core';

export type GitHubActionsOidcTokenProviderOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
};

export class GitHubActionsOidcTokenProvider {
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GitHubActionsOidcTokenProviderOptions = {}) {
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async requestToken(audience: string): Promise<string> {
    const requestToken = requireEnv(this.env, 'ACTIONS_ID_TOKEN_REQUEST_TOKEN');
    const requestUrl = parseTrustedOidcUrl(
      requireEnv(this.env, 'ACTIONS_ID_TOKEN_REQUEST_URL')
    );
    requestUrl.searchParams.set('audience', audience);
    core.setSecret(requestToken);

    const response = await this.fetchImpl(requestUrl.toString(), {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${requestToken}`,
      },
      redirect: 'error',
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        `codex_oauth_oidc_http_error:${response.status}:${safeOidcErrorCode(payload)}`
      );
    }

    const token =
      payload && typeof payload === 'object' && 'value' in payload
        ? (payload as { value?: unknown }).value
        : undefined;
    if (typeof token !== 'string' || token.length === 0) {
      throw new Error('codex_oauth_oidc_invalid_response');
    }
    core.setSecret(token);
    return token;
  }
}

function parseTrustedOidcUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('codex_oauth_oidc_url_untrusted');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('codex_oauth_oidc_url_untrusted');
  }
  return parsed;
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) {
    throw new Error(`codex_oauth_missing_${key}`);
  }
  return value;
}

function safeOidcErrorCode(payload: unknown): string {
  if (
    payload &&
    typeof payload === 'object' &&
    'message' in payload &&
    typeof (payload as { message?: unknown }).message === 'string'
  ) {
    return 'oidc_request_failed';
  }
  return 'unknown_oidc_error';
}
