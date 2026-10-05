import {
  createNewtestJobTransport,
  type NewtestJobIdentity,
} from "../../../src/control-plane/newtest-one-shot-job-transport";

const identity: NewtestJobIdentity = {
  repository: "777genius/reviewrouter-e2e-prod-20260529-000305",
  repositoryId: "1252762369",
  headRepository: "777genius/reviewrouter-e2e-prod-20260529-000305",
  eventName: "pull_request",
  runId: "123",
  runAttempt: "1",
  headSha: "a".repeat(40),
  pullRequestNumber: "4",
  workflowRepository: "777genius/review-router",
  workflowSha: "b".repeat(40),
};
const challenge = {
  schema: "newtest-v4-root-challenge-v1",
  repositoryId: identity.repositoryId,
  runId: identity.runId,
  sourceSha: identity.workflowSha,
  headSha: identity.headSha,
  nonce: "c".repeat(64),
  expiresAt: 2000,
};
const receipt = {
  schema: "newtest-v4-root-receipt-v1",
  status: "completed",
  runId: identity.runId,
  sourceSha: identity.workflowSha,
  evidenceHash: "d".repeat(64),
};
const response = (value: unknown) =>
  new Response(JSON.stringify(value), { status: 200 });

describe("finite TEST job transport", () => {
  function readinessClock() {
    let elapsed = 0;
    return {
      monotonicNow: () => elapsed,
      wait: async (ms: number) => {
        elapsed += ms;
      },
    };
  }

  it("waits through unavailable root without OIDC, then sends exactly one POST", async () => {
    const discarded = jest.fn();
    const unavailable = new Response(
      new ReadableStream({ cancel: discarded }),
      { status: 503 },
    );
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(unavailable)
      .mockRejectedValueOnce(
        new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }),
      )
      .mockResolvedValueOnce(response(challenge))
      .mockResolvedValueOnce(response(receipt));
    const requestOidc = jest.fn().mockResolvedValue("synthetic");
    const transport = createNewtestJobTransport({
      identity,
      fetch: fetchImpl,
      requestOidc,
      now: () => 1000,
      readiness: readinessClock(),
    });
    await expect(transport.runOnce()).resolves.toBe(receipt.evidenceHash);
    expect(discarded).toHaveBeenCalledTimes(1);
    expect(requestOidc).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls.map((call) => call[1].method)).toEqual([
      "GET",
      "GET",
      "GET",
      "POST",
    ]);
    expect(
      fetchImpl.mock.calls.every((call) => call[1].redirect === "error"),
    ).toBe(true);
    await expect(transport.runOnce()).rejects.toThrow("already_consumed");
  });

  it.each([
    "CERT_HAS_EXPIRED",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "UND_ERR_INVALID_ARG",
  ])("does not classify %s as readiness", async (code) => {
    const fetchImpl = jest
      .fn()
      .mockRejectedValue(new TypeError("fetch failed", { cause: { code } }));
    const requestOidc = jest.fn();
    await expect(
      createNewtestJobTransport({
        identity,
        fetch: fetchImpl,
        requestOidc,
        readiness: readinessClock(),
      }).runOnce(),
    ).rejects.toThrow("fetch failed");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(requestOidc).not.toHaveBeenCalled();
  });

  it.each([301, 401, 403, 404, 429, 500])(
    "does not retry HTTP %s",
    async (status) => {
      const fetchImpl = jest
        .fn()
        .mockResolvedValue(new Response("", { status }));
      const requestOidc = jest.fn();
      await expect(
        createNewtestJobTransport({
          identity,
          fetch: fetchImpl,
          requestOidc,
          readiness: readinessClock(),
        }).runOnce(),
      ).rejects.toThrow("response_rejected");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(requestOidc).not.toHaveBeenCalled();
    },
  );

  it("ends retries on malformed 200 without waiting or requesting OIDC", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response("{"));
    const requestOidc = jest.fn();
    const wait = jest.fn();
    await expect(
      createNewtestJobTransport({
        identity,
        fetch: fetchImpl,
        requestOidc,
        readiness: { monotonicNow: () => 0, wait },
      }).runOnce(),
    ).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
    expect(requestOidc).not.toHaveBeenCalled();
  });

  it("limits unavailable attempts despite wall-clock rollback, and remains consumed", async () => {
    let wallClock = 1000;
    const fetchImpl = jest.fn().mockImplementation(async () => {
      wallClock -= 100000;
      return new Response("", { status: 502 });
    });
    const requestOidc = jest.fn();
    const transport = createNewtestJobTransport({
      identity,
      fetch: fetchImpl,
      requestOidc,
      now: () => wallClock,
      readiness: readinessClock(),
    });
    await expect(transport.runOnce()).rejects.toThrow("readiness_timeout");
    expect(fetchImpl).toHaveBeenCalledTimes(24);
    expect(requestOidc).not.toHaveBeenCalled();
    await expect(transport.runOnce()).rejects.toThrow("already_consumed");
  });

  it("rejects a backwards monotonic clock rather than extending readiness", async () => {
    let clock = 10;
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(new Response("", { status: 503 }));
    const requestOidc = jest.fn();
    await expect(
      createNewtestJobTransport({
        identity,
        fetch: fetchImpl,
        requestOidc,
        readiness: {
          monotonicNow: () => clock,
          wait: async () => {
            clock = 9;
          },
        },
      }).runOnce(),
    ).rejects.toThrow("clock_rejected");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(requestOidc).not.toHaveBeenCalled();
  });

  it("bounds a non-cooperative hanging GET by the absolute readiness deadline", async () => {
    jest.useFakeTimers();
    try {
      const started = Date.now();
      const fetchImpl = jest.fn(() => new Promise<Response>(() => undefined));
      const requestOidc = jest.fn();
      const operation = createNewtestJobTransport({
        identity,
        fetch: fetchImpl,
        requestOidc,
        readiness: { monotonicNow: () => Date.now() - started },
      }).runOnce();
      const rejected = expect(operation).rejects.toThrow("readiness_timeout");
      await jest.advanceTimersByTimeAsync(120001);
      await rejected;
      expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(12);
      expect(requestOidc).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it("bounds a hanging 200 body, cancels it and never retries or requests OIDC", async () => {
    jest.useFakeTimers();
    try {
      const cancelled = jest.fn();
      const fetchImpl = jest
        .fn()
        .mockResolvedValue(
          new Response(new ReadableStream({ cancel: cancelled })),
        );
      const requestOidc = jest.fn();
      const operation = createNewtestJobTransport({
        identity,
        fetch: fetchImpl,
        requestOidc,
      }).runOnce();
      const rejected = expect(operation).rejects.toThrow("readiness_timeout");
      await jest.advanceTimersByTimeAsync(10001);
      await rejected;
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(cancelled).toHaveBeenCalledTimes(1);
      expect(requestOidc).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it("does not retry OIDC failure or send POST after it", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response(challenge));
    const requestOidc = jest
      .fn()
      .mockRejectedValue(new Error("synthetic OIDC failure"));
    const transport = createNewtestJobTransport({
      identity,
      fetch: fetchImpl,
      requestOidc,
      now: () => 1000,
      readiness: readinessClock(),
    });
    await expect(transport.runOnce()).rejects.toThrow("synthetic OIDC failure");
    await expect(transport.runOnce()).rejects.toThrow("already_consumed");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(requestOidc).toHaveBeenCalledTimes(1);
  });

  it.each([
    { repositoryId: "999" },
    { headRepository: "foreign/fork" },
    { eventName: "workflow_dispatch" },
    { runAttempt: "2" },
    { workflowSha: "main" },
    { workflowRepository: "foreign/runtime" },
  ])("rejects wrong authority before any HTTP: %j", (change) => {
    const fetchImpl = jest.fn();
    expect(() =>
      createNewtestJobTransport({
        identity: { ...identity, ...change },
        fetch: fetchImpl,
        requestOidc: jest.fn(),
      }),
    ).toThrow("identity_rejected");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not request OIDC or POST when fresh root/head binding fails", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(response({ ...challenge, headSha: "e".repeat(40) }));
    const requestOidc = jest.fn();
    const transport = createNewtestJobTransport({
      identity,
      fetch: fetchImpl,
      requestOidc,
      now: () => 1000,
    });
    await expect(transport.runOnce()).rejects.toThrow("challenge_rejected");
    expect(requestOidc).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(transport.runOnce()).rejects.toThrow("already_consumed");
  });

  it("transfers once with redirects forbidden and exposes only the evidence locator", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(response(challenge))
      .mockResolvedValueOnce(response(receipt));
    const requestOidc = jest.fn().mockResolvedValue("synthetic-test-oidc");
    const transport = createNewtestJobTransport({
      identity,
      fetch: fetchImpl,
      requestOidc,
      now: () => 1000,
    });
    await expect(transport.runOnce()).resolves.toBe(receipt.evidenceHash);
    expect(requestOidc).toHaveBeenCalledWith("reviewrouter");
    expect(fetchImpl.mock.calls[1][0].toString()).toBe(
      "https://api.reviewrouter.site/__newtest_v4/dispatch",
    );
    expect(fetchImpl.mock.calls[1][1]).toMatchObject({
      method: "POST",
      redirect: "error",
    });
    const body = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(body).toEqual({
      schema: "newtest-v4-job-request-v1",
      identity,
      nonce: challenge.nonce,
      oidc: "synthetic-test-oidc",
    });
    await expect(transport.runOnce()).rejects.toThrow("already_consumed");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("burns transport after ambiguous dispatch without retry", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(response(challenge))
      .mockRejectedValueOnce(new Error("connection lost"));
    const transport = createNewtestJobTransport({
      identity,
      fetch: fetchImpl,
      requestOidc: async () => "synthetic",
      now: () => 1000,
    });
    await expect(transport.runOnce()).rejects.toThrow("connection lost");
    await expect(transport.runOnce()).rejects.toThrow("already_consumed");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects oversized root input before requesting OIDC", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(new Response("x".repeat(4097)));
    const requestOidc = jest.fn();
    await expect(
      createNewtestJobTransport({
        identity,
        fetch: fetchImpl,
        requestOidc,
        now: () => 1000,
      }).runOnce(),
    ).rejects.toThrow("oversized");
    expect(requestOidc).not.toHaveBeenCalled();
  });
});
