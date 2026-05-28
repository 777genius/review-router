import * as core from '../actions/core';

export const CODEX_ROTATING_AUTH_INPUT_ENV_NAMES = [
  'INPUT_AUTH-JSON',
  'INPUT_AUTH_JSON',
] as const;

const CODEX_ROTATING_PROVIDER_SECRET_INPUT_ENV_NAMES = {
  claudeCodeOAuthToken: [
    'INPUT_CLAUDE-CODE-OAUTH-TOKEN',
    'INPUT_CLAUDE_CODE_OAUTH_TOKEN',
  ],
  openRouterApiKey: ['INPUT_OPENROUTER-API-KEY', 'INPUT_OPENROUTER_API_KEY'],
} as const;

export type CodexRotatingProviderSecretInputs = {
  claudeCodeOAuthToken?: string;
  openRouterApiKey?: string;
};

export type CodexRotatingAuthInput = {
  authJsonBytes: string;
};

export function readCodexRotatingAuthInput(
  env: NodeJS.ProcessEnv = process.env
): CodexRotatingAuthInput {
  const authJsonBytes = CODEX_ROTATING_AUTH_INPUT_ENV_NAMES.map(
    (name) => env[name]
  ).find((value): value is string => value !== undefined);

  if (!authJsonBytes) {
    clearCodexRotatingAuthInput(env);
    throw new Error('codex_oauth_auth_json_input_missing');
  }

  maskCodexAuthJson(authJsonBytes);
  clearCodexRotatingAuthInput(env);
  return { authJsonBytes };
}

export function clearCodexRotatingAuthInput(
  env: NodeJS.ProcessEnv = process.env
): void {
  for (const name of CODEX_ROTATING_AUTH_INPUT_ENV_NAMES) {
    delete env[name];
  }
}

export function readCodexRotatingProviderSecretInputs(
  env: NodeJS.ProcessEnv = process.env
): CodexRotatingProviderSecretInputs {
  const claudeCodeOAuthToken = readOptionalSecretInput(
    CODEX_ROTATING_PROVIDER_SECRET_INPUT_ENV_NAMES.claudeCodeOAuthToken,
    env
  );
  const openRouterApiKey = readOptionalSecretInput(
    CODEX_ROTATING_PROVIDER_SECRET_INPUT_ENV_NAMES.openRouterApiKey,
    env
  );

  clearCodexRotatingProviderSecretInputs(env);
  return {
    ...(claudeCodeOAuthToken ? { claudeCodeOAuthToken } : {}),
    ...(openRouterApiKey ? { openRouterApiKey } : {}),
  };
}

export function applyCodexRotatingProviderSecretInputs(
  input: CodexRotatingProviderSecretInputs,
  env: NodeJS.ProcessEnv = process.env
): void {
  clearCodexRotatingProviderSecretEnv(env);
  if (input.claudeCodeOAuthToken) {
    env.CLAUDE_CODE_OAUTH_TOKEN = input.claudeCodeOAuthToken;
  }
  if (input.openRouterApiKey) {
    env.OPENROUTER_API_KEY = input.openRouterApiKey;
  }
}

export function clearCodexRotatingProviderSecretInputs(
  env: NodeJS.ProcessEnv = process.env
): void {
  for (const names of Object.values(
    CODEX_ROTATING_PROVIDER_SECRET_INPUT_ENV_NAMES
  )) {
    for (const name of names) {
      delete env[name];
    }
  }
}

export function clearCodexRotatingProviderSecretEnv(
  env: NodeJS.ProcessEnv = process.env
): void {
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.OPENROUTER_API_KEY;
}

export function clearCodexRotatingOidcRequestEnv(
  env: NodeJS.ProcessEnv = process.env
): void {
  delete env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  delete env.ACTIONS_ID_TOKEN_REQUEST_URL;
}

export function clearCodexRotatingProcessAuthEnv(
  env: NodeJS.ProcessEnv = process.env
): void {
  delete env.CODEX_AUTH_JSON;
  delete env.CODEX_CONFIG_TOML;
  delete env.OPENAI_API_KEY;
  delete env.CODEX_HOME;
  clearCodexRotatingAuthInput(env);
  clearCodexRotatingProviderSecretInputs(env);
  clearCodexRotatingProviderSecretEnv(env);
}

function maskCodexAuthJson(authJsonBytes: string): void {
  core.setSecret(authJsonBytes);
  try {
    const parsed = JSON.parse(authJsonBytes) as {
      tokens?: Record<string, unknown>;
    };
    for (const key of ['refresh_token', 'access_token', 'id_token']) {
      const value = parsed.tokens?.[key];
      if (typeof value === 'string' && value.length > 0) {
        core.setSecret(value);
      }
    }
  } catch {
    // The validator reports invalid JSON later. The raw bytes are already masked.
  }
}

function readOptionalSecretInput(
  envNames: readonly string[],
  env: NodeJS.ProcessEnv
): string | undefined {
  const value = envNames
    .map((name) => env[name]?.trim())
    .find((raw): raw is string => Boolean(raw));
  if (value) {
    core.setSecret(value);
  }
  return value;
}
