"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/actions/core.ts
var fs = __toESM(require("fs"));
function setOutput(name, value) {
  const output = toCommandValue(value);
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    const delimiter = `mpr_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    fs.appendFileSync(
      outputPath,
      `${name}<<${delimiter}
${output}
${delimiter}
`,
      "utf8"
    );
    return;
  }
  issueCommand("set-output", { name }, output);
}
function setSecret(secret) {
  if (!secret) {
    return;
  }
  issueCommand("add-mask", {}, secret);
}
function setFailed(message) {
  error(message);
  process.exitCode = 1;
}
function error(message) {
  issueCommand("error", {}, message);
}
function issueCommand(command, properties, message) {
  const propertyText = Object.entries(properties).map(([key, value]) => `${key}=${escapeProperty(String(value))}`).join(",");
  const separator = propertyText ? ` ${propertyText}` : "";
  console.log(
    `::${command}${separator}::${escapeData(toCommandValue(message))}`
  );
}
function toCommandValue(value) {
  if (value instanceof Error) {
    return value.message;
  }
  if (value === null || value === void 0) {
    return "";
  }
  return String(value);
}
function escapeData(value) {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}
function escapeProperty(value) {
  return escapeData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

// src/codex-oauth/github-actions-oidc.ts
var GitHubActionsOidcTokenProvider = class {
  env;
  fetchImpl;
  requestCredentials;
  constructor(options = {}) {
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }
  async requestToken(audience) {
    const { requestToken, requestUrl: requestUrlValue } = this.readRequestCredentials();
    const requestUrl = parseTrustedGitHubActionsOidcUrl(
      requestUrlValue,
      "codex_oauth_oidc_url_untrusted"
    );
    requestUrl.searchParams.set("audience", audience);
    setSecret(requestToken);
    const response = await this.fetchImpl(requestUrl.toString(), {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${requestToken}`
      },
      redirect: "error"
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        `codex_oauth_oidc_http_error:${response.status}:${safeOidcErrorCode(payload)}`
      );
    }
    const token = payload && typeof payload === "object" && "value" in payload ? payload.value : void 0;
    if (typeof token !== "string" || token.length === 0) {
      throw new Error("codex_oauth_oidc_invalid_response");
    }
    setSecret(token);
    return token;
  }
  readRequestCredentials() {
    if (this.requestCredentials) return this.requestCredentials;
    this.requestCredentials = {
      requestToken: requireEnv(this.env, "ACTIONS_ID_TOKEN_REQUEST_TOKEN"),
      requestUrl: requireEnv(this.env, "ACTIONS_ID_TOKEN_REQUEST_URL")
    };
    return this.requestCredentials;
  }
};
function parseTrustedGitHubActionsOidcUrl(value, errorCode = "github_oidc_url_untrusted") {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(errorCode);
  }
  if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(".actions.githubusercontent.com") || parsed.username !== "" || parsed.password !== "" || parsed.port !== "") {
    throw new Error(errorCode);
  }
  return parsed;
}
function requireEnv(env2, key) {
  const value = env2[key];
  if (!value) {
    throw new Error(`codex_oauth_missing_${key}`);
  }
  return value;
}
function safeOidcErrorCode(payload) {
  if (payload && typeof payload === "object" && "message" in payload && typeof payload.message === "string") {
    return "oidc_request_failed";
  }
  return "unknown_oidc_error";
}

// src/control-plane/newtest-root-rendezvous.ts
var import_promises = require("node:timers/promises");
var WAIT_MS = 12e4;
var ATTEMPTS = 24;
var CONNECTION_CODES = /* @__PURE__ */ new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT"
]);
async function withNewtestAbort(operation, signal) {
  if (signal.aborted) {
    void operation.catch(() => void 0);
    throw new Error("newtest_readiness_timeout");
  }
  let abort;
  const interrupted = new Promise((_, reject) => {
    abort = () => reject(new Error("newtest_readiness_timeout"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([operation, interrupted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
function connectionFailure(error2, signal) {
  if (!(error2 instanceof Error)) return false;
  const cause = error2.cause;
  const code = cause && typeof cause === "object" && "code" in cause ? cause.code : void 0;
  if (typeof code === "string") return CONNECTION_CODES.has(code);
  return signal.aborted && (error2.message === "newtest_readiness_timeout" || error2.name === "AbortError" || error2.name === "TimeoutError");
}
async function waitForNewtestRootChallenge(input) {
  if (!/^[1-9][0-9]*$/.test(input.runId))
    throw new Error("newtest_readiness_identity_rejected");
  const url = new URL("https://api.reviewrouter.site/__newtest_v4/challenge");
  url.searchParams.set("runId", input.runId);
  const clock = input.monotonicNow ?? (() => performance.now());
  const sleep = input.wait ?? ((ms, signal) => (0, import_promises.setTimeout)(ms, void 0, { signal }));
  const started = clock();
  let last = started;
  const remaining = () => {
    const current = clock();
    if (!Number.isFinite(current) || !Number.isFinite(started) || current < last)
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
      const timer = setTimeout(abort, Math.min(1e4, left));
      let response;
      try {
        try {
          const fetched = input.fetch(url, {
            method: "GET",
            redirect: "error",
            signal: request.signal
          }).then((value) => {
            if (request.signal.aborted)
              void value.body?.cancel().catch(() => void 0);
            return value;
          });
          response = await withNewtestAbort(fetched, request.signal);
        } catch (error2) {
          if (total.signal.aborted || !connectionFailure(error2, request.signal))
            throw error2;
        }
        if (response?.status === 200) {
          return await withNewtestAbort(
            input.read(response, request.signal),
            request.signal
          );
        }
        void response?.body?.cancel().catch(() => void 0);
        if (response && response.status !== 502 && response.status !== 503)
          throw new Error("newtest_root_response_rejected");
      } finally {
        clearTimeout(timer);
        total.signal.removeEventListener("abort", abort);
        request.abort();
      }
      if (!total.signal.aborted && attempt + 1 < ATTEMPTS) {
        const left2 = remaining();
        if (left2 > 0)
          await withNewtestAbort(
            sleep(Math.min(5e3, left2), total.signal),
            total.signal
          );
      }
    }
    throw new Error("newtest_readiness_timeout");
  } finally {
    clearTimeout(totalTimer);
  }
}

// src/control-plane/newtest-one-shot-job-transport.ts
var ROOT = "https://api.reviewrouter.site/__newtest_v4/";
var TEST_REPOSITORY = "777genius/reviewrouter-e2e-prod-20260529-000305";
var TEST_REPOSITORY_ID = "1252762369";
var SHA = /^[a-f0-9]{40}$/;
var HASH = /^[a-f0-9]{64}$/;
function validateNewtestJobIdentity(identity) {
  if (identity.repository !== TEST_REPOSITORY || identity.repositoryId !== TEST_REPOSITORY_ID || identity.headRepository !== TEST_REPOSITORY || identity.eventName !== "pull_request" || identity.runAttempt !== "1" || !/^[1-9][0-9]*$/.test(identity.runId) || !/^[1-9][0-9]*$/.test(identity.pullRequestNumber) || !SHA.test(identity.headSha) || identity.workflowRepository !== "777genius/review-router" || !SHA.test(identity.workflowSha))
    throw new Error("newtest_job_identity_rejected");
}
async function boundedJson(response, signal) {
  if (response.status !== 200 || !response.body)
    throw new Error("newtest_root_response_rejected");
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (; ; ) {
      const chunk = await (signal ? withNewtestAbort(reader.read(), signal) : reader.read());
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > 4096) throw new Error("newtest_root_response_oversized");
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    void reader.cancel().catch(() => void 0);
    reader.releaseLock();
  }
}
function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("newtest_root_response_invalid");
  return value;
}
function createNewtestJobTransport(input) {
  const identity = Object.freeze({ ...input.identity });
  validateNewtestJobIdentity(identity);
  const fetchImpl = input.fetch;
  const requestOidc = input.requestOidc;
  const now = input.now ?? Date.now;
  let consumed = false;
  return Object.freeze({
    async runOnce() {
      if (consumed) throw new Error("newtest_job_already_consumed");
      consumed = true;
      const challenge = record(
        await waitForNewtestRootChallenge({
          runId: identity.runId,
          fetch: fetchImpl,
          read: boundedJson,
          ...input.readiness
        })
      );
      if (challenge.schema !== "newtest-v4-root-challenge-v1" || challenge.repositoryId !== TEST_REPOSITORY_ID || challenge.runId !== identity.runId || challenge.sourceSha !== identity.workflowSha || challenge.headSha !== identity.headSha || typeof challenge.nonce !== "string" || !HASH.test(challenge.nonce) || typeof challenge.expiresAt !== "number" || challenge.expiresAt <= now() || challenge.expiresAt > now() + 3e5)
        throw new Error("newtest_root_challenge_rejected");
      const oidc2 = await requestOidc("reviewrouter");
      if (!oidc2 || Buffer.byteLength(oidc2) > 24576)
        throw new Error("newtest_oidc_invalid");
      if (challenge.expiresAt <= now())
        throw new Error("newtest_root_challenge_expired");
      const body = JSON.stringify({
        schema: "newtest-v4-job-request-v1",
        identity,
        nonce: challenge.nonce,
        oidc: oidc2
      });
      if (Buffer.byteLength(body) > 32768)
        throw new Error("newtest_job_request_oversized");
      const receipt = record(
        await boundedJson(
          await fetchImpl(new URL("dispatch", ROOT), {
            method: "POST",
            redirect: "error",
            headers: { "content-type": "application/json" },
            body,
            signal: AbortSignal.timeout(6e5)
          })
        )
      );
      if (receipt.schema !== "newtest-v4-root-receipt-v1" || receipt.status !== "completed" || receipt.runId !== identity.runId || receipt.sourceSha !== identity.workflowSha || typeof receipt.evidenceHash !== "string" || !HASH.test(receipt.evidenceHash))
        throw new Error("newtest_root_completion_not_proven");
      return receipt.evidenceHash;
    }
  });
}

// src/newtest-one-shot-job.ts
var env = process.env;
var oidc = new GitHubActionsOidcTokenProvider();
async function main() {
  const transport = createNewtestJobTransport({
    identity: {
      repository: env.GITHUB_REPOSITORY ?? "",
      repositoryId: env.GITHUB_REPOSITORY_ID ?? "",
      headRepository: env.RR_HEAD_REPOSITORY ?? "",
      eventName: env.GITHUB_EVENT_NAME ?? "",
      runId: env.GITHUB_RUN_ID ?? "",
      runAttempt: env.GITHUB_RUN_ATTEMPT ?? "",
      headSha: env.RR_HEAD_SHA ?? "",
      pullRequestNumber: env.RR_PR_NUMBER ?? "",
      workflowRepository: env.RR_WORKFLOW_REPOSITORY ?? "",
      workflowSha: env.RR_WORKFLOW_SHA ?? ""
    },
    fetch,
    requestOidc: (audience) => oidc.requestToken(audience)
  });
  const evidenceHash = await transport.runOnce();
  setOutput("newtest_evidence_hash", evidenceHash);
}
void main().catch(() => {
  setFailed(
    "One-shot TEST transport failed; no automatic retry or ordinary review fallback."
  );
});
