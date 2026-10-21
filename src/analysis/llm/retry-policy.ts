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
  if (isTransientLaneSaturation(error)) {
    return true;
  }
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
  // A transient saturation retry re-runs the same prompt; the JSON retry notice
  // would falsely claim the previous response produced malformed output.
  if (previousError && isTransientLaneSaturation(previousError)) {
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

// A saturated relay lane is transient: the grant keeps its request budget and a
// later attempt can succeed once an in-flight slot frees. The closed fact
// envelope outranks textual non-retry patterns, which cannot otherwise tell
// transient saturation apart from terminal budget exhaustion.
function isTransientLaneSaturation(error: Error): boolean {
  const text = formatErrorForClassification(error);
  // Structured gateway facts decide alone when present: flattened text can
  // carry `not_dispatched` inside a message field while the envelope's effect
  // is unknown, and unknown effects must stay terminal.
  const facts = parseGatewayFactEnvelopes(text);
  return (
    facts.length > 0 &&
    facts.every(
      (fact) =>
        (fact.code === 'lane_saturated' || fact.code === 'relay_saturated') &&
        fact.effect === 'not_dispatched'
    )
  );
}

interface GatewayFactEnvelope {
  readonly code: string;
  readonly effect: string;
}

// Extract closed {"error":{code,effect}} envelopes embedded in error text by
// parsing balanced-brace candidates, so code and effect are compared as exact
// fields instead of flattened substrings.
function parseGatewayFactEnvelopes(text: string): GatewayFactEnvelope[] {
  const facts: GatewayFactEnvelope[] = [];
  for (
    let start = text.indexOf('{');
    start !== -1;
    start = text.indexOf('{', start + 1)
  ) {
    for (
      let end = text.indexOf('}', start);
      end !== -1;
      end = text.indexOf('}', end + 1)
    ) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text.slice(start, end + 1));
      } catch {
        continue;
      }
      const error: unknown = (parsed as { error?: unknown }).error;
      if (error && typeof error === 'object') {
        const code: unknown = (error as { code?: unknown }).code;
        const effect: unknown = (error as { effect?: unknown }).effect;
        if (typeof code === 'string') {
          facts.push({
            code,
            effect: typeof effect === 'string' ? effect : '',
          });
        }
      }
      break;
    }
  }
  return facts;
}

// Every lane_saturated denial is published with retry-after 1; that header is
// consumed at the gateway boundary, so executor-level saturation retries honor
// the same fixed floor instead of burning the whole attempt budget at once.
const LANE_SATURATION_RETRY_DELAY_MS = 1000;

export function providerReviewRetryDelayMs(error: Error): number {
  return isTransientLaneSaturation(error) ? LANE_SATURATION_RETRY_DELAY_MS : 0;
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
