import { createHash } from 'crypto';
import type { ReviewResult } from '../../types';
import type { ReviewObservationPayload } from '../application';

export function normalizeReviewObservation(input: {
  readonly workSlotId: string;
  readonly attemptOrdinal: number;
  readonly providerName: string;
  readonly requestedModel: string;
  readonly result: ReviewResult;
  readonly transportAttemptCount?: number;
}): ReviewObservationPayload {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(input.workSlotId)) {
    throw new Error('review_observation_work_slot_id_invalid');
  }
  if (!Number.isSafeInteger(input.attemptOrdinal) || input.attemptOrdinal < 1) {
    throw new Error('review_observation_attempt_ordinal_invalid');
  }
  const transportAttemptCount =
    input.transportAttemptCount ?? input.result.transportAttemptCount ?? 1;
  if (
    !Number.isSafeInteger(transportAttemptCount) ||
    transportAttemptCount < 1
  ) {
    throw new Error('review_observation_transport_attempt_count_invalid');
  }
  const findings = (input.result.findings ?? []).map((finding) => ({
    category: finding.category ?? 'correctness',
    confidence: finiteConfidence(finding.confidence),
    endLine: finiteLine(finding.endLine),
    file: finding.file,
    line: finiteLine(finding.line),
    message: finding.message,
    severity: finding.severity,
    startLine: finiteLine(finding.startLine),
    suggestion: finding.suggestion ?? null,
    title: finding.title,
  }));
  const revalidations = (input.result.revalidations ?? []).map((item) => ({
    confidence: finiteConfidence(item.confidence),
    fingerprint: item.fingerprint ?? null,
    rationale: item.rationale ?? null,
    targetId: item.targetId,
    verdict: item.verdict,
  }));
  const payloadCanonicalJson = canonicalJson({
    attemptOrdinal: input.attemptOrdinal,
    findings,
    observationVersion: 'review_observation.v1',
    providerName: input.providerName,
    requestedModel: input.requestedModel,
    revalidations,
    workSlotId: input.workSlotId,
  });
  return Object.freeze({
    payloadCanonicalJson,
    payloadHash: createHash('sha256')
      .update(payloadCanonicalJson)
      .digest('hex'),
    byteCount: Buffer.byteLength(payloadCanonicalJson, 'utf8'),
    findingCount: findings.length,
    actualModel: input.result.actualModel ?? input.requestedModel,
    qualityFlags: Object.freeze([]),
    transportAttemptCount,
    schemaValidated: true,
    fullyConsumed: true,
  });
}

function finiteLine(value: number | undefined): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0
    ? (value as number)
    : null;
}

function finiteConfidence(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
