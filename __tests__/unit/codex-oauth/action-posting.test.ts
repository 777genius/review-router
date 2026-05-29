import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { postReviewAfterAuthClear } from '../../../src/codex-oauth/action';
import { DEFAULT_CONFIG } from '../../../src/config/defaults';
import { ConfigLoader } from '../../../src/config/loader';
import { CommentPoster } from '../../../src/github/comment-poster';
import { PullRequestLoader } from '../../../src/github/pr-loader';
import { CodexOAuthReviewResult } from '../../../src/codex-oauth/runtime';

describe('Codex OAuth rotating post-auth commenting', () => {
  const originalEnv = process.env;
  let eventPath: string;

  beforeEach(() => {
    eventPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'rr-codex-event-')),
      'event.json'
    );
    fs.writeFileSync(
      eventPath,
      JSON.stringify({
        repository: { full_name: '777genius/test-repo' },
        pull_request: {
          number: 12,
          head: {
            repo: { full_name: '777genius/test-repo' },
            sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          },
        },
      })
    );
    process.env = {
      ...originalEnv,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: '777genius/test-repo',
    };
    jest.spyOn(ConfigLoader, 'load').mockReturnValue(DEFAULT_CONFIG);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = originalEnv;
    fs.rmSync(path.dirname(eventPath), { recursive: true, force: true });
  });

  it('posts summary and inline comments only after auth has been cleared', async () => {
    const postSummary = jest
      .spyOn(CommentPoster.prototype, 'postSummary')
      .mockResolvedValue({ posted: true, skippedStale: false });
    const postInline = jest
      .spyOn(CommentPoster.prototype, 'postInline')
      .mockResolvedValue(undefined);
    const loadPr = jest
      .spyOn(PullRequestLoader.prototype, 'load')
      .mockResolvedValue({
        number: 12,
        title: 'Test PR',
        body: '',
        author: 'belief',
        draft: false,
        labels: [],
        files: [
          {
            filename: 'discount.js',
            status: 'modified',
            additions: 1,
            deletions: 1,
            changes: 2,
            patch:
              '@@ -1,3 +1,3 @@\n export function apply(price, percent) {\n-  return price;\n+  return price - percent;\n }\n',
          },
        ],
        diff: '',
        additions: 1,
        deletions: 1,
        baseSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      });
    const review: CodexOAuthReviewResult = {
      skipped: false,
      userDryRun: false,
      markdown: '<!-- review-router-bot -->\n\n# ReviewRouter',
      review: {
        summary: '1 major finding',
        findings: [],
        inlineComments: [
          {
            path: 'discount.js',
            line: 2,
            side: 'RIGHT',
            severity: 'major',
            body: 'Discount percent is subtracted as a fixed amount.',
          },
        ],
        actionItems: [],
        metrics: {
          totalFindings: 1,
          critical: 0,
          major: 1,
          minor: 0,
          providersUsed: 1,
          providersSuccess: 1,
          providersFailed: 0,
          totalTokens: 0,
          totalCost: 0,
          durationSeconds: 1,
        },
      },
    };

    await postReviewAfterAuthClear({
      commentToken: 'ghs_comment_after_auth_clear',
      review,
    });

    expect(postSummary).toHaveBeenCalledWith(
      12,
      '<!-- review-router-bot -->\n\n# ReviewRouter',
      false
    );
    expect(loadPr).toHaveBeenCalledWith(12);
    expect(postInline).toHaveBeenCalledWith(
      12,
      review.review?.inlineComments,
      expect.arrayContaining([
        expect.objectContaining({ filename: 'discount.js' }),
      ]),
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    );
  });

  it('does not post comments when the original user requested dry run', async () => {
    const postSummary = jest.spyOn(CommentPoster.prototype, 'postSummary');
    const postInline = jest.spyOn(CommentPoster.prototype, 'postInline');

    await postReviewAfterAuthClear({
      commentToken: 'ghs_comment_after_auth_clear',
      review: {
        skipped: false,
        userDryRun: true,
        markdown: '<!-- review-router-bot -->\n\n# ReviewRouter',
      },
    });

    expect(postSummary).not.toHaveBeenCalled();
    expect(postInline).not.toHaveBeenCalled();
  });
});
