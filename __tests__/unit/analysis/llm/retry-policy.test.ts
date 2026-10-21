import { RateLimitError } from '../../../../src/providers/base';
import {
  buildProviderReviewPromptForAttempt,
  getProviderReviewTotalAttempts,
  providerReviewRetryDelayMs,
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

  it('retries transient lane saturation carrying the gateway fact', () => {
    expect(
      shouldRetryProviderReviewError(
        new Error(
          'Codex CLI failed with exit code 1: upstream 503 {"error":{"code":"lane_saturated","effect":"not_dispatched"}}'
        )
      )
    ).toBe(true);
  });

  it('retries a forwarded relay saturation envelope only when it proves not_dispatched', () => {
    expect(
      shouldRetryProviderReviewError(
        new Error(
          'upstream 503 {"error":{"code":"relay_saturated","effect":"not_dispatched"}}'
        )
      )
    ).toBe(true);
    expect(
      shouldRetryProviderReviewError(
        new Error(
          'upstream 503 {"error":{"code":"relay_saturated","effect":"effect_unknown"}}'
        )
      )
    ).toBe(false);
    expect(
      shouldRetryProviderReviewError(
        new Error(
          'upstream 503 {"error":{"code":"admission_limited","effect":"not_dispatched"}}'
        )
      )
    ).toBe(false);
  });

  it('waits the gateway retry-after floor before transient saturation retries', () => {
    expect(
      providerReviewRetryDelayMs(
        new Error(
          'upstream 503 {"error":{"code":"lane_saturated","effect":"not_dispatched"}}'
        )
      )
    ).toBe(1000);
    expect(
      providerReviewRetryDelayMs(new Error('returned invalid review JSON'))
    ).toBe(0);
  });

  it('keeps a forwarded unknown-effect envelope terminal even when its message mentions not_dispatched', () => {
    expect(
      shouldRetryProviderReviewError(
        new Error(
          'upstream 503 {"error":{"code":"relay_saturated","effect":"effect_unknown","message":"admission not_dispatched marker"}}'
        )
      )
    ).toBe(false);
    expect(
      shouldRetryProviderReviewError(
        new Error(
          'upstream 503 {"error":{"code":"lane_saturated","effect":"effect_unknown","message":"not_dispatched"}}'
        )
      )
    ).toBe(false);
  });

  it('keeps terminal budget exhaustion non-retryable', () => {
    expect(
      shouldRetryProviderReviewError(
        new Error(
          'upstream 429 {"error":{"code":"budget_exhausted","effect":"not_dispatched"}}'
        )
      )
    ).toBe(false);
  });

  it('omits the JSON retry notice for transient saturation retries', () => {
    const prompt = buildProviderReviewPromptForAttempt(
      'base prompt',
      2,
      new Error(
        'upstream 503 {"error":{"code":"lane_saturated","effect":"not_dispatched"}}'
      )
    );

    expect(prompt).toBe('base prompt');
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
