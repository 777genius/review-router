import { setTimeout as delay } from "node:timers/promises";

const WAIT_MS = 120_000;
const ATTEMPTS = 24;
const CONNECTION_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
]);

export async function withNewtestAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    throw new Error("newtest_readiness_timeout");
  }
  let abort!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(new Error("newtest_readiness_timeout"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([operation, interrupted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function connectionFailure(error: unknown, signal: AbortSignal): boolean {
  if (!(error instanceof Error)) return false;
  const cause = error.cause;
  const code =
    cause && typeof cause === "object" && "code" in cause
      ? cause.code
      : undefined;
  // Redirects, TLS failures and arbitrary TypeErrors are not transient admission.
  if (typeof code === "string") return CONNECTION_CODES.has(code);
  return (
    signal.aborted &&
    (error.message === "newtest_readiness_timeout" ||
      error.name === "AbortError" ||
      error.name === "TimeoutError")
  );
}

/** Pre-provider rendezvous only. GET can persist one challenge; it must return
 * the same nonce after a lost acknowledgement, never mint another on restart.
 * A 200 response ends retries even if its body or binding is invalid. */
export async function waitForNewtestRootChallenge<T>(input: {
  runId: string;
  fetch: typeof fetch;
  read: (response: Response, signal: AbortSignal) => Promise<T>;
  monotonicNow?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}): Promise<T> {
  if (!/^[1-9][0-9]*$/.test(input.runId))
    throw new Error("newtest_readiness_identity_rejected");
  const url = new URL("https://api.reviewrouter.site/__newtest_v4/challenge");
  url.searchParams.set("runId", input.runId);
  const clock = input.monotonicNow ?? (() => performance.now());
  const sleep =
    input.wait ?? ((ms, signal) => delay(ms, undefined, { signal }));
  const started = clock();
  let last = started;
  const remaining = () => {
    const current = clock();
    if (
      !Number.isFinite(current) ||
      !Number.isFinite(started) ||
      current < last
    )
      throw new Error("newtest_readiness_clock_rejected");
    last = current;
    return WAIT_MS - (current - started);
  };
  const total = new AbortController();
  const totalTimer = setTimeout(() => total.abort(), WAIT_MS);
  try {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const left = remaining();
      if (total.signal.aborted || left <= 0) break;
      const request = new AbortController();
      const abort = () => request.abort();
      total.signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, Math.min(10_000, left));
      let response: Response | undefined;
      try {
        try {
          const fetched = input
            .fetch(url, {
              method: "GET",
              redirect: "error",
              signal: request.signal,
            })
            .then((value) => {
              if (request.signal.aborted)
                void value.body?.cancel().catch(() => undefined);
              return value;
            });
          response = await withNewtestAbort(fetched, request.signal);
        } catch (error) {
          if (total.signal.aborted || !connectionFailure(error, request.signal))
            throw error;
        }
        if (response?.status === 200) {
          return await withNewtestAbort(
            input.read(response, request.signal),
            request.signal,
          );
        }
        void response?.body?.cancel().catch(() => undefined);
        if (response && response.status !== 502 && response.status !== 503)
          throw new Error("newtest_root_response_rejected");
      } finally {
        clearTimeout(timer);
        total.signal.removeEventListener("abort", abort);
        // Aborts a late, non-cooperative fetch without retrying any body/POST.
        request.abort();
      }
      if (!total.signal.aborted && attempt + 1 < ATTEMPTS) {
        const left = remaining();
        if (left > 0)
          await withNewtestAbort(
            sleep(Math.min(5000, left), total.signal),
            total.signal,
          );
      }
    }
    throw new Error("newtest_readiness_timeout");
  } finally {
    clearTimeout(totalTimer);
  }
}
