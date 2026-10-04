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
async function boundedJson(response) {
  if (response.status !== 200 || !response.body)
    throw new Error("newtest_root_response_rejected");
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (; ; ) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > 4096) throw new Error("newtest_root_response_oversized");
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => void 0);
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
      const challengeUrl = new URL("challenge", ROOT);
      challengeUrl.searchParams.set("runId", identity.runId);
      const challenge = record(
        await boundedJson(
          await fetchImpl(challengeUrl, {
            method: "GET",
            redirect: "error",
            signal: AbortSignal.timeout(1e4)
          })
        )
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
