import { mergeGitDiffMetadata } from '../../../src/github/local-git-diff';

describe('local git PR diff metadata', () => {
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
});
