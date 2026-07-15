import { PullRequestLoader } from '../../../src/github/pr-loader';
import { GitHubClient } from '../../../src/github/client';
import {
  createMockOctokit,
  createErrorOctokit,
} from '../../helpers/github-mock';

function createMockClient(octokit: any): jest.Mocked<GitHubClient> {
  return {
    octokit,
    owner: 'test-owner',
    repo: 'test-repo',
  } as any;
}

describe('PullRequestLoader', () => {
  describe('load', () => {
    it('loads PR context successfully', async () => {
      const mockClient = createMockClient(createMockOctokit());
      const loader = new PullRequestLoader(mockClient);

      const context = await loader.load(1);

      expect(context).toBeDefined();
      expect(context.number).toBe(1);
      expect(context.title).toBe('Test PR');
      expect(context.author).toBe('test-user');
      expect(context.files).toHaveLength(1);
      expect(context.baseSha).toBe('base-sha');
      expect(context.headSha).toBe('head-sha');
    });

    it('loads PR files', async () => {
      const mockClient = createMockClient(createMockOctokit());
      const loader = new PullRequestLoader(mockClient);

      const context = await loader.load(1);

      expect(context.files).toBeDefined();
      expect(context.files[0].filename).toBe('src/test.ts');
      expect(context.files[0].status).toBe('modified');
      expect(context.files[0].additions).toBe(5);
      expect(context.files[0].deletions).toBe(2);
    });

    it('handles PR with labels', async () => {
      const mockOctokit = createMockOctokit({
        pr: {
          labels: ['bug', 'enhancement'],
        },
      });
      const mockClient = createMockClient(mockOctokit);

      const loader = new PullRequestLoader(mockClient);
      const context = await loader.load(1);

      expect(context.labels).toEqual(['bug', 'enhancement']);
    });

    it('handles draft PR', async () => {
      const mockOctokit = createMockOctokit({
        pr: {
          draft: true,
        },
      });
      const mockClient = createMockClient(mockOctokit);

      const loader = new PullRequestLoader(mockClient);
      const context = await loader.load(1);

      expect(context.draft).toBe(true);
    });

    it('handles bot author', async () => {
      const mockOctokit = createMockOctokit({
        pr: {
          author: 'dependabot[bot]',
        },
      });
      const mockClient = createMockClient(mockOctokit);

      const loader = new PullRequestLoader(mockClient);
      const context = await loader.load(1);

      expect(context.author).toBe('dependabot[bot]');
    });
  });

  describe('Error Handling', () => {
    it('throws error when PR not found', async () => {
      const errorOctokit = createErrorOctokit(404, 'Not Found');
      const mockClient = createMockClient(errorOctokit);

      const loader = new PullRequestLoader(mockClient);

      await expect(loader.load(999)).rejects.toThrow('Not Found');
    });

    it('throws error on API failure', async () => {
      const errorOctokit = createErrorOctokit(500, 'Internal Server Error');
      const mockClient = createMockClient(errorOctokit);

      const loader = new PullRequestLoader(mockClient);

      await expect(loader.load(1)).rejects.toThrow('Internal Server Error');
    });
  });

  describe('Diff Generation', () => {
    it('includes diff in PR context', async () => {
      const mockClient = createMockClient(createMockOctokit());
      const loader = new PullRequestLoader(mockClient);

      const context = await loader.load(1);

      expect(context.diff).toBeDefined();
      expect(typeof context.diff).toBe('string');
    });

    it('handles files without patches', async () => {
      const mockOctokit = createMockOctokit({
        files: [
          {
            filename: 'binary-file.png',
            status: 'added',
            additions: 0,
            deletions: 0,
            changes: 0,
            // No patch for binary files
          },
        ],
      });
      const mockClient = createMockClient(mockOctokit);

      const loader = new PullRequestLoader(mockClient);
      const context = await loader.load(1);

      expect(context.files).toHaveLength(1);
      expect(context.files[0].patch).toBeUndefined();
    });

    it('paginates large PRs and synthesizes their diff without requesting raw diff', async () => {
      const files = Array.from({ length: 350 }, (_, index) => ({
        filename: `src/file-${index}.ts`,
        status: 'modified',
        additions: 1,
        deletions: 0,
        changes: 1,
        patch: `@@ -0,0 +1 @@\n+export const value${index} = ${index};`,
      }));
      const mockOctokit = createMockOctokit();
      mockOctokit.rest.pulls.listFiles = jest.fn(({ page, per_page }) =>
        Promise.resolve({
          data: files.slice((page - 1) * per_page, page * per_page),
        })
      );
      const mockClient = createMockClient(mockOctokit);

      const context = await new PullRequestLoader(mockClient).load(1);

      expect(context.files).toHaveLength(350);
      expect(mockOctokit.rest.pulls.listFiles).toHaveBeenCalledTimes(4);
      expect(mockOctokit.request).not.toHaveBeenCalled();
      expect(context.diff).toContain(
        'diff --git a/src/file-0.ts b/src/file-0.ts'
      );
      expect(context.diff).toContain(
        'diff --git a/src/file-349.ts b/src/file-349.ts'
      );
    });

    it('falls back to file patches when GitHub rejects a raw diff as too large', async () => {
      const mockOctokit = createMockOctokit();
      mockOctokit.request = jest.fn().mockRejectedValue({
        status: 422,
        message: 'Validation Failed',
        response: {
          data: {
            message:
              'Sorry, the diff exceeded the maximum number of files (300).',
            errors: [{ code: 'too_large' }],
          },
        },
      });
      const mockClient = createMockClient(mockOctokit);

      const context = await new PullRequestLoader(mockClient).load(1);

      expect(context.diff).toContain('diff --git a/src/test.ts b/src/test.ts');
      expect(context.diff).toContain('@@ -8,3 +8,4 @@');
    });

    it('does not hide unrelated raw diff failures', async () => {
      const mockOctokit = createMockOctokit();
      mockOctokit.request = jest.fn().mockRejectedValue({
        status: 500,
        message: 'Internal Server Error',
      });
      const mockClient = createMockClient(mockOctokit);

      await expect(
        new PullRequestLoader(mockClient).load(1)
      ).rejects.toMatchObject({
        status: 500,
      });
    });

    it('represents binary files in a synthesized diff', async () => {
      const files = Array.from({ length: 301 }, (_, index) => ({
        filename: `assets/image-${index}.png`,
        status: 'added',
        additions: 0,
        deletions: 0,
        changes: 0,
      }));
      const mockOctokit = createMockOctokit();
      mockOctokit.rest.pulls.listFiles = jest.fn(({ page, per_page }) =>
        Promise.resolve({
          data: files.slice((page - 1) * per_page, page * per_page),
        })
      );
      const mockClient = createMockClient(mockOctokit);

      const context = await new PullRequestLoader(mockClient).load(1);

      expect(context.diff).toContain('--- /dev/null');
      expect(context.diff).toContain(
        'Binary file or patch unavailable from GitHub API'
      );
    });
  });
});
