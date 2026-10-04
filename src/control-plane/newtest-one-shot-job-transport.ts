/** Finite TEST125 transport only. This module never plans or invokes a provider.
 * The root must independently verify signed OIDC claims and exclusively claim
 * its durable operation before native authorization. Local checks are not that
 * authority. No caller-selected URL, redirects, retries or legacy fallback. */
const ROOT = 'https://api.reviewrouter.site/__newtest_v4/';
const TEST_REPOSITORY = '777genius/reviewrouter-e2e-prod-20260529-000305';
const TEST_REPOSITORY_ID = '1252762369';
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;

export type NewtestJobIdentity = Readonly<{
  repository: string;
  repositoryId: string;
  headRepository: string;
  eventName: string;
  runId: string;
  runAttempt: string;
  headSha: string;
  pullRequestNumber: string;
  workflowRepository: string;
  workflowSha: string;
}>;

export function validateNewtestJobIdentity(identity: NewtestJobIdentity): void {
  if (
    identity.repository !== TEST_REPOSITORY ||
    identity.repositoryId !== TEST_REPOSITORY_ID ||
    identity.headRepository !== TEST_REPOSITORY ||
    identity.eventName !== 'pull_request' ||
    identity.runAttempt !== '1' ||
    !/^[1-9][0-9]*$/.test(identity.runId) ||
    !/^[1-9][0-9]*$/.test(identity.pullRequestNumber) ||
    !SHA.test(identity.headSha) ||
    identity.workflowRepository !== '777genius/review-router' ||
    !SHA.test(identity.workflowSha)
  )
    throw new Error('newtest_job_identity_rejected');
}

async function boundedJson(response: Response): Promise<unknown> {
  if (response.status !== 200 || !response.body)
    throw new Error('newtest_root_response_rejected');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > 4096) throw new Error('newtest_root_response_oversized');
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('newtest_root_response_invalid');
  return value as Record<string, unknown>;
}

export function createNewtestJobTransport(input: {
  identity: NewtestJobIdentity;
  fetch: typeof fetch;
  requestOidc: (audience: string) => Promise<string>;
  now?: () => number;
}) {
  const identity = Object.freeze({ ...input.identity });
  validateNewtestJobIdentity(identity);
  const fetchImpl = input.fetch;
  const requestOidc = input.requestOidc;
  const now = input.now ?? Date.now;
  let consumed = false;
  return Object.freeze({
    async runOnce(): Promise<string> {
      if (consumed) throw new Error('newtest_job_already_consumed');
      consumed = true; // Sticky even after preflight/unknown POST failure.
      const challengeUrl = new URL('challenge', ROOT);
      challengeUrl.searchParams.set('runId', identity.runId);
      const challenge = record(
        await boundedJson(
          await fetchImpl(challengeUrl, {
            method: 'GET',
            redirect: 'error',
            signal: AbortSignal.timeout(10_000),
          })
        )
      );
      if (
        challenge.schema !== 'newtest-v4-root-challenge-v1' ||
        challenge.repositoryId !== TEST_REPOSITORY_ID ||
        challenge.runId !== identity.runId ||
        challenge.sourceSha !== identity.workflowSha ||
        challenge.headSha !== identity.headSha ||
        typeof challenge.nonce !== 'string' ||
        !HASH.test(challenge.nonce) ||
        typeof challenge.expiresAt !== 'number' ||
        challenge.expiresAt <= now() ||
        challenge.expiresAt > now() + 300_000
      )
        throw new Error('newtest_root_challenge_rejected');
      const oidc = await requestOidc('reviewrouter');
      if (!oidc || Buffer.byteLength(oidc) > 24_576)
        throw new Error('newtest_oidc_invalid');
      if (challenge.expiresAt <= now())
        throw new Error('newtest_root_challenge_expired');
      const body = JSON.stringify({
        schema: 'newtest-v4-job-request-v1',
        identity,
        nonce: challenge.nonce,
        oidc,
      });
      if (Buffer.byteLength(body) > 32_768)
        throw new Error('newtest_job_request_oversized');
      const receipt = record(
        await boundedJson(
          await fetchImpl(new URL('dispatch', ROOT), {
            method: 'POST',
            redirect: 'error',
            headers: { 'content-type': 'application/json' },
            body,
            signal: AbortSignal.timeout(600_000),
          })
        )
      );
      if (
        receipt.schema !== 'newtest-v4-root-receipt-v1' ||
        receipt.status !== 'completed' ||
        receipt.runId !== identity.runId ||
        receipt.sourceSha !== identity.workflowSha ||
        typeof receipt.evidenceHash !== 'string' ||
        !HASH.test(receipt.evidenceHash)
      )
        throw new Error('newtest_root_completion_not_proven');
      // Receipt locator only. The trusted root's native effect/debit/artifact/
      // publication evidence, not this transport response, establishes E2E.
      return receipt.evidenceHash;
    },
  });
}
