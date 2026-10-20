import { approvedAgentRuntimeEnv } from '../../helpers/approved-agent-fixture';
import { validateAccountGatewayCheckout } from '../../../src/codex-oauth/account-gateway-runtime';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import childProcess from 'child_process';
import { pathToFileURL } from 'url';
import {
  createIsolatedCheckoutWorkspace,
  safeCheckoutRepository,
} from '../../../src/codex-oauth/safe-checkout';

describe('Codex OAuth safe checkout workspace', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rr-safe-checkout-'));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it.each([true, false])(
    'checks out exact Git objects with OCR range=%s and no unrelated refs',
    async (range) => {
      const origin = path.join(tempRoot, 'origin');
      const workspace = path.join(tempRoot, 'checkout');
      await fs.mkdir(origin);
      const git = (cwd: string, ...args: string[]) =>
        childProcess
          .execFileSync(
            'git',
            [
              '-C',
              cwd,
              '-c',
              'user.name=iliya',
              '-c',
              'user.email=iliyazelenkog@gmail.com',
              ...args,
            ],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
          )
          .trim();
      git(origin, 'init');
      await fs.writeFile(path.join(origin, 'calc.ts'), 'export const x = 1;\n');
      git(origin, 'add', '.');
      git(origin, 'commit', '-m', 'base');
      const mergeBaseSha = git(origin, 'rev-parse', 'HEAD');
      for (const value of [2, 3]) {
        await fs.writeFile(
          path.join(origin, 'calc.ts'),
          `export const x = ${value};\n`
        );
        git(origin, 'commit', '-am', 'change');
      }
      const headSha = git(origin, 'rev-parse', 'HEAD');
      git(origin, 'checkout', '-b', 'unrelated', mergeBaseSha);
      await fs.writeFile(path.join(origin, 'unrelated.ts'), 'not assigned\n');
      git(origin, 'add', '.');
      git(origin, 'commit', '-m', 'unrelated');
      const unrelatedSha = git(origin, 'rev-parse', 'HEAD');
      git(origin, 'tag', 'unrelated-tag');
      const actualSpawn = childProcess.spawn;
      // Only replace transport to the local synthetic remote; production still
      // constructs its exact Git commands, strips ambient auth and selects refs.
      jest.spyOn(childProcess, 'spawn').mockImplementation(((
        command: string,
        args: readonly string[],
        options: childProcess.SpawnOptions
      ) =>
        actualSpawn(
          command,
          args.map((arg) =>
            arg === 'https://github.com/fixture/repository.git'
              ? pathToFileURL(origin).href
              : arg === 'protocol.file.allow=never'
                ? 'protocol.file.allow=always'
                : arg
          ),
          options
        )) as typeof childProcess.spawn);
      const input = {
        repository: 'fixture/repository',
        headSha,
        workspacePath: workspace,
        token: 'synthetic-token',
        signal: new AbortController().signal,
        ...(range ? { mergeBaseSha } : {}),
      };
      await safeCheckoutRepository(input);
      expect(git(workspace, 'rev-parse', 'HEAD')).toBe(headSha);
      expect(await fs.readFile(path.join(workspace, 'calc.ts'), 'utf8')).toBe(
        'export const x = 3;\n'
      );
      if (range) {
        expect(git(workspace, 'merge-base', mergeBaseSha, headSha)).toBe(
          mergeBaseSha
        );
        expect(git(workspace, 'rev-parse', '--is-shallow-repository')).toBe(
          'false'
        );
      } else {
        expect(git(workspace, 'rev-parse', '--is-shallow-repository')).toBe(
          'true'
        );
      }
      expect(() => git(workspace, 'cat-file', '-e', unrelatedSha)).toThrow();
      expect(git(workspace, 'tag', '--list')).toBe('');
      const config = await fs.readFile(
        path.join(workspace, '.git/config'),
        'utf8'
      );
      expect(config).not.toContain('synthetic-token');
      expect(config).not.toContain('extraheader');
    }
  );

  it.each(['--all', 'a'.repeat(39), `${'a'.repeat(40)}\n`])(
    'rejects an invalid OCR merge-base before spawning Git (%p)',
    async (mergeBaseSha) => {
      const spawn = jest.spyOn(childProcess, 'spawn');
      const input = {
        repository: 'fixture/repository',
        headSha: 'a'.repeat(40),
        mergeBaseSha,
        workspacePath: path.join(tempRoot, 'checkout'),
        token: 'synthetic-token',
      };
      await expect(safeCheckoutRepository(input)).rejects.toThrow(
        'codex_oauth_invalid_head_sha'
      );
      expect(spawn).not.toHaveBeenCalled();
    }
  );

  it('requires an immutable safe admitted config on gateway checkout', () => {
    const runtimeConfig = {
      protocolVersion: 1,
      configVersion: 7,
      runtimeEnv: {
        ...approvedAgentRuntimeEnv,
        CODEX_MODEL: 'mimo-v2.6-pro',
        CODEX_REASONING_EFFORT: 'high',
        TARGET_TOKENS_PER_BATCH: '12000',
      },
    };
    const capability = {
      protocolVersion: 1,
      repository: 'fixture/repository',
      headSha: 'a'.repeat(40),
      token: 'nonsecret-fixture-scm',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      permissions: { contents: 'read', pullRequests: 'read' },
      runtimeConfig,
    };
    const validate = (value: unknown) =>
      validateAccountGatewayCheckout(
        { httpStatus: 200, value },
        capability.repository,
        capability.headSha
      );
    const accepted = validate(capability);
    expect(accepted.runtimeConfig).toEqual(runtimeConfig);
    expect(Object.isFrozen(accepted.runtimeConfig)).toBe(true);
    expect(Object.isFrozen(accepted.runtimeConfig.runtimeEnv)).toBe(true);
    runtimeConfig.runtimeEnv.CODEX_MODEL = 'mutated-caller-model';
    expect(accepted.runtimeConfig.runtimeEnv.CODEX_MODEL).toBe('mimo-v2.6-pro');
    const missingConfig: Record<string, unknown> = { ...capability };
    delete missingConfig.runtimeConfig;
    expect(() => validate(missingConfig)).toThrow();
    for (const invalidConfig of [
      undefined,
      { ...runtimeConfig, configVersion: 0 },
      { ...runtimeConfig, configVersion: 1.5 },
      { ...runtimeConfig, configVersion: Number.NaN },
      { ...runtimeConfig, protocolVersion: 2 },
      { ...runtimeConfig, runtimeEnv: [] },
      { ...runtimeConfig, bindingId: 'unexpected-private-selector' },
      ...['SECRET', 'TOKEN', 'PASSWORD', 'AUTH_JSON', 'API_KEY'].map((key) => ({
        ...runtimeConfig,
        runtimeEnv: {
          CODEX_MODEL: 'mimo-v2.6-pro',
          [key]: 'nonsecret-fixture',
        },
      })),
      { ...runtimeConfig, runtimeEnv: { CODEX_MODEL: 123 } },
    ]) {
      expect(() =>
        validate({ ...capability, runtimeConfig: invalidConfig })
      ).toThrow();
    }
  });

  it('creates an empty private workspace outside GITHUB_WORKSPACE', async () => {
    const githubWorkspace = path.join(tempRoot, 'github-workspace');
    const runnerTemp = path.join(tempRoot, 'runner-temp');
    await fs.mkdir(githubWorkspace);

    const workspace = await createIsolatedCheckoutWorkspace({
      runnerTempPath: runnerTemp,
      githubWorkspacePath: githubWorkspace,
    });

    expect(path.dirname(workspace)).toBe(await fs.realpath(runnerTemp));
    expect(await fs.readdir(workspace)).toEqual([]);
    expect((await fs.stat(workspace)).mode & 0o777).toBe(0o700);
  });

  it('fails closed and removes a workspace nested in GITHUB_WORKSPACE', async () => {
    const githubWorkspace = path.join(tempRoot, 'github-workspace');
    await fs.mkdir(githubWorkspace);

    await expect(
      createIsolatedCheckoutWorkspace({
        runnerTempPath: githubWorkspace,
        githubWorkspacePath: githubWorkspace,
      })
    ).rejects.toThrow('codex_oauth_checkout_workspace_not_isolated');
    expect(await fs.readdir(githubWorkspace)).toEqual([]);
  });

  it('resolves runner temp symlinks before enforcing isolation', async () => {
    const githubWorkspace = path.join(tempRoot, 'github-workspace');
    const runnerTempLink = path.join(tempRoot, 'runner-temp-link');
    await fs.mkdir(githubWorkspace);
    await fs.symlink(githubWorkspace, runnerTempLink, 'dir');

    await expect(
      createIsolatedCheckoutWorkspace({
        runnerTempPath: runnerTempLink,
        githubWorkspacePath: githubWorkspace,
      })
    ).rejects.toThrow('codex_oauth_checkout_workspace_not_isolated');
    expect(await fs.readdir(githubWorkspace)).toEqual([]);
  });
});
