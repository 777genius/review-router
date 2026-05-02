import {
  clearReviewFailureSummariesForClient,
  formatReviewFailureSummary,
} from '../../../src/github/failure-summary';

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

describe('formatReviewFailureSummary', () => {
  it('formats Codex OAuth failures with actionable checks', () => {
    const body = formatReviewFailureSummary(
      new Error('CODEX_AUTH_JSON auth.json refresh_token is missing'),
      123
    );

    expect(body).toContain('# ReviewRouter');
    expect(body).toContain('Codex OAuth authentication is missing');
    expect(body).toContain('`CODEX_AUTH_JSON`');
    expect(body).toContain('Reseed `auth.json`');
    expect(body).toContain('PR: #123');
  });

  it('classifies Codex 401 failures as OAuth reseed failures', () => {
    const body = formatReviewFailureSummary(
      new Error('All LLM providers failed during review. codex/gpt-5.5: 401 Unauthorized access token could not be refreshed'),
      123
    );

    expect(body).toContain('Codex OAuth authentication is missing');
    expect(body).toContain('Reseed `auth.json`');
    expect(body).toContain('self-hosted runner with persistent `CODEX_HOME`');
  });

  it('redacts obvious secrets from error messages', () => {
    const body = formatReviewFailureSummary(
      new Error('failed with OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz and refresh_token: secret-refresh and access_token: access-secret'),
      123
    );

    expect(body).toContain('OPENAI_API_KEY=***');
    expect(body).toContain('refresh_token: ***');
    expect(body).toContain('access_token: ***');
    expect(body).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(body).not.toContain('secret-refresh');
    expect(body).not.toContain('access-secret');
  });

  it('formats no-provider failures', () => {
    const body = formatReviewFailureSummary(
      new Error('No healthy providers available; failing because FAIL_ON_NO_HEALTHY_PROVIDERS=true')
    );

    expect(body).toContain('No configured review provider passed the health check');
    expect(body).toContain('Check provider credentials and model variables');
  });

  it('deletes only stale ReviewRouter failure summaries', async () => {
    const listComments = jest.fn();
    const deleteComment = jest.fn().mockResolvedValue({});
    const mockClient = {
      owner: 'owner',
      repo: 'repo',
      octokit: {
        rest: {
          issues: {
            listComments,
            deleteComment,
          },
        },
        paginate: jest.fn().mockResolvedValue([
          {
            id: 1,
            body: '<!-- review-router-bot -->\n\n🔴 **Review failed before comments could be completed.**',
          },
          {
            id: 2,
            body: '<!-- review-router-bot -->\n\n# ReviewRouter\n\n0 findings',
          },
          {
            id: 3,
            body: 'Human comment mentioning Review failed before comments could be completed.',
          },
        ]),
      },
    } as any;

    await clearReviewFailureSummariesForClient(mockClient, 123);

    expect(mockClient.octokit.paginate).toHaveBeenCalledWith(
      listComments,
      {
        owner: 'owner',
        repo: 'repo',
        issue_number: 123,
        per_page: 100,
      }
    );
    expect(deleteComment).toHaveBeenCalledTimes(1);
    expect(deleteComment).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      comment_id: 1,
    });
  });
});
