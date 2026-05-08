import { GitHubClient } from '../../src/github/client';
import { CommentPoster } from '../../src/github/comment-poster';
import { FileChange, InlineComment } from '../../src/types';

const runRangeCommentE2E = process.env.RUN_GITHUB_RANGE_COMMENT_E2E === '1';

describe('GitHub multi-line range comment real e2e', () => {
  (runRangeCommentE2E ? it : it.skip)(
    'posts an inline review comment with start_line and line',
    async () => {
      const token = process.env.GITHUB_TOKEN;
      const prNumber = Number(process.env.GITHUB_RANGE_E2E_PR_NUMBER);

      if (!token || !Number.isInteger(prNumber)) {
        throw new Error(
          'GITHUB_TOKEN and GITHUB_RANGE_E2E_PR_NUMBER are required'
        );
      }

      const client = new GitHubClient(token);
      const filesResponse = await client.octokit.rest.pulls.listFiles({
        owner: client.owner,
        repo: client.repo,
        pull_number: prNumber,
        per_page: 100,
      });

      const targetFile = filesResponse.data.find(
        (file: { filename: string }) => file.filename === 'src/range-target.ts'
      );
      if (!targetFile?.patch) {
        throw new Error('src/range-target.ts patch was not available');
      }

      const files: FileChange[] = [
        {
          filename: targetFile.filename,
          status: 'added',
          additions: targetFile.additions,
          deletions: targetFile.deletions,
          changes: targetFile.changes,
          patch: targetFile.patch,
        },
      ];
      const body = [
        '**Range E2E marker**',
        '',
        'This intentionally covers a changed block so GitHub should anchor the review thread to lines 2-5.',
      ].join('\n');
      const comments: InlineComment[] = [
        {
          path: 'src/range-target.ts',
          startLine: 2,
          line: 5,
          endLine: 5,
          side: 'RIGHT',
          body,
          severity: 'major',
        },
      ];

      await new CommentPoster(client).postInline(prNumber, comments, files);

      const reviewComments = await client.octokit.paginate(
        client.octokit.rest.pulls.listReviewComments,
        {
          owner: client.owner,
          repo: client.repo,
          pull_number: prNumber,
          per_page: 100,
        }
      );

      const posted = reviewComments.find((comment: { body?: string | null }) =>
        comment.body?.includes('Range E2E marker')
      );

      expect(posted).toBeTruthy();
      expect(posted?.path).toBe('src/range-target.ts');
      expect(posted?.start_line).toBe(2);
      expect(posted?.line).toBe(5);
      expect(posted?.side).toBe('RIGHT');
    },
    30000
  );
});
