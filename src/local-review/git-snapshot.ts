import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { lstatSync, readFileSync } from 'fs';
import * as path from 'path';
import { LocalReviewScope, LocalReviewUsageError } from './contracts';

const MAX_GIT_BUFFER = 16 * 1024 * 1024;
const MAX_UNTRACKED_BYTES = 16 * 1024 * 1024;
const MAX_UNTRACKED_FILES = 2000;

function git(root: string, args: string[]): Buffer {
  try {
    return execFileSync('git', args, {
      cwd: root, encoding: 'buffer', maxBuffer: MAX_GIT_BUFFER, timeout: 15_000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_EXTERNAL_DIFF: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new LocalReviewUsageError(`Git could not resolve the requested local review scope (${args[0]}).`);
  }
}

function optionalGit(root: string, args: string[]): string | null {
  try { return git(root, args).toString('utf8').trim(); } catch { return null; }
}

function resolveCommit(root: string, ref: string): string {
  if (!ref || ref.length > 256 || ref.startsWith('-') || ref.includes('\u0000')) {
    throw new LocalReviewUsageError('Invalid Git commit/ref.');
  }
  const sha = git(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).toString('utf8').trim();
  if (!/^[a-f0-9]{40}$/i.test(sha)) throw new LocalReviewUsageError('Git commit/ref resolution was not a SHA-1 commit.');
  return sha;
}

function splitNul(buffer: Buffer): string[] {
  return buffer.toString('utf8').split('\u0000').filter(Boolean);
}

export interface LocalGitSnapshot {
  root: string;
  scope: LocalReviewScope;
  digest: string;
  base: string | null;
  head: string | null;
  changedFiles: number;
  untrackedFiles: number;
  dirty: boolean;
  untrackedPaths: string[];
}

export class LocalGitSnapshotReader {
  constructor(private readonly workingDirectory: string = process.cwd()) {}

  root(): string {
    const root = git(this.workingDirectory, ['rev-parse', '--show-toplevel']).toString('utf8').trim();
    if (!root || !path.isAbsolute(root)) throw new LocalReviewUsageError('Not inside a Git working tree.');
    return path.resolve(root); // Git uses / separators on Windows; filesystem reads use native paths.
  }

  capture(scope: LocalReviewScope, includeUntracked: boolean): LocalGitSnapshot {
    const root = this.root();
    const head = optionalGit(root, ['rev-parse', '--verify', 'HEAD']);
    const h = createHash('sha256');
    h.update(`reviewrouter-local/v1\u0000${scope.kind}\u0000`);
    let base: string | null = null;
    let selectedHead = head;
    let diff: Buffer = Buffer.alloc(0);
    let changedFiles = 0;
    let untrackedPaths: string[] = [];
    let untrackedFiles = 0;
    const status = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const dirty = status.length > 0;
    h.update(status);

    if (scope.kind === 'branch') {
      if (!head) throw new LocalReviewUsageError('Branch review needs an initial commit.');
      const baseTip = resolveCommit(root, scope.base);
      base = git(root, ['merge-base', baseTip, head]).toString('utf8').trim();
      diff = git(root, ['diff', '--no-ext-diff', '--no-textconv', '--binary', base, head]);
      changedFiles = splitNul(git(root, ['diff', '--no-ext-diff', '--name-only', '-z', base, head])).length;
      h.update(baseTip);
    } else if (scope.kind === 'commit') {
      selectedHead = resolveCommit(root, scope.ref);
      const parent = optionalGit(root, ['rev-parse', '--verify', `${selectedHead}^`]);
      base = parent || '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
      diff = git(root, ['diff', '--no-ext-diff', '--no-textconv', '--binary', base, selectedHead]);
      changedFiles = splitNul(git(root, ['diff', '--no-ext-diff', '--name-only', '-z', base, selectedHead])).length;
    } else {
      // Preserve the current tracked-only default, plus explicitly opted-in untracked files.
      const trackedDiffArgs = head
        ? ['diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD']
        : ['diff', '--no-ext-diff', '--no-textconv', '--binary', '--cached'];
      diff = git(root, trackedDiffArgs);
      if (!head) diff = Buffer.concat([diff, git(root, ['diff', '--no-ext-diff', '--no-textconv', '--binary'])]);
      changedFiles = splitNul(git(root, head
        ? ['diff', '--no-ext-diff', '--name-only', '-z', 'HEAD']
        : ['ls-files', '--cached', '-z'])).length;
      untrackedPaths = splitNul(git(root, ['ls-files', '--others', '--exclude-standard', '-z']));
      if (includeUntracked && untrackedPaths.length > MAX_UNTRACKED_FILES) {
        throw new LocalReviewUsageError('Too many untracked files for bounded local review.');
      }
      untrackedFiles = untrackedPaths.length;
      if (includeUntracked) {
        let bytesRead = 0;
        for (const p of untrackedPaths) {
          const resolved = path.resolve(root, p);
          const relative = path.relative(root, resolved);
          if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
            throw new LocalReviewUsageError('Unsafe untracked path.');
          }
          const stat = lstatSync(resolved);
          if (stat.isSymbolicLink()) {
            // Native OCR can follow links; do not send arbitrary external contents.
            throw new LocalReviewUsageError('Untracked symlinks require a separate audited scope.');
          }
          if (!stat.isFile() || stat.size > MAX_UNTRACKED_BYTES - bytesRead) {
            throw new LocalReviewUsageError('Untracked input exceeds the bounded review limit.');
          }
          const content = readFileSync(resolved);
          bytesRead += content.length;
          h.update(p).update('\u0000').update(content).update('\u0000');
        }
        changedFiles += untrackedFiles;
      }
    }
    h.update(base ?? '').update('\u0000').update(selectedHead ?? '').update('\u0000').update(diff);
    return {
      root, scope, digest: `sha256:${h.digest('hex')}`,
      base, head: selectedHead, changedFiles, untrackedFiles, dirty, untrackedPaths,
    };
  }
}

