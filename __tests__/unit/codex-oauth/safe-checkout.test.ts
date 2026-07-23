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
