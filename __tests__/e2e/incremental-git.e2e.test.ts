import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  IncrementalReviewer,
  IncrementalStoragePort,
} from '../../src/cache/incremental';
import { PRContext } from '../../src/types';

describe('incremental review git integration', () => {
  it('invalidates a reverted path across force-pushed heads', async () => {
    const repositoryPath = mkdtempSync(join(tmpdir(), 'reviewrouter-git-e2e-'));
    try {
      runGit(repositoryPath, 'init', '--initial-branch=main');
      runGit(repositoryPath, 'config', 'user.email', 'test@reviewrouter.local');
      runGit(repositoryPath, 'config', 'user.name', 'ReviewRouter Test');
      mkdirSync(join(repositoryPath, 'src'));
      writeFileSync(
        join(repositoryPath, 'src/reverted.ts'),
        'export const n = 1;\n'
      );
      runGit(repositoryPath, 'add', '.');
      runGit(repositoryPath, 'commit', '-m', 'base');
      const baseSha = runGit(repositoryPath, 'rev-parse', 'HEAD');

      writeFileSync(
        join(repositoryPath, 'src/reverted.ts'),
        'export const n = 2;\n'
      );
      runGit(repositoryPath, 'commit', '-am', 'old reviewed head');
      const previousHeadSha = runGit(repositoryPath, 'rev-parse', 'HEAD');

      runGit(repositoryPath, 'reset', '--hard', baseSha);
      runGit(
        repositoryPath,
        'commit',
        '--allow-empty',
        '-m',
        'force-pushed head'
      );
      const currentHeadSha = runGit(repositoryPath, 'rev-parse', 'HEAD');

      const reviewer = new IncrementalReviewer(
        noOpStorage,
        { enabled: true, cacheTtlDays: 7 },
        repositoryPath
      );
      const changeSet = await reviewer.getIncrementalChangeSet(
        createPullRequest(baseSha, currentHeadSha),
        previousHeadSha
      );

      expect(changeSet).toEqual({
        files: [],
        invalidatedPaths: ['src/reverted.ts'],
        canReusePreviousFindings: true,
      });
    } finally {
      rmSync(repositoryPath, { recursive: true, force: true });
    }
  });
});

const noOpStorage: IncrementalStoragePort = {
  async read() {
    return null;
  },
  async write() {},
};

function createPullRequest(baseSha: string, headSha: string): PRContext {
  return {
    number: 1,
    title: 'Force-push test',
    body: '',
    author: 'reviewrouter-test',
    draft: false,
    labels: [],
    files: [],
    diff: '',
    additions: 0,
    deletions: 0,
    baseSha,
    headSha,
  };
}

function runGit(repositoryPath: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: repositoryPath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
