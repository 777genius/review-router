import { createHash } from 'crypto';
import type {
  Finding,
  ProviderLifecycleRevalidation,
  ReviewResult,
} from '../../types';
import type { ReviewObservationPayload } from '../application';

const reviewEvidencePayloadVersion = 2;

export function normalizeReviewObservation(input: {
  readonly workSlotId: string;
  readonly attemptOrdinal: number;
  readonly providerName: string;
  readonly requestedModel: string;
  readonly result: ReviewResult;
  readonly transportAttemptCount?: number;
  readonly qualityFlags?: readonly string[];
  readonly contextDependencyAttestation?: Readonly<{
    attestationId: string;
    attestationHash: string;
  }>;
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

  const payload = {
    normalizedFindings: (input.result.findings ?? []).map(normalizeFinding),
    normalizedLifecycleRevalidations: (input.result.revalidations ?? []).map(
      normalizeRevalidation
    ),
    payloadVersion: reviewEvidencePayloadVersion,
    safeUsage: normalizeUsage(input.result),
  } as const;
  const payloadCanonicalJson = canonicalJson(payload);
  const qualityFlags = Object.freeze(
    [...(input.qualityFlags ?? [])].map((flag) => {
      if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(flag)) {
        throw new Error('review_observation_quality_flag_invalid');
      }
      return flag;
    })
  );
  const contextDependencyAttestation = input.contextDependencyAttestation;
  if (
    contextDependencyAttestation &&
    (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(
      contextDependencyAttestation.attestationId
    ) ||
      !/^[a-f0-9]{64}$/u.test(contextDependencyAttestation.attestationHash))
  ) {
    throw new Error('review_observation_context_attestation_invalid');
  }

  return Object.freeze({
    payloadCanonicalJson,
    payloadHash: sha256(payloadCanonicalJson),
    byteCount: Buffer.byteLength(payloadCanonicalJson, 'utf8'),
    findingCount: payload.normalizedFindings.length,
    actualModel: input.result.actualModel ?? input.requestedModel,
    qualityFlags,
    transportAttemptCount,
    schemaValidated: true,
    fullyConsumed: true,
    ...(contextDependencyAttestation
      ? {
          contextDependencyAttestationId:
            contextDependencyAttestation.attestationId,
          contextDependencyAttestationHash:
            contextDependencyAttestation.attestationHash,
        }
      : {}),
  });
}

function normalizeFinding(finding: Finding) {
  const category = finding.category ?? 'correctness';
  const startLine = finiteLine(finding.startLine ?? finding.line);
  const endLine = finiteLine(finding.endLine ?? finding.line);
  const evidence =
    typeof finding.evidence?.reasoning === 'string' &&
    finding.evidence.reasoning.length > 0
      ? [redactSensitiveText(finding.evidence.reasoning)]
      : [];
  const title = redactSensitiveText(finding.title);
  const message = redactSensitiveText(finding.message);
  const suggestion =
    typeof finding.suggestion === 'string'
      ? redactSensitiveText(finding.suggestion)
      : null;
  return {
    category,
    endLine,
    evidence,
    message,
    normalizedFailureModeHash: sha256(
      canonicalJson({
        category: normalizeText(category),
        message: normalizeText(message),
        title: normalizeText(title),
      })
    ),
    path: finding.file,
    placementConfidence: finiteConfidence(finding.confidence),
    severity: finding.severity,
    startLine,
    suggestion,
    title,
  } as const;
}

function normalizeRevalidation(item: ProviderLifecycleRevalidation) {
  return {
    confidence: finiteConfidence(item.confidence),
    evidence: (item.evidence ?? []).map((evidence) => {
      const startLine = finiteLine(evidence.startLine ?? evidence.endLine);
      const endLine = finiteLine(evidence.endLine ?? evidence.startLine);
      return {
        endLine,
        path: evidence.path,
        reason: redactSensitiveText(evidence.reason),
        startLine,
      };
    }),
    fingerprint: item.fingerprint ?? null,
    rationale:
      typeof item.rationale === 'string'
        ? redactSensitiveText(item.rationale)
        : null,
    targetId: item.targetId,
    verdict: item.verdict,
  } as const;
}

function normalizeUsage(result: ReviewResult) {
  const inputTokens = finiteTokenCount(result.usage?.promptTokens);
  const outputTokens = finiteTokenCount(result.usage?.completionTokens);
  const reportedTotal = finiteTokenCount(result.usage?.totalTokens);
  const totalTokens =
    inputTokens !== null && outputTokens !== null
      ? inputTokens + outputTokens
      : reportedTotal;
  return { inputTokens, outputTokens, totalTokens } as const;
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

function finiteTokenCount(value: number | undefined): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : null;
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
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

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function redactSensitiveText(value: string): string {
  return value
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
      '[REDACTED_PRIVATE_KEY]'
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu, 'Bearer [REDACTED]')
    .replace(
      /\b(?:token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]{4,}/giu,
      (match) =>
        `${match.slice(0, Math.max(0, match.search(/[:=]/u) + 1))}[REDACTED]`
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
      '[REDACTED_JWT]'
    );
}
