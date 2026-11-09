import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { LocalGitSnapshotReader } from '../../../src/local-review/git-snapshot';

function git(cwd: string, ...args: string[]): string { return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(); }

describe('local Git scope snapshots (real git)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'reviewrouter-git-'));
    git(dir, 'init', '-q'); git(dir, 'config', 'user.name', 'Local Test'); git(dir, 'config', 'user.email', 'local@test.invalid');
    writeFileSync(path.join(dir, 'source.ts'), 'export const a = 1;\n');
    git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'initial');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('keeps new files separate from tracked worktree changes unless explicitly included', () => {
    const reader = new LocalGitSnapshotReader(dir);
    writeFileSync(path.join(dir, 'source.ts'), 'export const a = 2;\n');
    writeFileSync(path.join(dir, 'new.ts'), 'export const secret = true;\n');
    const tracked = reader.capture({ kind: 'worktree' }, false);
    const all = reader.capture({ kind: 'worktree' }, true);
    expect(tracked.changedFiles).toBe(1);
    expect(tracked.untrackedFiles).toBe(1);
    expect(all.changedFiles).toBe(2);
    expect(all.digest).not.toBe(tracked.digest);
    writeFileSync(path.join(dir, 'new.ts'), 'export const secret = false;\n');
    expect(reader.capture({ kind: 'worktree' }, true).digest).not.toBe(all.digest);
  });
  it('compares branch changes from merge-base and resolves immutable commit refs', () => {
    git(dir, 'checkout', '-qb', 'feature');
    writeFileSync(path.join(dir, 'source.ts'), 'export const a = 3;\n');
    git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'feature');
    const reader = new LocalGitSnapshotReader(dir);
    expect(reader.capture({ kind: 'branch', base: 'HEAD~1' }, false).changedFiles).toBe(1);
    expect(reader.capture({ kind: 'commit', ref: 'HEAD' }, false).changedFiles).toBe(1);
    expect(() => reader.capture({ kind: 'commit', ref: '--bad-option' }, false)).toThrow();
  });
});
