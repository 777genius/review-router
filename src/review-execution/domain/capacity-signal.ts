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
const DEFINITIVE_CAPACITY_CODE =
  /^(?:429|capacity[_-]?unavailable|rate[_-]?limit(?:ed|_exceeded)?|too[_-]?many[_-]?requests|quota[_-]?(?:exceeded|exhausted|unavailable)|resource[_-]?exhausted)$/i;

interface JsonCapacityEvidence {
  readonly fields: string;
  readonly definitive: boolean;
}

function messageFromError(error: unknown): string | undefined {
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null) {
    try {
      const record = error as Record<string, unknown>;
      const serialized = JSON.stringify({
        ...record,
        ...('message' in record && typeof record.message === 'string'
          ? { message: record.message }
          : error instanceof Error
            ? { message: error.message }
            : {}),
      });
      if (serialized !== '{}') return serialized;
    } catch {
      // Fall through to an Error message when the object is cyclic.
    }
    if (error instanceof Error) return error.message;
    if ('message' in error && typeof error.message === 'string') {
      return error.message;
    }
  }
  return undefined;
}

function capacityFieldsFromJson(
  message: string
): JsonCapacityEvidence | undefined {
  const trimmed = message.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;

  try {
    const parsed: unknown = JSON.parse(trimmed);
    const evidence = collectKnownCapacityFields(parsed);
    return {
      fields: evidence.values.join(' '),
      definitive: evidence.definitive,
    };
  } catch {
    return undefined;
  }
}

function collectKnownCapacityFields(
  value: unknown,
  depth = 0
): { readonly values: string[]; readonly definitive: boolean } {
  if (depth > 2 || typeof value !== 'object' || value === null) {
    return { values: [], definitive: false };
  }
  if (Array.isArray(value)) {
    return value.reduce(
      (combined, item) => {
        const nested = collectKnownCapacityFields(item, depth + 1);
        combined.values.push(...nested.values);
        combined.definitive ||= nested.definitive;
        return combined;
      },
      { values: [] as string[], definitive: false }
    );
  }
  const record = value as Record<string, unknown>;
  const fields: string[] = [];
  let definitive = false;
  for (const key of ['error', 'status', 'message', 'code']) {
    const field = record[key];
    if (typeof field === 'string' || typeof field === 'number') {
      const normalized = String(field);
      fields.push(normalized);
      if (
        (key === 'status' || key === 'code') &&
        DEFINITIVE_CAPACITY_CODE.test(normalized)
      ) {
        definitive = true;
      }
    } else if (typeof field === 'object' && field !== null) {
      const nested = collectKnownCapacityFields(field, depth + 1);
      fields.push(...nested.values);
      definitive ||= nested.definitive;
    }
  }
  return { values: fields, definitive };
}

function hasCapacityMessage(message: string | undefined): boolean {
  if (message === undefined) return false;
  const jsonFields = capacityFieldsFromJson(message);
  if (jsonFields !== undefined) {
    return (
      jsonFields.definitive ||
      (!STRUCTURED_OUTPUT_ERROR.test(jsonFields.fields) &&
        CAPACITY_MESSAGE.test(jsonFields.fields))
    );
  }
  if (STRUCTURED_OUTPUT_ERROR.test(message)) return false;
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
