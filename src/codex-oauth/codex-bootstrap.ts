import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { TextDecoder } from 'util';
import { CODEX_ROTATING_AUTH_JSON_MAX_BYTES } from './crypto';
import {
  validateCodexRefreshInput,
  validateCodexRefreshedAuth,
} from './codex-auth-refresh-validation';

export type CodexRefreshBootstrapResult = {
  authJsonBytes: string;
  codexHome: string;
  credentialValidUntil: number;
  accountId: string;
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
  signal?: AbortSignal;
  /** Original captured run deadline, in UTC milliseconds. */
  requiredValidUntil?: number;
  /** Explicit loopback fixture only; never inherited from the runner environment. */
  refreshTokenUrlForTest?: string;
}): Promise<CodexRefreshBootstrapResult> {
  input.signal?.throwIfAborted();
  validateCodexRefreshInput(input.authJsonBytes);
  const refreshTokenUrl =
    input.refreshTokenUrlForTest === undefined
      ? undefined
      : loopbackRefreshUrl(input.refreshTokenUrlForTest);
  const timeoutMs = input.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
    throw new Error('codex_oauth_refresh_timeout_invalid');
  const startedAt = Date.now();
  const parent = await ensureCodexOAuthRuntimeParent();
  const root = await fs.mkdtemp(path.join(parent, 'reviewrouter-codex-oauth-'));
  const home = path.join(root, 'home');
  const codexHome = path.join(root, 'codex');
  const emptyCwd = path.join(root, 'empty');
  const authPath = path.join(codexHome, 'auth.json');
  const clearAuthMaterial = () => fs.rm(root, { recursive: true, force: true });
  try {
    await fs.chmod(root, 0o700);
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
    input.signal?.throwIfAborted();
    input.logger?.info(
      'Refreshing Codex auth through the official auth-only app-server.'
    );
    await runCodexAuthRefreshProtocol({
      binary:
        input.codexBinaryPath ||
        process.env.REVIEWROUTER_CODEX_BINARY ||
        'codex',
      timeoutMs,
      home,
      codexHome,
      cwd: emptyCwd,
      signal: input.signal,
      ...(refreshTokenUrl ? { refreshTokenUrl } : {}),
    });
    input.signal?.throwIfAborted();
    const stat = await fs.stat(authPath);
    if (!stat.isFile() || stat.size > CODEX_ROTATING_AUTH_JSON_MAX_BYTES)
      throw new Error('codex_oauth_refresh_auth_invalid');
    const now = Date.now();
    const validated = validateCodexRefreshedAuth({
      originalAuthJson: input.authJsonBytes,
      refreshedAuthJson: await fs.readFile(authPath, 'utf8'),
      startedAt,
      now,
      requiredValidUntil: input.requiredValidUntil ?? now,
    });
    return { ...validated, codexHome, clearAuthMaterial };
  } catch (error) {
    await clearAuthMaterial();
    throw error;
  }
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

/** Exactly initialize + forced account read. No thread, turn, model, or token RPC. */
async function runCodexAuthRefreshProtocol(input: {
  binary: string;
  timeoutMs: number;
  home: string;
  codexHome: string;
  cwd: string;
  signal?: AbortSignal;
  refreshTokenUrl?: string;
}): Promise<void> {
  input.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(input.binary, ['app-server'], {
      cwd: input.cwd,
      detached: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH || '',
        HOME: input.home,
        CODEX_HOME: input.codexHome,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        ...(input.refreshTokenUrl
          ? { CODEX_REFRESH_TOKEN_URL_OVERRIDE: input.refreshTokenUrl }
          : {}),
      },
    });
    let phase: 'initialize' | 'account' | 'finished' = 'initialize';
    let failure: Error | undefined;
    let receivedAccount = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let pending = '';
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };
    const finish = (error?: Error) => {
      if (phase === 'finished') return;
      phase = 'finished';
      failure = error;
      child.stdin.end();
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 250);
    };
    const timer = setTimeout(
      () => finish(new Error('codex_oauth_refresh_timeout')),
      input.timeoutMs
    );
    const abort = () => finish(new Error('codex_oauth_refresh_cancelled'));
    input.signal?.addEventListener('abort', abort, { once: true });
    const send = (value: unknown) =>
      child.stdin.write(`${JSON.stringify(value)}\n`);
    child.stdin.on('error', () =>
      finish(new Error('codex_oauth_refresh_protocol_closed'))
    );
    child.stdout.on('data', (chunk: Buffer) => {
      if (phase === 'finished') return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > 1024 * 1024)
        return finish(new Error('codex_oauth_refresh_output_bound'));
      try {
        pending += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (!line.trim()) continue;
          const message: unknown = JSON.parse(line);
          if (!record(message)) throw new Error();
          if (!Object.hasOwn(message, 'id')) {
            if (typeof message.method !== 'string') throw new Error();
            continue;
          }
          if (
            Object.hasOwn(message, 'method') ||
            Object.hasOwn(message, 'error') ||
            !record(message.result)
          )
            throw new Error();
          if (phase === 'initialize' && message.id === 1) {
            phase = 'account';
            send({ method: 'initialized' });
            send({
              id: 2,
              method: 'account/read',
              params: { refreshToken: true },
            });
          } else if (
            phase === 'account' &&
            message.id === 2 &&
            record(message.result.account) &&
            message.result.account.type === 'chatgpt'
          ) {
            receivedAccount = true;
            finish();
            return;
          } else throw new Error();
        }
      } catch {
        finish(new Error('codex_oauth_refresh_protocol_invalid'));
      }
    });
    // Never retain or report app-server JSON/diagnostics: either can contain credentials.
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 64 * 1024)
        finish(new Error('codex_oauth_refresh_output_bound'));
    });
    child.on('error', () =>
      finish(new Error('codex_oauth_refresh_spawn_failed'))
    );
    child.on('close', () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      input.signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (!receivedAccount)
        reject(new Error('codex_oauth_refresh_protocol_closed'));
      else resolve();
    });
    if (input.signal?.aborted) abort();
    else
      send({
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: { name: 'reviewrouter_auth', version: '1.0.0' },
          capabilities: { experimentalApi: true },
        },
      });
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function loopbackRefreshUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  )
    throw new Error('codex_oauth_refresh_fixture_url_invalid');
  return url.href;
}
