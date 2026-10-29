import {
  parseCapturedReviewSkills,
  reviewSkillsCompanionContract,
  type CapturedReviewSkills,
} from '../control-plane/generated/review-action-v2/review-skills-contract';

/** Read-only companion, distinct from model transport and existing wire v1.
 * Authorization is resolved at call time so ordinary token renewal is safe. */
export async function fetchCapturedReviewSkills(input: {
  apiUrl: string;
  authorizationToken: string;
  baseSha: string;
  reviewerId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<CapturedReviewSkills> {
  const controller = new AbortController();
  const abort = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener('abort', abort, { once: true });
  if (input.signal?.aborted) abort();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1, Math.min(input.timeoutMs ?? 30_000, 30_000))
  );
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancelRead = () => {
    void reader?.cancel().catch(() => undefined);
  };
  controller.signal.addEventListener('abort', cancelRead);
  try {
    const response = await (input.fetchImpl ?? fetch)(
      new URL(reviewSkillsCompanionContract.path, input.apiUrl),
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${input.authorizationToken}`,
          ...(input.reviewerId
            ? { 'x-reviewrouter-reviewer-id': input.reviewerId }
            : {}),
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: '{}',
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal,
      }
    );
    if (
      !response.ok ||
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
        response.headers.get('content-type') ?? ''
      ) ||
      !response.body
    )
      throw new Error('review_skills_transport_unavailable');
    const length = response.headers.get('content-length');
    if (
      length !== null &&
      (!/^\d+$/.test(length) ||
        Number(length) > reviewSkillsCompanionContract.responseMaxBytes)
    )
      throw new Error('review_skills_response_too_large');
    reader = response.body.getReader();
    if (controller.signal.aborted) cancelRead();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > reviewSkillsCompanionContract.responseMaxBytes)
        throw new Error('review_skills_response_too_large');
      chunks.push(next.value);
    }
    controller.signal.throwIfAborted();
    let value: unknown;
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.concat(chunks)
      );
      value = JSON.parse(text) as unknown;
    } catch {
      // JSON parser diagnostics can contain body snippets. Never propagate them.
      throw new Error('review_skills_response_invalid');
    }
    const capture = parseCapturedReviewSkills(value);
    if (capture.baseSha !== input.baseSha.toLowerCase())
      throw new Error('review_skills_capture_mismatch');
    return capture;
  } finally {
    void reader?.cancel().catch(() => undefined);
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', cancelRead);
    controller.abort();
  }
}
