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
  it('does not impose the included-file cap on excluded untracked files', () => {
    for (let i = 0; i < 2001; i++) {
      writeFileSync(path.join(dir, `untracked-${i}.ts`), '// not reviewed\\n');
    }
    const reader = new LocalGitSnapshotReader(dir);
    const excluded = reader.capture({ kind: 'worktree' }, false);
    expect(excluded.untrackedFiles).toBe(2001);
    expect(excluded.changedFiles).toBe(0);
    expect(() => reader.capture({ kind: 'worktree' }, true)).toThrow(/Too many untracked/);
  });
  it('distinguishes tip-to-tip legacy input from merge-base native input', () => {
    const initial = git(dir, 'rev-parse', 'HEAD');
    const main = git(dir, 'branch', '--show-current');
    git(dir, 'checkout', '-qb', 'feature');
    writeFileSync(path.join(dir, 'source.ts'), 'export const a = 2;\n');
    git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'feature');
    const featureHead = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'checkout', '-q', main);
    writeFileSync(path.join(dir, 'source.ts'), 'export const a = 3;\n');
    git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'main progressed');
    const mainHead = git(dir, 'rev-parse', 'HEAD');
    const reader = new LocalGitSnapshotReader(dir);
    const tips = reader.capture({ kind: 'branch', base: main, head: 'feature', comparison: 'tips' }, false);
    const mergeBase = reader.capture({ kind: 'branch', base: main, head: 'feature' }, false);
    expect(tips.base).toBe(mainHead);
    expect(tips.head).toBe(featureHead);
    expect(mergeBase.base).toBe(initial);
    expect(mergeBase.head).toBe(featureHead);
    expect(tips.digest).not.toBe(mergeBase.digest);
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
