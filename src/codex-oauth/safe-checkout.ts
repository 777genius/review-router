import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export async function createIsolatedCheckoutWorkspace(input: {
  runnerTempPath?: string;
  githubWorkspacePath?: string;
}): Promise<string> {
  const runnerTempPath = input.runnerTempPath || os.tmpdir();
  await fs.mkdir(runnerTempPath, { recursive: true, mode: 0o700 });
  const realRunnerTempPath = await fs.realpath(runnerTempPath);
  const workspacePath = await fs.mkdtemp(
    path.join(realRunnerTempPath, 'reviewrouter-pr-')
  );
  await fs.chmod(workspacePath, 0o700);

  try {
    if (input.githubWorkspacePath) {
      const githubWorkspacePath = await fs.realpath(input.githubWorkspacePath);
      if (pathsOverlap(workspacePath, githubWorkspacePath)) {
        throw new Error('codex_oauth_checkout_workspace_not_isolated');
      }
    }
    return workspacePath;
  } catch (error) {
    await fs.rm(workspacePath, { recursive: true, force: true });
    throw error;
  }
}

export async function safeCheckoutRepository(input: {
  repository: string;
  headSha: string;
  workspacePath: string;
  token: string;
}): Promise<void> {
  assertRepositoryFullName(input.repository);
  assertFullSha(input.headSha);
  await assertWorkspaceEmpty(input.workspacePath);

  const gitHome = await fs.mkdtemp(path.join(os.tmpdir(), 'reviewrouter-git-'));
  try {
    await runGit(['init', '.'], input.workspacePath, gitHome);
    await runGit(
      ['config', '--local', 'gc.auto', '0'],
      input.workspacePath,
      gitHome
    );
    await runGit(
      ['config', '--local', 'core.hooksPath', '/dev/null'],
      input.workspacePath,
      gitHome
    );
    await runGit(
      ['config', '--local', 'advice.detachedHead', 'false'],
      input.workspacePath,
      gitHome
    );
    await runGit(
      ['remote', 'add', 'origin', `https://github.com/${input.repository}.git`],
      input.workspacePath,
      gitHome
    );
    await runGit(
      [
        '-c',
        'protocol.file.allow=never',
        '-c',
        'protocol.ext.allow=never',
        '-c',
        `http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from(
          `x-access-token:${input.token}`
        ).toString('base64')}`,
        'fetch',
        '--no-tags',
        '--no-recurse-submodules',
        '--depth=1',
        'origin',
        input.headSha,
      ],
      input.workspacePath,
      gitHome
    );
    await runGit(
      [
        '-c',
        'protocol.file.allow=never',
        '-c',
        'protocol.ext.allow=never',
        'checkout',
        '--detach',
        input.headSha,
      ],
      input.workspacePath,
      gitHome
    );
  } finally {
    await fs.rm(gitHome, { recursive: true, force: true });
  }
}

async function assertWorkspaceEmpty(workspacePath: string): Promise<void> {
  await fs.mkdir(workspacePath, { recursive: true, mode: 0o700 });
  const entries = await fs.readdir(workspacePath);
  const unsafeEntries = entries.filter((entry) => entry !== '.git');
  if (unsafeEntries.length > 0) {
    throw new Error('codex_oauth_workspace_not_empty_before_checkout');
  }
}

function runGit(
  args: readonly string[],
  cwd: string,
  home: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH || '',
        HOME: home,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        GIT_LFS_SKIP_SMUDGE: '1',
      },
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      reject(
        new Error(
          `codex_oauth_safe_checkout_spawn_failed:${safeGitError(String(error))}`
        )
      );
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `codex_oauth_safe_checkout_failed:${code ?? 'signal'}:${safeGitError(stderr)}`
        )
      );
    });
  });
}

function assertRepositoryFullName(value: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error('codex_oauth_invalid_repository');
  }
}

function assertFullSha(value: string): void {
  if (!/^[a-f0-9]{40}$/i.test(value)) {
    throw new Error('codex_oauth_invalid_head_sha');
  }
}

function pathsOverlap(left: string, right: string): boolean {
  return pathIsWithin(left, right) || pathIsWithin(right, left);
}

function pathIsWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

function safeGitError(value: string): string {
  return value
    .replace(/x-access-token:[^@\s]+@/g, 'x-access-token:[redacted]@')
    .replace(
      /AUTHORIZATION: basic [A-Za-z0-9+/=]+/gi,
      'AUTHORIZATION: basic [redacted]'
    )
    .slice(0, 300);
}
