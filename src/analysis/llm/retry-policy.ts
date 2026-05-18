import { RateLimitError } from '../../providers/base';

const STRUCTURED_OUTPUT_RETRY_PATTERNS = [
  'returned invalid review json',
  'response was not valid json',
  'expected an object with a findings array',
  'missing required file, line, severity, title, or message',
];

const NON_RETRY_PATTERNS = [
  'timed out',
  'timeout',
  'ratelimiterror',
  'rate limit',
  'rate_limit',
  'rate-limited',
  'rate limited',
  '401',
  '402',
  '403',
  '429',
  'unauthorized',
  'forbidden',
  'authentication',
  'auth error',
  'oauth',
  'api key',
  'invalid secret',
  'quota',
  'quota_exceeded',
  'insufficient_quota',
  'payment required',
  'model unavailable',
  'model not available',
  'model_not_found',
  'not found',
  'does not exist',
  'unsupported model',
];

export function getProviderReviewTotalAttempts(
  configuredAttempts: number | undefined
): number {
  if (!Number.isFinite(configuredAttempts)) {
    return 1;
  }
  return Math.max(1, Math.floor(configuredAttempts ?? 1));
}

export function shouldRetryProviderReviewError(error: Error): boolean {
  if (error instanceof RateLimitError || error.name === 'RateLimitError') {
    return false;
  }

  const text = formatErrorForClassification(error).toLowerCase();
  if (NON_RETRY_PATTERNS.some((pattern) => text.includes(pattern))) {
    return false;
  }

  return STRUCTURED_OUTPUT_RETRY_PATTERNS.some((pattern) =>
    text.includes(pattern)
  );
}

export function buildProviderReviewPromptForAttempt(
  basePrompt: string,
  attempt: number,
  previousError?: Error
): string {
  if (attempt <= 1) {
    return basePrompt;
  }

  const reason = previousError
    ? ` Reason: ${sanitizeRetryReason(previousError.message)}`
    : '';

  return [
    basePrompt,
    '',
    'JSON OUTPUT RETRY NOTICE:',
    `Attempt ${attempt}: the previous response was rejected because it did not produce valid ReviewRouter JSON.${reason}`,
    'Return ONLY one valid JSON object matching the required schema.',
    'No markdown, no prose, no code fences, comments, trailing commas, or text before/after the JSON.',
    'If no findings, return exactly {"findings":[],"revalidations":[]}.',
  ].join('\n');
}

function formatErrorForClassification(error: Error): string {
  const errorWithCode = error as Error & { code?: string | number };
  return [error.name, errorWithCode.code, error.message]
    .filter(Boolean)
    .join(' ');
}

function sanitizeRetryReason(message: string): string {
  return message
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-[redacted]')
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, 'gh[redacted]')
    .replace(/refresh[_-]?token[=:]\S+/gi, 'refresh_token=[redacted]')
    .slice(0, 240);
}
