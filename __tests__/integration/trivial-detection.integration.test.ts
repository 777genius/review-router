import { ReviewOrchestrator, ReviewComponents } from '../../src/core/orchestrator';
import {
  FileChange,
  LifecycleTarget,
  PRContext,
  ReviewConfig,
} from '../../src/types';
import { setupComponents } from '../../src/setup';
import * as fs from 'fs/promises';
import * as path from 'path';

describe('Trivial Detection Integration', () => {
  let components: ReviewComponents;
  let orchestrator: ReviewOrchestrator;
  const originalFailOnNoHealthyProviders = process.env.FAIL_ON_NO_HEALTHY_PROVIDERS;

  beforeAll(async () => {
    process.env.FAIL_ON_NO_HEALTHY_PROVIDERS = 'false';
    // Setup components in CLI mode (no GitHub API)
    components = await setupComponents({ cliMode: true, dryRun: true });
    jest.spyOn(components.providerRegistry, 'createProviders').mockResolvedValue([]);
    jest.spyOn(components.providerRegistry, 'discoverAdditionalFreeProviders').mockResolvedValue([]);
    orchestrator = new ReviewOrchestrator(components);
  });

  afterAll(async () => {
    // Clean up cache directory after tests
    const cacheDir = path.join(process.cwd(), '.mpr-cache');
    try {
      await fs.rm(cacheDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }

    if (originalFailOnNoHealthyProviders === undefined) {
      delete process.env.FAIL_ON_NO_HEALTHY_PROVIDERS;
    } else {
      process.env.FAIL_ON_NO_HEALTHY_PROVIDERS = originalFailOnNoHealthyProviders;
    }
  });

  const createMockPR = (files: FileChange[]): PRContext => ({
    number: 999,
    title: 'Test PR',
    body: 'Test description',
    author: 'test-user',
    draft: false,
    labels: [],
    files,
    diff: files.map(f => f.patch || '').join('\n'),
    additions: files.reduce((sum, f) => sum + f.additions, 0),
    deletions: files.reduce((sum, f) => sum + f.deletions, 0),
    baseSha: 'abc123',
    headSha: 'def456',
  });

  const createFile = (filename: string, patch?: string): FileChange => ({
    filename,
    status: 'modified',
    additions: 10,
    deletions: 5,
    changes: 15,
    patch,
  });

  const createLifecycleTarget = (): LifecycleTarget => ({
    targetId: 'rrt_trivial_skip',
    threadId: 'thread-1',
    threadUrl: 'https://github.com/owner/repo/pull/999#discussion_r1',
    fingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    severity: 'major',
    title: 'Old major finding',
    message: 'Old failure mode still needs revalidation.',
    originalPath: 'src/app.ts',
    currentPath: 'src/app.ts',
    originalLine: 10,
    currentLine: 10,
    parentCommentId: 'comment-1',
    parentCommentUpdatedAt: '2026-05-14T00:00:00Z',
    threadCommentCount: 1,
    viewerCanResolve: true,
    hasHumanReply: false,
    trustedAuthor: true,
    reasonCodes: [],
  });

  describe('fully trivial PRs', () => {
    it('should skip review for dependency lock file PRs', async () => {
      const pr = createMockPR([
        createFile('package-lock.json'),
        createFile('yarn.lock'),
      ]);

      const review = await orchestrator.executeReview(pr);

      expect(review.findings).toHaveLength(0);
      expect(review.summary).toContain('trivial changes');
      expect(review.summary).toContain('dependency');
      expect(review.metrics.totalCost).toBe(0);
      expect(review.metrics.providersUsed).toBe(0);
    });

    it('should skip review for documentation-only PRs', async () => {
      const pr = createMockPR([
        createFile('README.md'),
        createFile('docs/guide.md'),
        createFile('CHANGELOG.md'),
      ]);

      const review = await orchestrator.executeReview(pr);

      expect(review.findings).toHaveLength(0);
      expect(review.summary).toContain('trivial changes');
      expect(review.summary).toContain('documentation');
      expect(review.metrics.totalCost).toBe(0);
    });

    it('should skip review for build artifact PRs', async () => {
      const pr = createMockPR([
        createFile('dist/index.js'),
        createFile('dist/bundle.css'),
        createFile('bundle.js.map'),
      ]);

      const review = await orchestrator.executeReview(pr);

      expect(review.findings).toHaveLength(0);
      expect(review.summary).toContain('trivial changes');
      expect(review.summary).toContain('build artifact');
      expect(review.metrics.totalCost).toBe(0);
    });

    it('should skip review for config file PRs', async () => {
      const pr = createMockPR([
        createFile('.eslintrc.json'),
        createFile('.prettierrc'),
        createFile('.gitignore'),
        createFile('.gitattributes'),
      ]);

      const review = await orchestrator.executeReview(pr);

      expect(review.findings).toHaveLength(0);
      expect(review.summary).toContain('trivial changes');
      expect(review.summary).toContain('config');
      expect(review.metrics.totalCost).toBe(0);
    });

    it('should skip review for test fixture PRs', async () => {
      const pr = createMockPR([
        createFile('__fixtures__/data.json'),
        createFile('__tests__/__snapshots__/test.snap'),
      ]);

      const review = await orchestrator.executeReview(pr);

      expect(review.findings).toHaveLength(0);
      expect(review.summary).toContain('trivial changes');
      expect(review.summary).toContain('test fixture');
    });

    it('should show cost savings in trivial review message', async () => {
      const pr = createMockPR([createFile('package-lock.json')]);

      const review = await orchestrator.executeReview(pr);

      expect(review.summary).toContain('Cost savings');
      expect(review.summary).toContain('API costs');
    });

    it('should track metrics for trivial reviews', async () => {
      const pr = createMockPR([createFile('README.md')]);

      const review = await orchestrator.executeReview(pr);

      expect(review.metrics.durationSeconds).toBeGreaterThan(0);
      expect(review.runDetails).toBeDefined();
      expect(review.runDetails?.durationSeconds).toBeGreaterThan(0);
    });

    it('keeps old unresolved lifecycle threads visible when a trivial PR skips LLM review', async () => {
      const postSummary = jest.fn().mockResolvedValue(undefined);
      const loadInventory = jest.fn().mockResolvedValue({
        headRefOid: 'def456',
        candidates: [createLifecycleTarget()],
        manualAttention: [],
        dedupeComments: [],
        warnings: [],
        failed: false,
      });
      const lifecycleComponents: ReviewComponents = {
        ...components,
        config: {
          ...components.config,
          reviewThreadLifecycle: 'resolve',
        },
        githubClient: {
          owner: 'owner',
          repo: 'repo',
        } as any,
        reviewThreadInventory: {
          load: loadInventory,
        } as any,
        commentPoster: {
          ...components.commentPoster,
          postSummary,
        } as any,
        feedbackFilter: {
          ...components.feedbackFilter,
          loadReviewCommentState: jest.fn().mockResolvedValue({
            suppressed: new Set(),
            alreadyPosted: new Set(),
            suppressedComments: [],
            alreadyPostedComments: [],
            commandDismissed: new Set(),
            commandDismissedLocations: new Set(),
          }),
          isInlineCommandDismissed: jest.fn(() => false),
        } as any,
      };
      const lifecycleOrchestrator = new ReviewOrchestrator(
        lifecycleComponents
      );
      const pr = createMockPR([createFile('README.md')]);

      const review = await lifecycleOrchestrator.executeReview(pr);

      expect(loadInventory).toHaveBeenCalledWith(999);
      expect(review.threadLifecycle?.previousUncertain).toHaveLength(1);
      expect(review.threadLifecycle?.resolvedByLifecycle).toHaveLength(0);
      expect(postSummary).toHaveBeenCalledWith(
        999,
        expect.stringContaining('Previous Review Threads'),
        false,
        expect.objectContaining({ reviewedHeadSha: 'def456' })
      );
      expect(postSummary.mock.calls[0][1]).not.toContain('## All Clear!');
    });
  });

  describe('partially trivial PRs', () => {
    it('should filter trivial files and review non-trivial files', async () => {
      const pr = createMockPR([
        createFile('src/app.ts', '@@ -1,1 +1,1 @@\n-const x = 1;\n+const x = 2;'),
        createFile('package-lock.json'),
        createFile('README.md'),
        createFile('dist/bundle.js'),
      ]);

      const review = await orchestrator.executeReview(pr);

      // Should have attempted to review the source file
      // (may have 0 findings if providers fail, but should not be trivial)
      expect(review.summary).not.toContain('only trivial changes');
    }, 20000); // 20 second timeout for provider health checks

    it('should not mutate original PR context', async () => {
      const originalFiles = [
        createFile('src/app.ts'),
        createFile('package-lock.json'),
      ];
      const pr = createMockPR([...originalFiles]);

      await orchestrator.executeReview(pr);

      // Original PR should still have all files
      expect(pr.files).toHaveLength(2);
      expect(pr.files[0].filename).toBe('src/app.ts');
      expect(pr.files[1].filename).toBe('package-lock.json');
    }, 20000); // 20 second timeout for provider health checks
  });

  describe('configuration', () => {
    it('should respect skipTrivialChanges = false', async () => {
      const customConfig: ReviewConfig = {
        ...components.config,
        skipTrivialChanges: false,
      };

      const customComponents = {
        ...components,
        config: customConfig,
      };

      const customOrchestrator = new ReviewOrchestrator(customComponents);

      const pr = createMockPR([createFile('package-lock.json')]);
      const review = await customOrchestrator.executeReview(pr);

      // Should not skip review (though may have no findings)
      expect(review.summary).not.toContain('only trivial changes');
    }, 20000); // 20 second timeout for provider health checks

    it('should respect custom trivial patterns', async () => {
      const customConfig: ReviewConfig = {
        ...components.config,
        trivialPatterns: ['\\.generated\\.ts$'],
      };

      const customComponents = {
        ...components,
        config: customConfig,
      };

      const customOrchestrator = new ReviewOrchestrator(customComponents);

      const pr = createMockPR([
        createFile('src/types.generated.ts'),
        createFile('src/schema.generated.ts'),
      ]);

      const review = await customOrchestrator.executeReview(pr);

      expect(review.findings).toHaveLength(0);
      expect(review.summary).toContain('trivial changes');
    }, 20000); // 20 second timeout for provider health checks
  });
});
