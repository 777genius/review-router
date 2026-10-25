import {
  AcceptedRevalidation,
  PacketValidation,
  PreparedPacket,
  RevalidationEvidence,
} from './contracts';
import { byteHash, REVALIDATION_LIMITS } from './packet';

const invalid = (): PacketValidation => ({
  valid: false,
  reason: 'missing_or_invalid_verdict',
});
function exactRecord(
  value: unknown,
  keys: readonly string[]
): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function boundedText(value: unknown, max = 2048): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= max;
}

/** Atomic packet acceptance: malformed or missing siblings cannot manufacture quorum. */
export function validateLifecycleResponse(
  bytes: Uint8Array,
  prepared: PreparedPacket,
  actualModel: string,
  requestHash: string,
  maxResponseBytes = REVALIDATION_LIMITS.responseBytes
): PacketValidation {
  if (
    bytes.byteLength >
      Math.min(maxResponseBytes, REVALIDATION_LIMITS.responseBytes) ||
    actualModel !== prepared.packet.participant.model ||
    requestHash !== prepared.requestHash ||
    byteHash(prepared.requestBytes) !== prepared.requestHash
  )
    return invalid();
  let output: unknown;
  try {
    output = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    );
  } catch {
    return invalid();
  }
  if (
    !exactRecord(output, ['version', 'packetHash', 'results']) ||
    output.version !== 1 ||
    output.packetHash !== prepared.packet.packetHash ||
    !Array.isArray(output.results) ||
    output.results.length !== prepared.packet.targets.length
  )
    return invalid();
  const known = new Map(
    prepared.packet.targets.map((target) => [target.witness.targetId, target])
  );
  const seen = new Set<string>();
  const results: AcceptedRevalidation[] = [];
  for (const raw of output.results) {
    if (
      !exactRecord(raw, [
        'targetId',
        'fingerprint',
        'verdict',
        'confidence',
        'scopeSufficient',
        'failureCondition',
        'fixExplanation',
        'evidence',
      ]) ||
      typeof raw.targetId !== 'string' ||
      seen.has(raw.targetId)
    )
      return invalid();
    const target = known.get(raw.targetId);
    if (
      !target ||
      raw.fingerprint !== target.witness.fingerprint ||
      typeof raw.verdict !== 'string' ||
      !['resolved', 'still_valid', 'uncertain'].includes(raw.verdict) ||
      typeof raw.confidence !== 'number' ||
      !Number.isFinite(raw.confidence) ||
      raw.confidence < 0 ||
      raw.confidence > 1 ||
      typeof raw.scopeSufficient !== 'boolean' ||
      !boundedText(raw.failureCondition) ||
      !boundedText(raw.fixExplanation) ||
      !Array.isArray(raw.evidence) ||
      raw.evidence.length > 6
    )
      return invalid();
    seen.add(raw.targetId);
    const evidence: RevalidationEvidence[] = [];
    for (const citation of raw.evidence) {
      if (
        !exactRecord(citation, [
          'path',
          'blobOid',
          'startLine',
          'endLine',
          'quote',
          'reason',
        ]) ||
        typeof citation.path !== 'string' ||
        typeof citation.blobOid !== 'string' ||
        !Number.isInteger(citation.startLine) ||
        !Number.isInteger(citation.endLine) ||
        !boundedText(citation.quote, 4096) ||
        !citation.quote.trim() ||
        !boundedText(citation.reason) ||
        !citation.reason.trim()
      )
        return invalid();
      const source = prepared.packet.sources.find(
        (source) =>
          source.path === citation.path &&
          source.blobOid === citation.blobOid &&
          source.headSha === prepared.packet.scope.headSha
      );
      const start = citation.startLine as number;
      const end = citation.endLine as number;
      if (
        !source ||
        start < 1 ||
        end < start ||
        end > source.lineCount ||
        !source.content
          .split('\n')
          .slice(start - 1, end)
          .join('\n')
          .includes(citation.quote)
      )
        return invalid();
      evidence.push(citation as RevalidationEvidence);
    }
    const verdict = raw.verdict as AcceptedRevalidation['verdict'];
    if (
      verdict !== 'uncertain' &&
      (!evidence.length ||
        !raw.failureCondition.trim() ||
        !raw.fixExplanation.trim())
    )
      return invalid();
    if (
      verdict === 'uncertain' &&
      !raw.fixExplanation.trim() &&
      !raw.failureCondition.trim()
    )
      return invalid();
    // Insufficient scope or confidence is abstention, never a positive fix.
    const acceptedVerdict =
      verdict === 'resolved' &&
      (!raw.scopeSufficient ||
        raw.confidence <
          prepared.packet.resolveConfidenceThresholds[target.witness.severity])
        ? 'uncertain'
        : verdict;
    results.push({
      targetId: raw.targetId,
      fingerprint: raw.fingerprint as string,
      verdict: acceptedVerdict,
      confidence: raw.confidence,
      scopeSufficient: raw.scopeSufficient,
      failureCondition: raw.failureCondition,
      fixExplanation: raw.fixExplanation,
      evidence,
    });
  }
  return { valid: true, results };
}
