import { validateAccountGatewayCheckout } from '../../../src/codex-oauth/account-gateway-runtime';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createIsolatedCheckoutWorkspace } from '../../../src/codex-oauth/safe-checkout';

describe('Codex OAuth safe checkout workspace', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rr-safe-checkout-'));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('requires an immutable safe admitted config on gateway checkout', () => {
    const runtimeConfig = {
      protocolVersion: 1,
      configVersion: 7,
      runtimeEnv: {
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
