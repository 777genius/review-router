import { runLocalReview } from '../../../src/local-review/run-local-review';
import { LocalGitSnapshotReader, type LocalGitSnapshot } from '../../../src/local-review/git-snapshot';
import { exitCodeForLocalOutcome, type LocalReviewOutcome, type LocalReviewRunRequest } from '../../../src/local-review/contracts';

const base: LocalGitSnapshot = {
  root: '/repo', scope: { kind: 'worktree' }, digest: 'sha256:' + 'a'.repeat(64),
  head: 'b'.repeat(40), base: null, changedFiles: 1, dirty: true,
  untrackedFiles: 0, untrackedPaths: [],
};
const request: LocalReviewRunRequest = {
  engine: 'ocr', scope: { kind: 'worktree' }, includeUntracked: false, preview: false,
};
const accepted: LocalReviewOutcome = {
  schemaVersion: 1,
  engine: { id: 'ocr', version: '1.13.1' },
  status: 'complete',
  input: { scope: 'worktree', base: null, head: base.head, snapshotDigest: base.digest },
  coverage: { selected: 1, reviewed: 1, omitted: [], complete: true },
  provider: { name: 'test', model: 'test-v1' },
  findings: [],
  summary: { critical: 0, major: 0, minor: 0, unclassified: 0 },
  blocking: false, warnings: [],
};

class FakeGit extends LocalGitSnapshotReader {
  readonly captures: LocalGitSnapshot[];
  constructor(...snapshots: LocalGitSnapshot[]) {
    super('/repo');
    this.captures = [...snapshots];
  }
  override capture(): LocalGitSnapshot {
    const snapshot = this.captures.shift();
    if (!snapshot) throw new Error('unexpected Git snapshot request');
    return snapshot;
  }
}

describe('local review application boundary', () => {
  it('returns native result when the bounded Git snapshot is unchanged', async () => {
    let called = 0;
    const result = await runLocalReview(request, {
      git: new FakeGit(base, base),
      ocr: { run: async () => { called++; return accepted; } },
    });
    expect(called).toBe(1);
    expect(result.status).toBe('complete');
    expect(exitCodeForLocalOutcome(result)).toBe(0);
  });

  it('preserves the legacy gate for action items without major or critical findings', () => {
    expect(exitCodeForLocalOutcome({ ...accepted, blocking: true })).toBe(1);
    expect(exitCodeForLocalOutcome({ ...accepted, blocking: false })).toBe(0);
  });

  it('uses the same normalized contract for the legacy engine without invoking OCR', async () => {
    const legacy = { ...accepted, engine: { id: 'legacy' as const, version: null }, status: 'partial' as const,
      coverage: { ...accepted.coverage, complete: false } };
    const result = await runLocalReview({ ...request, engine: 'legacy' }, {
      git: new FakeGit(base, base),
      ocr: { run: async () => { throw new Error('OCR was not selected'); } },
      legacy: async () => legacy,
    });
    expect(result.engine.id).toBe('legacy');
    expect(result.status).toBe('partial');
    expect(exitCodeForLocalOutcome(result)).toBe(3);
  });

  it('fails closed when files or refs change while model inference runs', async () => {
    const changed = { ...base, digest: 'sha256:' + 'c'.repeat(64) };
    const result = await runLocalReview(request, {
      git: new FakeGit(base, changed),
      ocr: { run: async () => accepted },
    });
    expect(result.status).toBe('stale');
    expect(result.coverage.complete).toBe(false);
    expect(exitCodeForLocalOutcome(result)).toBe(3);
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/changed during/)]));
  });

  it('rejects untracked privacy ambiguity without launching OCR', async () => {
    let called = false;
    await expect(runLocalReview(request, {
      git: new FakeGit({ ...base, untrackedFiles: 1, untrackedPaths: ['secret.txt'] }),
      ocr: { run: async () => { called = true; return accepted; } },
    })).rejects.toThrow(/untracked.*included/i);
    expect(called).toBe(false);
  });

  it('refuses dirty branch review before starting native OCR', async () => {
    const branch = { ...base, scope: { kind: 'branch', base: 'main' } as const };
    await expect(runLocalReview({ ...request, scope: branch.scope }, {
      git: new FakeGit(branch),
      ocr: { run: async () => accepted },
    })).rejects.toThrow(/clean working tree/);
  });

  it('makes no model request for no changes', async () => {
    const result = await runLocalReview(request, {
      git: new FakeGit({ ...base, changedFiles: 0 }),
      ocr: { run: async () => { throw new Error('model must not be called'); } },
    });
    expect(result.status).toBe('skipped');
    expect(result.coverage.complete).toBe(false);
  });
});
