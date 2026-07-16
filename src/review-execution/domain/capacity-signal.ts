export enum CapacitySignal {
  Healthy = 'healthy',
  CapacityPressure = 'capacity_pressure',
  Neutral = 'neutral',
}

export interface ProviderResultLike {
  readonly status?: unknown;
  readonly error?: unknown;
}

const STRUCTURED_OUTPUT_ERROR =
  /\b(?:structured\s+(?:json|output|response)|(?:invalid|malformed)\s+json|json\s+(?:schema|parse|parsing|validation)|(?:parse|parsing|validate)\s+(?:structured\s+)?json|failed\s+to\s+(?:parse|validate).*json)\b/i;
const CAPACITY_MESSAGE =
  /(?:\bcapacity[\s_-]*unavailable\b|\brate[\s_-]*limit(?:ed|ing)?\b|\bratelimit(?:ed|ing)?\b|\btoo many requests\b|\b429\b|\bquota(?:[\s_-]*(?:exceeded|exhausted|unavailable))?\b)/i;

function messageFromError(error: unknown): string | undefined {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message;
  }
  return undefined;
}

function isJsonPayload(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;

  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === 'object' && parsed !== null;
  } catch {
    return false;
  }
}

function hasCapacityMessage(message: string | undefined): boolean {
  if (message === undefined) return false;
  if (STRUCTURED_OUTPUT_ERROR.test(message) || isJsonPayload(message)) {
    return false;
  }
  return CAPACITY_MESSAGE.test(message);
}

function classifyOne(result: ProviderResultLike): CapacitySignal {
  const status = typeof result.status === 'string' ? result.status : undefined;
  if (
    hasCapacityMessage(status) ||
    hasCapacityMessage(messageFromError(result.error))
  ) {
    return CapacitySignal.CapacityPressure;
  }
  if (status?.toLowerCase() === 'success') return CapacitySignal.Healthy;
  return CapacitySignal.Neutral;
}

export function classifyProviderCapacitySignal(
  result: ProviderResultLike | readonly ProviderResultLike[]
): CapacitySignal {
  const results: readonly ProviderResultLike[] = Array.isArray(result)
    ? result
    : [result];
  if (results.length === 0) return CapacitySignal.Neutral;

  const signals = results.map(classifyOne);
  if (signals.includes(CapacitySignal.CapacityPressure)) {
    return CapacitySignal.CapacityPressure;
  }
  return signals.every((signal) => signal === CapacitySignal.Healthy)
    ? CapacitySignal.Healthy
    : CapacitySignal.Neutral;
}
