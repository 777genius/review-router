import { execFile } from 'child_process';
import {
  loadPullRequestFilesFromGit,
  mergeGitDiffMetadata,
} from '../../../src/github/local-git-diff';

jest.mock('child_process', () => ({
  execFile: jest.fn(),
}));

describe('local git PR diff metadata', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  it('maps modifications, additions, deletions, renames, and binary files', () => {
    const files = mergeGitDiffMetadata(
      [
        'M',
        'src/modified.ts',
        'A',
        'src/added.ts',
        'D',
        'src/deleted.ts',
        'R095',
        'src/old.ts',
        'src/new.ts',
        'M',
        'assets/image.png',
        '',
      ].join('\0'),
      [
        '5\t2\tsrc/modified.ts',
        '8\t0\tsrc/added.ts',
        '0\t3\tsrc/deleted.ts',
        '1\t1\t',
        'src/old.ts',
        'src/new.ts',
        '-\t-\tassets/image.png',
        '',
      ].join('\0')
    );

    expect(files).toEqual([
      {
        filename: 'src/modified.ts',
        status: 'modified',
        additions: 5,
        deletions: 2,
        changes: 7,
      },
      {
        filename: 'src/added.ts',
        status: 'added',
        additions: 8,
        deletions: 0,
        changes: 8,
      },
      {
        filename: 'src/deleted.ts',
        status: 'removed',
        additions: 0,
        deletions: 3,
        changes: 3,
      },
      {
        filename: 'src/new.ts',
        status: 'renamed',
        additions: 1,
        deletions: 1,
        changes: 2,
        previousFilename: 'src/old.ts',
      },
      {
        filename: 'assets/image.png',
        status: 'modified',
        additions: 0,
        deletions: 0,
        changes: 0,
      },
    ]);
  });

  it('bounds every local git diff command with a timeout', async () => {
    (execFile as unknown as jest.Mock).mockImplementation(
      (_command, args, _options, callback) => {
        callback(
          null,
          args.includes('--name-status') ? 'M\0src/a.ts\0' : '1\t0\tsrc/a.ts\0'
        );
      }
    );

    await expect(
      loadPullRequestFilesFromGit('a'.repeat(40), 'b'.repeat(40))
    ).resolves.toHaveLength(1);

    expect(execFile).toHaveBeenCalledTimes(2);
    for (const call of (execFile as unknown as jest.Mock).mock.calls) {
      expect(call[2]).toMatchObject({ timeout: 30_000 });
    }
  });
});
