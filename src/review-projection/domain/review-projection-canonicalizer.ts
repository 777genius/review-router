import { createHash } from 'crypto';

import { ReviewProjectionEnvelopeV1 } from './review-projection';

export function canonicalizeReviewProjection(
  envelope: ReviewProjectionEnvelopeV1
): string {
  return JSON.stringify(toCanonicalValue(envelope));
}

export function hashReviewProjectionCanonicalJson(
  canonicalJson: string
): string {
  return createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
}

export function hashProjectionFact(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(toCanonicalValue(value)), 'utf8')
    .digest('hex');
}

export function deepFreezeProjection<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreezeProjection(child);
  }
  return Object.freeze(value);
}

function toCanonicalValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error('review projection contains a non-finite number');
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(toCanonicalValue);
  }

  const canonical: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== undefined) {
      canonical[key] = toCanonicalValue(child);
    }
  }
  return canonical;
}
