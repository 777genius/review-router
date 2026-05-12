const BASE_CLI_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'CI',
];

export interface CliSafeEnvOptions {
  includeWorkspaceEnv?: boolean;
  extraAllowedKeys?: string[];
  overrides?: NodeJS.ProcessEnv;
}

export function buildCliSafeEnv(
  options: CliSafeEnvOptions = {}
): NodeJS.ProcessEnv {
  const allowed = new Set(BASE_CLI_ENV_KEYS);

  if (options.includeWorkspaceEnv !== false) {
    allowed.add('GITHUB_WORKSPACE');
  }

  for (const key of options.extraAllowedKeys ?? []) {
    allowed.add(key);
  }

  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }

  for (const [key, value] of Object.entries(options.overrides ?? {})) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  return env;
}
