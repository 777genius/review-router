import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export type CodexRefreshBootstrapResult = {
  authJsonBytes: string;
  codexHome: string;
  clearAuthMaterial(): Promise<void>;
};

type BootstrapLogger = {
  info(message: string): void;
  warn(message: string): void;
};

export async function refreshCodexAuthWithOfficialCli(input: {
  authJsonBytes: string;
  codexBinaryPath?: string;
  model?: string;
  timeoutMs?: number;
  logger?: BootstrapLogger;
}): Promise<CodexRefreshBootstrapResult> {
  const parent = await ensureCodexOAuthRuntimeParent();
  const root = await fs.mkdtemp(path.join(parent, 'reviewrouter-codex-oauth-'));
  const home = path.join(root, 'home');
  const codexHome = path.join(root, 'codex');
  const emptyCwd = path.join(root, 'empty');
  const authPath = path.join(codexHome, 'auth.json');
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  await fs.mkdir(codexHome, { recursive: true, mode: 0o700 });
  await fs.mkdir(emptyCwd, { recursive: true, mode: 0o700 });
  await fs.writeFile(authPath, input.authJsonBytes, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await fs.writeFile(
    path.join(codexHome, 'config.toml'),
    'cli_auth_credentials_store = "file"\napproval_policy = "never"\n',
    { encoding: 'utf8', mode: 0o600 }
  );

  const binary =
    input.codexBinaryPath || process.env.REVIEWROUTER_CODEX_BINARY || 'codex';
  input.logger?.info('Refreshing Codex auth through the official Codex CLI.');
  await runCodexBootstrapCommand({
    binary,
    timeoutMs: input.timeoutMs ?? 120_000,
    home,
    codexHome,
    cwd: emptyCwd,
  });

  const refreshedAuth = await fs.readFile(authPath, 'utf8');
  return {
    authJsonBytes: refreshedAuth,
    codexHome,
    async clearAuthMaterial() {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

export async function ensureCodexOAuthRuntimeParent(
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const home = env.HOME?.trim() || os.homedir();
  const parent =
    home && path.isAbsolute(home)
      ? path.join(home, '.reviewrouter', 'runtime')
      : path.join(os.tmpdir(), 'reviewrouter-runtime');
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  await fs.chmod(parent, 0o700).catch(() => undefined);
  return parent;
}

async function runCodexBootstrapCommand(input: {
  binary: string;
  timeoutMs: number;
  home: string;
  codexHome: string;
  cwd: string;
}): Promise<void> {
  const args = ['login', 'status'];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(input.binary, args, {
      cwd: input.cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH || '',
        HOME: input.home,
        CODEX_HOME: input.codexHome,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) {
          process.kill(-child.pid, 'SIGKILL');
        }
      } catch {
        child.kill('SIGKILL');
      }
      reject(new Error('codex_oauth_refresh_timeout'));
    }, input.timeoutMs);

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      if (!timedOut) {
        clearTimeout(timer);
        reject(
          new Error(`codex_oauth_refresh_spawn_failed:${safeError(error)}`)
        );
      }
    });
    child.on('close', (code) => {
      if (timedOut) return;
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `codex_oauth_refresh_failed:${code ?? 'signal'}:${safeOutput(stderr || stdout)}`
        )
      );
    });
  });
}

function safeError(error: unknown): string {
  return error instanceof Error ? safeOutput(error.message) : 'unknown_error';
}

function safeOutput(value: string): string {
  return value
    .replace(/ghs_[A-Za-z0-9_]+/g, '[redacted-github-token]')
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, '[redacted-github-token]')
    .replace(/github_pat_[A-Za-z0-9_]+/g, '[redacted-github-token]')
    .replace(
      /refresh[_-]?token["':= ]+[A-Za-z0-9._-]+/gi,
      'refresh_token=[redacted]'
    )
    .slice(0, 300);
}
