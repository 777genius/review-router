import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createGitImmutableSourceReader } from '../../../src/finding-revalidation';

// Detects accidental worktree reads, unsafe special Git objects and truncation of oversized blobs.
it('reads literal UTF-8 bytes from the captured Git commit and rejects unsafe object kinds', async () => {
  const scratch = join(process.cwd(), 'tmp');
  mkdirSync(scratch, { recursive: true });
  const repositoryRoot = mkdtempSync(
    join(scratch, 'finding-revalidation-git-')
  );
  const git = (args: readonly string[]) =>
    execFileSync('git', ['-C', repositoryRoot, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'iliya',
        GIT_AUTHOR_EMAIL: 'iliyazelenkog@gmail.com',
        GIT_COMMITTER_NAME: 'iliya',
        GIT_COMMITTER_EMAIL: 'iliyazelenkog@gmail.com',
      },
    }).trim();
  try {
    git(['init', '--quiet']);
    git(['config', 'core.autocrlf', 'false']);
    git(['config', 'core.safecrlf', 'false']);
    writeFileSync(
      join(repositoryRoot, 'literal[1].ts'),
      '\uFEFFconst fixed = true;\r\n'
    );
    writeFileSync(join(repositoryRoot, 'large.ts'), 'x'.repeat(24 * 1024 + 1));
    writeFileSync(join(repositoryRoot, 'binary.ts'), Buffer.from([0, 1, 2]));
    writeFileSync(join(repositoryRoot, 'invalid.ts'), Buffer.from([0xff]));
    symlinkSync('literal[1].ts', join(repositoryRoot, 'link.ts'));
    git(['add', '.']);
    git(['commit', '--quiet', '-m', 'test: immutable source fixture']);
    const headSha = git(['rev-parse', 'HEAD']);
    writeFileSync(join(repositoryRoot, 'literal[1].ts'), 'mutable replacement');
    const reader = createGitImmutableSourceReader({ repositoryRoot });
    const read = await reader.read({
      headSha,
      path: 'literal[1].ts',
      maxBytes: 24 * 1024,
    });
    expect(read.kind).toBe('file');
    if (read.kind === 'file')
      expect(Buffer.from(read.bytes).toString('utf8')).toBe(
        '\uFEFFconst fixed = true;\r\n'
      );
    expect(
      await reader.read({ headSha, path: 'large.ts', maxBytes: 24 * 1024 })
    ).toEqual({ kind: 'oversized' });
    for (const path of ['binary.ts', 'invalid.ts', 'link.ts', '../escape.ts'])
      expect(await reader.read({ headSha, path, maxBytes: 24 * 1024 })).toEqual(
        { kind: 'unsupported' }
      );
    expect(
      await reader.read({ headSha, path: 'absent.ts', maxBytes: 24 * 1024 })
    ).toEqual({ kind: 'missing' });
    expect(
      await reader.read({
        headSha: 'HEAD',
        path: 'literal[1].ts',
        maxBytes: 24 * 1024,
      })
    ).toEqual({ kind: 'unsupported' });
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});
