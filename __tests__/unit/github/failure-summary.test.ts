import { formatReviewFailureSummary } from '../../../src/github/failure-summary';

describe('formatReviewFailureSummary', () => {
  it('formats Codex OAuth failures with actionable checks', () => {
    const body = formatReviewFailureSummary(
      new Error('CODEX_AUTH_JSON auth.json refresh_token is missing'),
      123
    );

    expect(body).toContain('# ReviewRouter');
    expect(body).toContain('Codex OAuth authentication is missing');
    expect(body).toContain('`CODEX_AUTH_JSON`');
    expect(body).toContain('PR: #123');
  });

  it('redacts obvious secrets from error messages', () => {
    const body = formatReviewFailureSummary(
      new Error('failed with OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz and refresh_token: secret-refresh'),
      123
    );

    expect(body).toContain('OPENAI_API_KEY=***');
    expect(body).toContain('refresh_token: ***');
    expect(body).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(body).not.toContain('secret-refresh');
  });

  it('formats no-provider failures', () => {
    const body = formatReviewFailureSummary(
      new Error('No healthy providers available; failing because FAIL_ON_NO_HEALTHY_PROVIDERS=true')
    );

    expect(body).toContain('No configured review provider passed the health check');
    expect(body).toContain('Check provider credentials and model variables');
  });
});
