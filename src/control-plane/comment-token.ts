import { RuntimeConfigResult } from './runtime-config';

type CommentTokenLogger = {
  info(message: string): void;
  warn(message: string): void;
};

type CommentTokenFetch = typeof fetch;

type CommentTokenResponse = {
  readonly protocolVersion: 1;
  readonly token: string;
  readonly expiresAt: string;
  readonly repository: string;
};

export type ResolveCommentTokenResult =
  | {
      readonly status: 'app';
      readonly token: string;
      readonly repository: string;
      readonly expiresAt: string;
    }
  | {
      readonly status: 'fallback';
      readonly token: string;
      readonly reason: string;
    };

export async function resolveGitHubCommentToken(input: {
  readonly fallbackToken: string;
  readonly runtimeConfig: RuntimeConfigResult | undefined;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: CommentTokenFetch;
  readonly logger?: CommentTokenLogger;
}): Promise<ResolveCommentTokenResult> {
  const env = input.env ?? process.env;
  if (env.REVIEWROUTER_COMMENT_TOKEN_MODE !== 'app-oidc') {
    return {
      status: 'fallback',
      token: input.fallbackToken,
      reason: 'comment_token_mode_disabled',
    };
  }

  if (!input.runtimeConfig || input.runtimeConfig.status !== 'applied') {
    return fallback(input, 'runtime_oidc_session_unavailable');
  }

  try {
    const result = await fetchCommentToken({
      apiUrl: input.runtimeConfig.apiUrl,
      sessionToken: input.runtimeConfig.sessionToken,
      fetchImpl: input.fetchImpl ?? fetch,
    });
    input.logger?.info(
      `ReviewRouter App comment identity enabled for ${result.repository}; token expires at ${result.expiresAt}.`
    );
    return {
      status: 'app',
      token: result.token,
      repository: result.repository,
      expiresAt: result.expiresAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown_error';
    return fallback(input, safeReason(message));
  }
}

async function fetchCommentToken(input: {
  readonly apiUrl: string;
  readonly sessionToken: string;
  readonly fetchImpl: CommentTokenFetch;
}): Promise<CommentTokenResponse> {
  const response = await input.fetchImpl(
    joinApiPath(input.apiUrl, '/api/action/v1/comment-token'),
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.sessionToken}`,
        'content-type': 'application/json',
      },
      body: '{}',
    }
  );
  if (!response.ok) {
    const code = await readSafeErrorCode(response);
    throw new Error(
      `comment_token_fetch_failed:${response.status}${code ? `:${code}` : ''}`
    );
  }

  return parseCommentTokenResponse(await response.json());
}

function parseCommentTokenResponse(value: unknown): CommentTokenResponse {
  if (!value || typeof value !== 'object') {
    throw new Error('comment_token_invalid_response');
  }
  const input = value as {
    protocolVersion?: unknown;
    token?: unknown;
    expiresAt?: unknown;
    repository?: unknown;
  };
  if (
    input.protocolVersion !== 1 ||
    typeof input.token !== 'string' ||
    input.token.length === 0 ||
    typeof input.expiresAt !== 'string' ||
    typeof input.repository !== 'string' ||
    input.repository.length === 0
  ) {
    throw new Error('comment_token_invalid_response');
  }

  return {
    protocolVersion: 1,
    token: input.token,
    expiresAt: input.expiresAt,
    repository: input.repository,
  };
}

function fallback(
  input: {
    readonly fallbackToken: string;
    readonly logger?: CommentTokenLogger;
  },
  reason: string
): ResolveCommentTokenResult {
  input.logger?.warn(
    `ReviewRouter App comment identity unavailable; falling back to github-actions[bot]. Reason: ${reason}`
  );
  return { status: 'fallback', token: input.fallbackToken, reason };
}

function joinApiPath(apiUrl: string, path: string): string {
  return `${apiUrl.replace(/\/+$/, '')}${path}`;
}

async function readSafeErrorCode(
  response: Response
): Promise<string | undefined> {
  try {
    const body = (await response.json()) as {
      error?: { code?: unknown } | string;
    };
    if (typeof body.error === 'string') {
      return safeReason(body.error);
    }
    if (typeof body.error?.code === 'string') {
      return safeReason(body.error.code);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function safeReason(message: string): string {
  return message
    .replace(/ghs_[A-Za-z0-9_]+/g, '[redacted-github-token]')
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, '[redacted-github-token]')
    .replace(/github_pat_[A-Za-z0-9_]+/g, '[redacted-github-token]')
    .slice(0, 120);
}
