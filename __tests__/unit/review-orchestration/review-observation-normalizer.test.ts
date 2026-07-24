import { createHash } from 'crypto';
import { normalizeReviewObservation } from '../../../src/review-orchestration/infrastructure';

describe('normalizeReviewObservation', () => {
  it('produces a bounded canonical payload without raw provider prose', () => {
    const observation = normalizeReviewObservation({
      workSlotId: 'slot-1',
      attemptOrdinal: 1,
      providerName: 'codex/gpt-5.3-codex',
      requestedModel: 'gpt-5.3-codex',
      result: {
        content: 'raw provider output must not be persisted',
        actualModel: 'gpt-5.3-codex',
        transportAttemptCount: 2,
        findings: [
          {
            file: 'src/index.ts',
            line: 12,
            severity: 'major',
            title: 'Broken branch',
            message: 'The new branch returns the wrong value.',
            confidence: 0.9,
          },
        ],
        revalidations: [],
      },
    });

    expect(observation.payloadCanonicalJson).not.toContain(
      'raw provider output'
    );
    expect(observation.findingCount).toBe(1);
    expect(observation.transportAttemptCount).toBe(2);
    expect(observation.payloadHash).toBe(
      createHash('sha256')
        .update(observation.payloadCanonicalJson)
        .digest('hex')
    );
    expect(observation.byteCount).toBe(
      Buffer.byteLength(observation.payloadCanonicalJson, 'utf8')
    );
    expect(JSON.stringify(JSON.parse(observation.payloadCanonicalJson))).toBe(
      observation.payloadCanonicalJson
    );
  });

  it('redacts secret-like provider text before hashing the canonical payload', () => {
    const observation = normalizeReviewObservation({
      workSlotId: 'slot-1',
      attemptOrdinal: 1,
      providerName: 'codex/gpt-5.3-codex',
      requestedModel: 'gpt-5.3-codex',
      result: {
        content: 'ignored raw output',
        findings: [
          {
            file: 'src/index.ts',
            line: 12,
            severity: 'major',
            title: 'Bearer abcdefghijklmnop',
            message: 'api_key=super-secret-value',
            suggestion: 'token: should-not-persist',
            evidence: {
              badge: 'confidence',
              confidence: 0.8,
              reasoning:
                'jwt eyJaaaaaaaa.eyJbbbbbbbb.cccccccccc should be redacted',
            },
          },
        ],
        revalidations: [
          {
            targetId: 'thread-1',
            verdict: 'resolved',
            rationale: 'password=hidden-value',
            evidence: [
              {
                path: 'src/index.ts',
                startLine: 12,
                endLine: 12,
                reason: 'secret: redacted-value',
              },
            ],
          },
        ],
      },
    });

    expect(observation.payloadCanonicalJson).toContain('Bearer [REDACTED]');
    expect(observation.payloadCanonicalJson).toContain('api_key=[REDACTED]');
    expect(observation.payloadCanonicalJson).toContain('token:[REDACTED]');
    expect(observation.payloadCanonicalJson).toContain('[REDACTED_JWT]');
    expect(observation.payloadCanonicalJson).not.toContain(
      'super-secret-value'
    );
    expect(observation.payloadCanonicalJson).not.toContain('hidden-value');
    expect(observation.payloadHash).toBe(
      createHash('sha256')
        .update(observation.payloadCanonicalJson)
        .digest('hex')
    );
  });
});
