import { RateLimitError } from '../../../../src/providers/base';
import {
  buildProviderReviewPromptForAttempt,
  getProviderReviewTotalAttempts,
  shouldRetryProviderReviewError,
} from '../../../../src/analysis/llm/retry-policy';

describe('LLM retry policy', () => {
  it.each([
    'Codex CLI returned invalid review JSON: response was not valid JSON',
    'OpenRouter returned invalid review JSON: expected an object with a findings array',
    'Codex CLI returned invalid review JSON: missing required file, line, severity, title, or message',
  ])('retries structured-output error: %s', (message) => {
    expect(shouldRetryProviderReviewError(new Error(message))).toBe(true);
  });

  it('does not retry timeout errors', () => {
    expect(
      shouldRetryProviderReviewError(
        new Error('Provider timed out after 600000ms')
      )
    ).toBe(false);
  });

  it('does not retry rate-limit errors', () => {
    expect(
      shouldRetryProviderReviewError(new RateLimitError('Rate limited'))
    ).toBe(false);
  });

  it.each([
    '401 Unauthorized access token could not be refreshed',
    'OpenRouter API error: 402 Payment Required',
    'OpenRouter API error: 404 Model unavailable',
    'insufficient_quota',
  ])('does not retry auth/quota/model errors: %s', (message) => {
    expect(shouldRetryProviderReviewError(new Error(message))).toBe(false);
  });

  it('treats provider retries as total attempts', () => {
    expect(getProviderReviewTotalAttempts(3)).toBe(3);
    expect(getProviderReviewTotalAttempts(0)).toBe(1);
    expect(getProviderReviewTotalAttempts(undefined)).toBe(1);
  });

  it('adds JSON-only retry instructions after the first attempt', () => {
    const prompt = buildProviderReviewPromptForAttempt(
      'base prompt',
      2,
      new Error('returned invalid review JSON')
    );

    expect(prompt).toContain(
      'previous response was rejected because it did not produce valid ReviewRouter JSON'
    );
    expect(prompt).toContain('Return ONLY one valid JSON object');
    expect(prompt).toContain('No markdown, no prose, no code fences');
    expect(prompt).toContain('{"findings":[],"revalidations":[]}');
  });
});
