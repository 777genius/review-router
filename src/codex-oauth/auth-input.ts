import * as core from '../actions/core';

export const CODEX_ROTATING_AUTH_INPUT_ENV_NAMES = [
  'INPUT_AUTH-JSON',
  'INPUT_AUTH_JSON',
] as const;

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
