import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { IncrementalReviewer } from '../../../src/cache/incremental';
import {
  FileReviewSnapshotStorage,
  selectIncrementalSnapshotStorage,
} from '../../../src/cache/review-snapshot-bridge';
import { PRContext, Review } from '../../../src/types';

describe('FileReviewSnapshotStorage', () => {
  it('restores a hosted snapshot and prepares a normalized CAS candidate', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'review-snapshot-bridge-'));
    const inputPath = join(directory, 'input.json');
    const outputPath = join(directory, 'output.json');
    const compatibilityKey = 'c'.repeat(64);
    await writeFile(
      inputPath,
      JSON.stringify({
        protocolVersion: 1,
        status: 'found',
        expectedVersion: 4,
        snapshot: {
          version: 4,
          schemaVersion: 1,
          reviewedHeadSha: 'a'.repeat(40),
          baseSha: 'b'.repeat(40),
          compatibilityKey,
          payload: {
            reviewSummary: 'Previous review',
            findings: [finding('src/unchanged.ts')],
          },
          reviewedAt: new Date().toISOString(),
          expiresAt: '2099-07-23T10:00:00.000Z',
        },
      })
    );

    try {
      const storage = new FileReviewSnapshotStorage(inputPath, outputPath);
      const reviewer = new IncrementalReviewer(storage, {
        enabled: true,
        cacheTtlDays: 7,
        compatibilityKey,
        requireCompatibleSnapshot: true,
      });
      const pr = pullRequest();

      await expect(reviewer.shouldUseIncremental(pr)).resolves.toBe(true);
      const replacementEnvelope = JSON.parse(await readFile(inputPath, 'utf8'));
      replacementEnvelope.expectedVersion = 9;
      replacementEnvelope.snapshot.version = 9;
      await writeFile(inputPath, JSON.stringify(replacementEnvelope));
      await reviewer.saveReview(pr, review());

      const candidate = JSON.parse(await readFile(outputPath, 'utf8'));
      expect(candidate).toMatchObject({
        protocolVersion: 1,
        expectedVersion: 4,
        pullRequestNumber: 240,
        schemaVersion: 1,
        reviewedHeadSha: pr.headSha,
        baseSha: pr.baseSha,
        compatibilityKey,
        payload: {
          reviewSummary: 'Current review',
          findings: [{ file: 'src/current.ts', severity: 'major' }],
        },
      });
      expect(JSON.stringify(candidate)).not.toContain('evidence');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a snapshot from an incompatible runtime configuration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'review-snapshot-bridge-'));
    const inputPath = join(directory, 'input.json');
    const outputPath = join(directory, 'output.json');
    await writeFile(
      inputPath,
      JSON.stringify({
        protocolVersion: 1,
        status: 'found',
        expectedVersion: 1,
        snapshot: {
          version: 1,
          schemaVersion: 1,
          reviewedHeadSha: 'a'.repeat(40),
          baseSha: 'b'.repeat(40),
          compatibilityKey: 'c'.repeat(64),
          payload: { reviewSummary: 'Previous review', findings: [] },
          reviewedAt: new Date().toISOString(),
          expiresAt: '2099-07-23T10:00:00.000Z',
        },
      })
    );

    try {
      const reviewer = new IncrementalReviewer(
        new FileReviewSnapshotStorage(inputPath, outputPath),
        {
          enabled: true,
          cacheTtlDays: 7,
          compatibilityKey: 'd'.repeat(64),
          requireCompatibleSnapshot: true,
        }
      );
      await expect(reviewer.shouldUseIncremental(pullRequest())).resolves.toBe(
        false
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects restore envelopes whose CAS and snapshot versions differ', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'review-snapshot-bridge-'));
    const inputPath = join(directory, 'input.json');
    const outputPath = join(directory, 'output.json');
    await writeFile(
      inputPath,
      JSON.stringify({
        protocolVersion: 1,
        status: 'found',
        expectedVersion: 2,
        snapshot: {
          version: 1,
          schemaVersion: 1,
          reviewedHeadSha: 'a'.repeat(40),
          baseSha: 'b'.repeat(40),
          compatibilityKey: 'c'.repeat(64),
          payload: { reviewSummary: 'Previous review', findings: [] },
          reviewedAt: new Date().toISOString(),
          expiresAt: '2099-07-23T10:00:00.000Z',
        },
      })
    );

    try {
      const storage = new FileReviewSnapshotStorage(inputPath, outputPath);
      await expect(
        storage.read('incremental-review-pr-240')
      ).resolves.toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('redacts prose, omits suggestions, and bounds the persisted payload', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'review-snapshot-bridge-'));
    const inputPath = join(directory, 'input.json');
    const outputPath = join(directory, 'output.json');
    await writeFile(
      inputPath,
      JSON.stringify({
        protocolVersion: 1,
        status: 'missing',
        expectedVersion: 0,
      })
    );

    try {
      const reviewer = new IncrementalReviewer(
        new FileReviewSnapshotStorage(inputPath, outputPath),
        {
          enabled: true,
          cacheTtlDays: 7,
          compatibilityKey: 'c'.repeat(64),
          requireCompatibleSnapshot: true,
        }
      );
      const largeFindings = Array.from({ length: 500 }, (_, index) => ({
        ...finding(`src/file-${index}.ts`),
        title: `Secret sk-${'a'.repeat(32)}`,
        message: `refresh_token=${'b'.repeat(32)} ${'x'.repeat(19_900)}`,
        suggestion: `const token = "sk-${'c'.repeat(32)}";`,
      }));
      await reviewer.saveReview(pullRequest(), {
        ...review(),
        summary: `github_pat_${'d'.repeat(32)}`,
        findings: largeFindings,
      });

      const rawCandidate = await readFile(outputPath, 'utf8');
      const candidate = JSON.parse(rawCandidate);
      expect(Buffer.byteLength(rawCandidate)).toBeLessThanOrEqual(
        512 * 1024 + 16 * 1024
      );
      expect(
        Buffer.byteLength(JSON.stringify(candidate.payload))
      ).toBeLessThanOrEqual(512 * 1024);
      expect(candidate.payload.reviewSummary).toBe('github_pat_***');
      expect(candidate.payload.findings.length).toBeLessThan(500);
      expect(JSON.stringify(candidate)).not.toContain('suggestion');
      expect(JSON.stringify(candidate)).not.toContain('refresh_token=' + 'b');
      expect(JSON.stringify(candidate)).not.toContain('sk-' + 'a'.repeat(16));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('never falls back to repository cache when the hosted bridge is required', async () => {
    const localStorage = {
      read: jest.fn().mockResolvedValue('untrusted-cache'),
      write: jest.fn().mockResolvedValue(undefined),
    };
    const selected = selectIncrementalSnapshotStorage({
      env: { REVIEWROUTER_INCREMENTAL_SNAPSHOT_REQUIRED: 'true' },
      localStorage,
      incrementalEnabled: true,
    });

    expect(selected).toMatchObject({
      enabled: false,
      requireCompatibleSnapshot: true,
      hostedSnapshotUnavailable: true,
    });
    await expect(selected.storage.read('any-key')).resolves.toBeNull();
    expect(localStorage.read).not.toHaveBeenCalled();
  });
});

function pullRequest(): PRContext {
  return {
    number: 240,
    title: 'Incremental snapshot',
    body: '',
    author: 'reviewrouter',
    draft: false,
    labels: [],
    files: [],
    diff: '',
    additions: 1,
    deletions: 0,
    baseSha: 'b'.repeat(40),
    headSha: 'd'.repeat(40),
  };
}

function finding(file: string) {
  return {
    file,
    line: 12,
    severity: 'major' as const,
    title: 'Persist state',
    message: 'The review state must remain durable.',
  };
}

function review(): Review {
  return {
    summary: 'Current review',
    findings: [
      {
        ...finding('src/current.ts'),
        evidence: {
          confidence: 0.9,
          reasoning: 'Supported by the current diff.',
          badge: 'high',
        },
      },
    ],
    inlineComments: [],
    actionItems: [],
    metrics: {
      totalFindings: 1,
      critical: 0,
      major: 1,
      minor: 0,
      providersUsed: 1,
      providersSuccess: 1,
      providersFailed: 0,
      totalTokens: 10,
      totalCost: 0,
      durationSeconds: 1,
    },
  };
}
